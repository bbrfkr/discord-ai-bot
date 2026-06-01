import type { Client } from "discord.js";
import type {
  OpencodeEvent,
  PermissionRequest,
  PermissionResponse,
  QuestionInfo,
  QuestionRequest,
  ThreadAgent,
} from "../threadAgent.js";

/**
 * スレッドで保留中の対話。返信を応答へ変換するのに必要な分だけ保持する。
 * opencode には prompt をブロックする対話ゲートが 2 種類ある:
 *  - permission: tool 実行の許可（承認/拒否）
 *  - question:   ユーザへの選択式/自由入力の質問
 */
type Pending =
  | {
      type: "permission";
      sessionId: string;
      permissionID: string;
      /** 操作種別（bash / edit など）。表示用。 */
      kind: string;
      /** 対象の説明（bash ならコマンド文字列など）。表示用。 */
      detail: string;
    }
  | {
      type: "question";
      sessionId: string;
      requestID: string;
      questions: QuestionInfo[];
    };

/** 返信の処理結果。handled:true なら通常メッセージとして AI へ転送しない。 */
type ReplyResult = { handled: false } | { handled: true; message: string };

/**
 * opencode の対話ゲート（permission / question）と Discord を橋渡しする。
 *
 * 背景: AgentService.ask() は許可待ち・質問待ちに当たると prompt の HTTP 応答が返らず
 * ブロックする。クライアント（この bot）が応答しない限りセッションは止まり、呼び出し元へ
 * 何も返らない。本クラスは独立した SSE ストリーム（events）で要求を受け取り、対応スレッドへ
 * 通知し、ユーザの返信を応答へ変換してサーバへ返すことでブロックを解除する。解除後は元の
 * ask() が答えを返してスレッドへ投稿される（その経路は既存のまま）。
 */
export class InteractionGate {
  private readonly agent: ThreadAgent;
  /** threadId -> 保留中の対話。thread↔session は 1:1 なので 1 スレッド 1 件で足りる。 */
  private readonly pending = new Map<string, Pending>();

  constructor(agent: ThreadAgent) {
    this.agent = agent;
  }

  /** このスレッドに保留中の対話があるか。 */
  hasPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /**
   * スレッドへの返信を保留中の対話への応答として解釈する。
   * 保留が無ければ { handled: false }（＝通常メッセージとして処理させる）。
   * 保留がある間は、解釈できない返信でも handled:true を返して通常プロンプト化を防ぐ
   *（元の ask が進行中のため、同一セッションへ二重に prompt しないこと）。
   */
  async handleReply(threadId: string, content: string): Promise<ReplyResult> {
    const p = this.pending.get(threadId);
    if (!p) return { handled: false };
    return p.type === "permission"
      ? this.handlePermissionReply(threadId, p, content)
      : this.handleQuestionReply(threadId, p, content);
  }

  // ── permission ──────────────────────────────────────────────

  private async handlePermissionReply(
    threadId: string,
    p: Extract<Pending, { type: "permission" }>,
    content: string,
  ): Promise<ReplyResult> {
    const response = parsePermissionCommand(content);
    if (!response) {
      return {
        handled: true,
        message:
          `⏳ 「${p.kind}」の許可を待っています。\n` +
          "返信で承認/拒否してください（`承認` / `常に許可` / `拒否`）。",
      };
    }

    // 二重応答を避けるため、応答前に保留を確定的に取り除く。
    this.pending.delete(threadId);
    try {
      await this.agent.respondPermission(p.sessionId, p.permissionID, response);
    } catch (err) {
      console.error("[interaction] permission respond failed:", err);
      return { handled: true, message: expiredMessage() };
    }
    return { handled: true, message: permissionAck(response, p.kind) };
  }

  // ── question ────────────────────────────────────────────────

  private async handleQuestionReply(
    threadId: string,
    p: Extract<Pending, { type: "question" }>,
    content: string,
  ): Promise<ReplyResult> {
    if (isRejectWord(content)) {
      this.pending.delete(threadId);
      try {
        await this.agent.rejectQuestion(p.requestID);
      } catch (err) {
        console.error("[interaction] question reject failed:", err);
        return { handled: true, message: expiredMessage() };
      }
      return { handled: true, message: "🚫 質問への回答を取り消しました。" };
    }

    const answers = parseAnswers(p.questions, content);
    if (!answers) {
      return {
        handled: true,
        message:
          "⏳ 質問への回答を待っています。\n" + formatQuestions(p.questions),
      };
    }

    this.pending.delete(threadId);
    try {
      await this.agent.replyQuestion(p.requestID, answers);
    } catch (err) {
      console.error("[interaction] question reply failed:", err);
      return { handled: true, message: expiredMessage() };
    }
    const flat = answers.map((a) => a.join(", ")).join(" / ");
    return { handled: true, message: `✅ 回答を送信しました（${flat}）。処理を続けます…` };
  }

  // ── イベント処理 ─────────────────────────────────────────────

  /**
   * イベントを種別ごとに捌く。購読ループは bot 側の単一ディスパッチャが持ち、
   * 受け取った各イベントをこのメソッドへ渡す（SSE 接続を許可/質問・進捗で共有するため）。
   */
  async handleEvent(discord: Client, ev: OpencodeEvent): Promise<void> {
    if (ev.type === "permission.asked") {
      await this.onPermission(discord, ev.properties as unknown as PermissionRequest);
      return;
    }
    if (ev.type === "question.asked") {
      await this.onQuestion(discord, ev.properties as unknown as QuestionRequest);
      return;
    }
    // セッションがアイドルに戻ったら、未応答のまま失効した保留を掃除する
    //（タイムアウト/切断後に通常メッセージが保留で詰まり続けるのを防ぐ）。
    if (ev.type === "session.idle") {
      const sessionID = ev.properties?.sessionID;
      if (typeof sessionID === "string") this.clearBySession(sessionID);
    }
  }

  private async onPermission(
    discord: Client,
    req: PermissionRequest,
  ): Promise<void> {
    if (!req?.id || !req.sessionID) return;
    const threadId = await this.agent.findThreadBySession(req.sessionID);
    if (!threadId) return; // スレッドに紐づかないセッション（CLI 等）は通知先が無い。

    const detail = (req.patterns ?? []).join("\n").trim();
    this.pending.set(threadId, {
      type: "permission",
      sessionId: req.sessionID,
      permissionID: req.id,
      kind: req.permission,
      detail,
    });
    await this.notify(discord, threadId, formatPermission(req.permission, detail));
  }

  private async onQuestion(
    discord: Client,
    req: QuestionRequest,
  ): Promise<void> {
    if (!req?.id || !req.sessionID || !req.questions?.length) return;
    const threadId = await this.agent.findThreadBySession(req.sessionID);
    if (!threadId) return;

    this.pending.set(threadId, {
      type: "question",
      sessionId: req.sessionID,
      requestID: req.id,
      questions: req.questions,
    });
    await this.notify(
      discord,
      threadId,
      "❓ **回答が必要です**\n" + formatQuestions(req.questions),
    );
  }

  /** 指定セッションに紐づく保留を取り除く（アイドル復帰時の掃除用）。 */
  private clearBySession(sessionID: string): void {
    for (const [threadId, p] of this.pending) {
      if (p.sessionId === sessionID) this.pending.delete(threadId);
    }
  }

  /** スレッドへメッセージを送る（送信不能なチャンネルは黙って無視）。 */
  private async notify(
    discord: Client,
    threadId: string,
    message: string,
  ): Promise<void> {
    const channel = await discord.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send(message);
  }
}

// ── permission: パース/整形 ───────────────────────────────────

/** 返信文字列を許可応答へ変換する（判定できなければ undefined）。 */
function parsePermissionCommand(
  content: string,
): PermissionResponse | undefined {
  const t = content.trim().toLowerCase();
  if (/^(常に許可|常に承認|always)$/.test(t)) return "always";
  if (/^(承認|許可|approve|allow|ok|yes|y|はい)$/.test(t)) return "once";
  if (/^(拒否|却下|deny|reject|no|n|いいえ)$/.test(t)) return "reject";
  return undefined;
}

/** 許可要求をスレッドへ提示する本文。 */
function formatPermission(kind: string, detail: string): string {
  const body = detail ? `\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`\n` : "\n";
  return (
    `🔐 **許可が必要です**: \`${kind}\`${body}` +
    "返信で承認/拒否してください：\n" +
    "• `承認` … 今回だけ許可\n" +
    "• `常に許可` … 以後この種別は自動許可\n" +
    "• `拒否` … 実行しない"
  );
}

/** 許可応答後にスレッドへ返す確認文。 */
function permissionAck(response: PermissionResponse, kind: string): string {
  switch (response) {
    case "once":
      return `✅ 「${kind}」を許可しました。処理を続けます…`;
    case "always":
      return `✅ 「${kind}」を以後も許可します。処理を続けます…`;
    case "reject":
      return `🚫 「${kind}」を拒否しました。`;
  }
}

// ── question: パース/整形 ─────────────────────────────────────

/** 取り消し語か。 */
function isRejectWord(content: string): boolean {
  return /^(拒否|却下|キャンセル|取消|取り消し|reject|cancel)$/.test(
    content.trim().toLowerCase(),
  );
}

/**
 * 返信を回答配列（質問順に、各回答は選択ラベルの配列）へ変換する。
 * 解釈できなければ null（呼び出し側で再掲する）。
 * - 質問が 1 件: 返信全体をその質問の回答とする（自由入力の改行も保てる）。
 * - 質問が複数: 1 行 1 件で順に対応づける（行数が一致しないと null）。
 */
function parseAnswers(
  questions: QuestionInfo[],
  content: string,
): string[][] | null {
  if (questions.length === 1) {
    const a = resolveAnswer(questions[0]!, content.trim());
    return a ? [a] : null;
  }

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== questions.length) return null;

  const answers: string[][] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = resolveAnswer(questions[i]!, lines[i]!);
    if (!a) return null;
    answers.push(a);
  }
  return answers;
}

/** 1 つの質問に対する返信を、選択ラベルの配列へ解決する（不正なら null）。 */
function resolveAnswer(q: QuestionInfo, raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // まず選択肢の選択として解釈を試みる（番号 or ラベル一致）。
  const tokens = q.multiple ? trimmed.split(/[\s,、＋+]+/).filter(Boolean) : [trimmed];
  const labels = tokens.map((t) => matchOption(q, t));
  if (labels.every((l): l is string => l !== undefined)) {
    // 単一選択なのに複数指定された場合は不正扱い（custom があれば下でフォールバック）。
    if (!q.multiple && labels.length === 1) return labels;
    if (q.multiple) return labels;
  }

  // 選択肢に解決できなければ、自由入力が許されていれば返信全体を回答とする。
  if (q.custom) return [trimmed];
  return null;
}

/** 番号（1始まり）または選択肢ラベル（大小無視）を、正規のラベルへ解決する。 */
function matchOption(q: QuestionInfo, token: string): string | undefined {
  const t = token.trim();
  if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    return q.options[idx]?.label;
  }
  const hit = q.options.find(
    (o) => o.label.toLowerCase() === t.toLowerCase(),
  );
  return hit?.label;
}

/** 質問群をスレッドへ提示する本文（番号付き選択肢）。 */
function formatQuestions(questions: QuestionInfo[]): string {
  const multi = questions.length > 1;
  const blocks = questions.map((q, qi) => {
    const head = multi ? `**${qi + 1}. ${q.header}**` : `**${q.header}**`;
    const opts = q.options
      .map((o, oi) => `  ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
      .join("\n");
    const notes: string[] = [];
    if (q.multiple) notes.push("複数選択可（番号を空白/カンマ区切り）");
    if (q.custom) notes.push("自由入力可");
    const note = notes.length ? `\n  （${notes.join(" / ")}）` : "";
    return `${head}\n${q.question}\n${opts}${note}`;
  });

  const howto = multi
    ? "返信は **各行に1件ずつ**、番号またはラベルで回答してください。"
    : "返信で **番号またはラベル** を送ってください。";
  return `${blocks.join("\n\n")}\n\n${howto}\n取り消すには \`拒否\` と返信。`;
}

/** 応答送信に失敗したとき（失効/再起動で要求が無効化）の共通文面。 */
function expiredMessage(): string {
  return (
    "⚠️ 応答の送信に失敗しました（要求が失効した可能性があります）。" +
    "必要ならもう一度指示し直してください。"
  );
}
