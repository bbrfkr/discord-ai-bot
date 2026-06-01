import type { Client } from "discord.js";
import type { OpencodeEvent, ThreadAgent } from "../threadAgent.js";

/**
 * opencode のツール実行・TODO 進捗を Discord スレッドへ逐次反映する。
 *
 * 背景: AgentService.ask() は完了するまで何も返さないため、長い作業中は Discord 側が
 * 「入力中…」のまま無音になり、ユーザに進捗が見えない。本クラスは InteractionGate と同様に
 * 独立した SSE ストリーム（events）を購読し、AI が「今なにをしているか」を表す中間イベントを
 * 拾ってスレッドへ投稿する。応答をブロックする InteractionGate（許可/質問）とは別関心なので
 * クラスを分け、購読も別接続にしている（opencode サーバは全 SSE クライアントへブロードキャストする）。
 */
export class ProgressReporter {
  private readonly agent: ThreadAgent;
  /** sessionID -> 既に通知済みの callID 集合（同一ツールを状態遷移ごとに二重投稿しないため）。 */
  private readonly announced = new Map<string, Set<string>>();
  /** sessionID -> 直近に投稿した TODO 要約キー（変化したときだけ投稿するため）。 */
  private readonly lastTodoKey = new Map<string, string>();

  constructor(agent: ThreadAgent) {
    this.agent = agent;
  }

  // ── イベント処理 ─────────────────────────────────────────────

  /**
   * イベントを種別ごとに捌く。購読ループは bot 側の単一ディスパッチャが持ち、
   * 受け取った各イベントをこのメソッドへ渡す（SSE 接続を許可/質問・進捗で共有するため）。
   */
  async handleEvent(discord: Client, ev: OpencodeEvent): Promise<void> {
    // 進捗系イベントの型名は SDK 生成型と実体がズレている可能性があるため、
    // メッセージパート更新・TODO 更新は名前ゆらぎを吸収して拾う。
    if (isPartUpdated(ev.type)) {
      await this.onPart(discord, ev.properties as PartUpdatedProps);
      return;
    }
    if (isTodoUpdated(ev.type)) {
      await this.onTodo(discord, ev.properties as TodoUpdatedProps);
      return;
    }
    // セッションが終わったら、そのセッションぶんの通知状態を破棄する（メモリ肥大防止）。
    if (ev.type === "session.idle") {
      const sessionID = ev.properties?.sessionID;
      if (typeof sessionID === "string") {
        this.announced.delete(sessionID);
        this.lastTodoKey.delete(sessionID);
      }
    }
  }

  // ── ツール実行 ───────────────────────────────────────────────

  private async onPart(
    discord: Client,
    props: PartUpdatedProps,
  ): Promise<void> {
    // 実体は SDK 生成型とズレうるため、part は properties.part でも properties 直下でも拾う。
    const part = (props?.part ?? props) as
      | ({ type?: string } & Partial<ToolPart>)
      | undefined;
    if (DEBUG) {
      console.log(
        `[progress] part: type=${part?.type} tool=${part?.tool} status=${part?.state?.status}`,
      );
    }
    if (!part || part.type !== "tool") return;
    const status = part.state?.status;
    // 「今なにをしているか」を示すのが目的なので running を基本に拾う。
    // running を取りこぼした高速ツールのために completed も初回だけ拾う。
    if (status !== "running" && status !== "completed") return;

    const sessionID = part.sessionID ?? part.sessionId;
    const callID = part.callID ?? part.id;
    if (!sessionID || !callID) return;

    // 同一ツールは一度だけ通知する（pending→running→completed の各更新で再投稿しない）。
    let seen = this.announced.get(sessionID);
    if (!seen) {
      seen = new Set();
      this.announced.set(sessionID, seen);
    }
    if (seen.has(callID)) return;
    seen.add(callID);

    const threadId = await this.agent.findThreadBySession(sessionID);
    if (!threadId) return; // スレッドに紐づかないセッション（CLI 等）は通知先が無い。

    await this.notify(discord, threadId, describeTool(part as ToolPart));
  }

  // ── TODO 進捗 ────────────────────────────────────────────────

  private async onTodo(
    discord: Client,
    props: TodoUpdatedProps,
  ): Promise<void> {
    const sessionID = props?.sessionID ?? props?.sessionId;
    const todos = props?.todos;
    if (!sessionID || !Array.isArray(todos) || todos.length === 0) return;

    const { key, text } = summarizeTodos(todos);
    // 完了数や着手中の項目が変わったときだけ投稿する（同じ内容での連投を防ぐ）。
    if (this.lastTodoKey.get(sessionID) === key) return;
    this.lastTodoKey.set(sessionID, key);

    const threadId = await this.agent.findThreadBySession(sessionID);
    if (!threadId) return;

    await this.notify(discord, threadId, text);
  }

  /** スレッドへメッセージを送る（送信不能なチャンネルは黙って無視）。 */
  private async notify(
    discord: Client,
    threadId: string,
    message: string,
  ): Promise<void> {
    const channel = await discord.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send(message).catch(() => {});
  }
}

/** 進捗ログを有効化する（PROGRESS_DEBUG=1）。実体のイベント形状を確認する用。 */
const DEBUG = process.env.PROGRESS_DEBUG === "1";

/** message.part.updated 相当のイベント型名か（SDK と実体のゆらぎを吸収）。 */
function isPartUpdated(type: string): boolean {
  return type === "message.part.updated" || type === "message.part.created";
}

/** todo.updated 相当のイベント型名か。 */
function isTodoUpdated(type: string): boolean {
  return type === "todo.updated";
}

// ── イベント payload の最小形（SDK 生成型に頼らず実体に寄せて緩く扱う） ─────

interface ToolPart {
  type: "tool";
  id: string;
  sessionID: string;
  /** 実体が camelCase の場合のフォールバック。 */
  sessionId?: string;
  callID?: string;
  tool: string;
  state?: {
    status: string;
    title?: string;
    input?: Record<string, unknown>;
  };
}

interface PartUpdatedProps {
  part?: { type: string } & Partial<ToolPart>;
}

interface TodoItem {
  content: string;
  status: string;
}

interface TodoUpdatedProps {
  sessionID?: string;
  sessionId?: string;
  todos?: TodoItem[];
}

// ── 整形 ─────────────────────────────────────────────────────

/** ツール実行を「今なにをしているか」の一行に整形する。 */
function describeTool(part: ToolPart): string {
  const input = part.state?.input ?? {};
  const title = part.state?.title?.trim();

  // opencode が用意した人間向けタイトルがあれば最優先で使う。
  switch (part.tool) {
    case "bash": {
      const cmd = str(input.command) ?? title;
      return `🔧 コマンドを実行中: ${code(cmd) ?? "(bash)"}`;
    }
    case "edit":
      return `✏️ 編集中: ${code(target(input) ?? title) ?? "(edit)"}`;
    case "write":
      return `📝 作成中: ${code(target(input) ?? title) ?? "(write)"}`;
    case "read":
      return `📖 読み込み中: ${code(target(input) ?? title) ?? "(read)"}`;
    case "grep":
      return `🔍 検索中: ${code(str(input.pattern) ?? title) ?? "(grep)"}`;
    case "glob":
      return `🔍 ファイル探索中: ${code(str(input.pattern) ?? title) ?? "(glob)"}`;
    case "list":
      return `📂 一覧取得中: ${code(str(input.path) ?? title) ?? "(list)"}`;
    case "webfetch":
      return `🌐 取得中: ${code(str(input.url) ?? title) ?? "(webfetch)"}`;
    case "task":
      return `🤖 サブタスク実行中: ${str(input.description) ?? title ?? ""}`.trimEnd();
    default:
      return title
        ? `🔧 ${part.tool}: ${title}`
        : `🔧 ${part.tool} を実行中`;
  }
}

/** ファイル系ツールの対象パスを input から取り出す。 */
function target(input: Record<string, unknown>): string | undefined {
  return str(input.filePath) ?? str(input.filename) ?? str(input.path);
}

/** TODO 群を「2/5 完了 — 🔄 着手中の項目」の一行と、変化検知用のキーへ。 */
function summarizeTodos(todos: TodoItem[]): { key: string; text: string } {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos
    .filter((t) => t.status === "in_progress")
    .map((t) => t.content.trim())
    .filter(Boolean);
  const key = `${done}/${total}|${current.join("|")}`;
  const tail = current.length ? ` — 🔄 ${current.join(" / ")}` : "";
  return { key, text: `📋 進捗 ${done}/${total} 完了${tail}` };
}

/** 値が空でない文字列ならトリムして返す（それ以外は undefined）。 */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Discord 用にインラインコード化する（長すぎる場合は切り詰める）。 */
function code(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const oneLine = v.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 180 ? `${oneLine.slice(0, 177)}…` : oneLine;
  return `\`${clipped}\``;
}
