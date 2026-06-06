import { createOpencodeClient } from "@opencode-ai/sdk";
import { Agent } from "undici";

/**
 * 接続先 base URL を解決する。引数 > 環境変数 OPENCODE_BASE_URL > 既定値(127.0.0.1:4096) の優先順。
 * 末尾スラッシュは取り除く（後段の `${base}/path` 連結のため）。
 */
export function resolveBaseUrl(baseUrl?: string): string {
  const url =
    baseUrl ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  return url.replace(/\/+$/, "");
}

/** 既定のリクエストタイムアウト（ms）。60分。AI ターンがこれを超えたら失敗させる安全網。 */
const DEFAULT_TIMEOUT_MS = 3_600_000;

/**
 * リクエストタイムアウト（ms）を解決する。OPENCODE_REQUEST_TIMEOUT_MS で上書き可能。
 * 0 は「無制限」（undici では 0 でタイムアウト無効）。負値・非数なら既定値にフォールバック。
 */
function resolveTimeoutMs(): number {
  const raw = process.env.OPENCODE_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * opencode への HTTP リクエスト用 undici dispatcher。
 *
 * session.prompt() は AI ターン完了までブロックする1本の長い POST で、undici の既定
 * headersTimeout/bodyTimeout（各5分）に達するとサーバ処理継続中でも UND_ERR_HEADERS_TIMEOUT で
 * 切れてしまう。そこでヘッダ/ボディのタイムアウトを延長した dispatcher を使う。
 * 接続プール再利用のためモジュールスコープで1個だけ生成して使い回す。
 */
const timeoutMs = resolveTimeoutMs();
const dispatcher = new Agent({
  headersTimeout: timeoutMs,
  bodyTimeout: timeoutMs,
});

/**
 * opencode serve が待ち受けている HTTP サーバへ接続する SDK クライアントを生成する。
 *
 * SDK は config.fetch 未指定時のみ自前 fetch（req.timeout=false の no-op）を挿すため、
 * 独自 fetch を渡して上記 dispatcher を必ず適用する。
 */
export function createClient(baseUrl?: string) {
  return createOpencodeClient({
    baseUrl: resolveBaseUrl(baseUrl),
    fetch: ((req: Request) =>
      fetch(req, { dispatcher } as RequestInit & {
        dispatcher: Agent;
      })) as typeof fetch,
  });
}

export type OpencodeClient = ReturnType<typeof createClient>;
