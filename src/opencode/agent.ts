import {
  createClient,
  resolveBaseUrl,
  type OpencodeClient,
} from "./client.js";

/** prompt 時に指定するモデル（providerID / modelID）。未指定ならサーバ既定。 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** ask に渡す添付ファイル（Discord 非依存の素のデータ）。 */
export interface AttachmentInput {
  /** ダウンロード元 URL（例: Discord CDN URL）。 */
  url: string;
  /** content-type。不明時はフォールバック値（例: application/octet-stream）。 */
  mime: string;
  filename?: string;
}

/** permission への応答。once=今回だけ許可 / always=以後同種も許可 / reject=拒否。 */
export type PermissionResponse = "once" | "always" | "reject";

/**
 * opencode が tool 実行の許可待ちで送ってくるイベント（type: "permission.asked"）。
 *
 * 注意: @opencode-ai/sdk の生成型は別名（permission.updated / Permission）になっているが、
 * サーバ実体（opencode serve）がワイヤに流す実際の type は "permission.asked"、payload は
 * 下記 PermissionRequest 形状である（バイナリ検証済み）。SDK の型に頼らず実体に合わせて扱う。
 */
export interface PermissionRequest {
  /** per_… 形式。応答時の permissionID として使う。 */
  id: string;
  /** ses_… 形式。どのセッション（=スレッド）の許可要求か。 */
  sessionID: string;
  /** 要求された操作の種別（"bash" / "edit" / "webfetch" など）。 */
  permission: string;
  /** 対象パターン（bash ならコマンド文字列など）。 */
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

/**
 * サーバが SSE で流すイベントの最小形（type と任意の properties）。
 * SDK の生成型は実体とずれている箇所があるため、型に頼らず実体に合わせて緩く扱う。
 */
export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** 質問の選択肢。 */
export interface QuestionOption {
  label: string;
  description: string;
}

/** 単一の質問。 */
export interface QuestionInfo {
  question: string;
  /** 短いラベル（30 文字以内）。 */
  header: string;
  options: QuestionOption[];
  /** 複数選択可か。 */
  multiple?: boolean;
  /** 選択肢以外の自由入力を許すか。 */
  custom?: boolean;
}

/**
 * opencode が agent からユーザへ質問する際に送るイベント（type: "question.asked"）。
 *
 * 注意: permission と異なり @opencode-ai/sdk には question 用の型もメソッドも存在しない。
 * イベントは SSE 生 JSON としてそのまま流れてくるので type 文字列で判定し、応答は
 * 生 fetch（replyQuestion / rejectQuestion）で /question/{id}/reply・/reject を叩く。
 */
export interface QuestionRequest {
  /** que_… 形式。応答時の requestID として使う。 */
  id: string;
  /** ses_… 形式。どのセッション（=スレッド）の質問か。 */
  sessionID: string;
  questions: QuestionInfo[];
}

export interface AgentServiceOptions {
  /** 接続先。未指定なら env / 既定値。 */
  baseUrl?: string;
  /** 使用モデル。未指定なら env(OPENCODE_PROVIDER_ID/OPENCODE_MODEL_ID)、それも無ければサーバ既定。 */
  model?: ModelRef;
}

/**
 * opencode の AI agent に作業を依頼する中核サービス。
 *
 * Discord 非依存。将来 Discord bot 化する際は「スレッドID → セッションID」の
 * マッピング層をこの上に被せ、スレッドごとに createSession して同じ sessionId で
 * ask を呼び続ければ会話を継続できる。
 */
export class AgentService {
  private readonly client: OpencodeClient;
  private readonly model?: ModelRef;
  /** SDK が未提供のエンドポイント（question 応答）を生 fetch で叩くための接続先。 */
  private readonly baseUrl: string;

  constructor(options: AgentServiceOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.client = createClient(options.baseUrl);
    this.model = options.model ?? resolveModelFromEnv();
  }

  /** 新しいセッションを作成し、その ID を返す。 */
  async createSession(title?: string): Promise<string> {
    const res = await this.client.session.create({
      body: title ? { title } : {},
    });
    const session = unwrap(res);
    return session.id;
  }

  /**
   * 指定セッションにプロンプトを送り、完了まで待って応答テキストを返す（同期）。
   * 同じ sessionId を渡し続ければ会話コンテキストが継続する。
   */
  async ask(
    sessionId: string,
    text: string,
    attachments: AttachmentInput[] = [],
  ): Promise<string> {
    // 添付を 2 種類に分ける:
    //   - inline: モデル（LLM）が file part として直接受け取れる mime（既定 image/*）。
    //     従来どおりダウンロードして base64 data URL 化し file part で渡す。
    //   - passthrough: それ以外（model/stl 等のバイナリ）。file part にすると AI SDK が
    //     `file part media type ... functionality not supported` で弾く（モデル非対応 mime のため、
    //     n8n に届く前に opencode 側で失敗する）。opencode に中身を触らせず、署名付き URL を
    //     本文に添えて agent（gdrive スキルの curl 等）が直接ダウンロード・処理できるようにする。
    const inline = attachments.filter((a) => isModelViewableMime(a.mime));
    const passthrough = attachments.filter((a) => !isModelViewableMime(a.mime));

    const fileParts = await Promise.all(
      inline.map(async (a) => ({
        type: "file" as const,
        mime: a.mime,
        ...(a.filename ? { filename: a.filename } : {}),
        url: await toDataUrl(a.url, a.mime),
      })),
    );
    const composedText = passthrough.length
      ? [text.trim(), formatPassthroughNote(passthrough)]
          .filter(Boolean)
          .join("\n\n")
      : text;
    const parts = [
      ...(composedText.trim()
        ? [{ type: "text" as const, text: composedText }]
        : []),
      ...fileParts,
    ];

    const res = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(this.model ? { model: this.model } : {}),
        parts,
      },
    });

    const result = unwrap(res);
    return extractText(result.parts);
  }

  /** 設定中のモデル（未設定時は undefined = サーバ既定）。ログ表示用。 */
  get currentModel(): ModelRef | undefined {
    return this.model;
  }

  /**
   * サーバのイベントストリーム（SSE: GET /event）を購読し、各イベントを yield する。
   *
   * ask() は permission ゲートに当たると prompt の HTTP 応答が返らずブロックするため、
   * 許可要求（permission.asked）はこの独立したストリームで受け取り、respondPermission() で
   * 応答して解除する。ストリームが切れたら呼び出し側で再購読する想定（1接続ぶんを流すだけ）。
   */
  async *events(): AsyncGenerator<OpencodeEvent> {
    const res = await this.client.event.subscribe();
    for await (const event of res.stream) {
      // SDK の型は実体とずれているため unknown 経由で実体形状に寄せる。
      const ev = event as unknown as OpencodeEvent;
      if (ev && typeof ev.type === "string") yield ev;
    }
  }

  /** 保留中の permission に応答する（許可/拒否）。 */
  async respondPermission(
    sessionId: string,
    permissionID: string,
    response: PermissionResponse,
  ): Promise<void> {
    const res = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID },
      body: { response },
    });
    unwrap(res);
  }

  /**
   * 保留中の質問に回答する。answers は質問順に、各要素が「選択したラベル（自由入力時はその文字列）」の配列。
   * SDK 未提供のため生 fetch で /question/{requestID}/reply を叩く。
   */
  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    await this.postJson(`/question/${requestID}/reply`, { answers });
  }

  /** 保留中の質問を取り消す（SDK 未提供のため生 fetch）。 */
  async rejectQuestion(requestID: string): Promise<void> {
    await this.postJson(`/question/${requestID}/reject`, {});
  }

  /** baseUrl 配下へ JSON を POST し、非 2xx は本文付きで投げる。 */
  private async postJson(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode API error (${res.status} ${path}): ${text}`);
    }
  }
}

function resolveModelFromEnv(): ModelRef | undefined {
  const providerID = process.env.OPENCODE_PROVIDER_ID;
  const modelID = process.env.OPENCODE_MODEL_ID;
  if (providerID && modelID) return { providerID, modelID };
  return undefined;
}

/**
 * SDK は responseStyle 既定が "fields" のため、応答は { data, error, ... } 形式で返る。
 * data を取り出しつつ error があれば投げる。
 */
function unwrap<T>(res: { data?: T; error?: unknown }): T {
  if (res.error) {
    throw new Error(`opencode API error: ${JSON.stringify(res.error)}`);
  }
  if (res.data === undefined) {
    throw new Error("opencode API returned no data");
  }
  return res.data;
}

/**
 * モデル（LLM）が file part として直接受け取れる mime か。
 * 既定は image/* のみ。多くのプロバイダ／@ai-sdk/openai-compatible は file part で画像しか扱えず、
 * それ以外（model/stl・audio/* 等）は `file part media type ... functionality not supported` を投げるため、
 * 既定では画像だけをインライン添付する。OPENCODE_INLINE_MIME_PREFIXES（カンマ区切り、
 * 例 "image/,application/pdf"）で対象 prefix を上書きできる。
 */
function isModelViewableMime(mime: string): boolean {
  const prefixes = (process.env.OPENCODE_INLINE_MIME_PREFIXES ?? "image/")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const m = mime.toLowerCase();
  return prefixes.some((p) => m.startsWith(p));
}

/**
 * モデルに見せない添付（バイナリ等）を、agent がダウンロード・処理できるよう
 * 署名付き URL 付きで本文に列挙する。opencode はこれらの中身に一切触れない。
 * URL にはクエリ（Discord の署名 ex/is/hm）が含まれるため、curl 時は必ず "" で囲むよう明記する。
 */
function formatPassthroughNote(items: AttachmentInput[]): string {
  const lines = items.map((a) => {
    const name = a.filename ?? "(no name)";
    return `- ${name} (${a.mime}): ${a.url}`;
  });
  return [
    "[添付ファイル — モデルには未添付。中身が必要なら下記 URL からダウンロードして処理してください",
    "（URL は署名付きでクエリを含み、~24時間で失効。curl 等で取得する際は URL を必ずダブルクォートで囲むこと）]",
    ...lines,
  ].join("\n");
}

/** URL からファイルを取得し、base64 の data URL に変換する。 */
async function toDataUrl(url: string, mime: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`添付ファイルの取得に失敗しました: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** message parts から text タイプを連結して取り出す。 */
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}
