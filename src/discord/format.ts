/** Discord の1メッセージ上限（2000文字）。 */
export const DISCORD_MAX_MESSAGE = 2000;

/**
 * 長文を Discord の文字数上限以内のチャンクに分割する。
 * できるだけ改行で区切り、1行が長すぎる場合は強制的に切る。
 */
export function splitForDiscord(
  text: string,
  limit = DISCORD_MAX_MESSAGE,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  for (const line of trimmed.split("\n")) {
    // 1行が上限を超える場合は、その行を limit ごとに分割。
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * 添付候補として扱う URL のパターン（環境変数 ATTACH_URL_PATTERN で上書き可）。
 * 既定は ComfyUI の取得 URL（`/view?...`）または `comfyui-*` ホスト。
 * AI 応答に現れたこのパターンの URL は、テキストではなく Discord 添付として送る。
 */
const ATTACH_URL_PATTERN = new RegExp(
  process.env.ATTACH_URL_PATTERN ?? "(?:/view\\?|//comfyui-[\\w.-]+)",
  "i",
);

export interface ExtractedAttachment {
  url: string;
  /** Discord 上のファイル名。拡張子が無いと画像プレビューされないため明示する。 */
  name?: string;
}

export interface ExtractResult {
  /** 添付 URL を取り除いた本文。 */
  text: string;
  attachments: ExtractedAttachment[];
}

/**
 * AI 応答テキストから添付対象 URL（ComfyUI の生成物など）を抽出する。
 * 抽出した URL は本文から除去し、ファイル名（filename クエリ or パス末尾）を name に詰める。
 * 同一 URL は1回だけ。マッチしない URL は本文にそのまま残す。
 */
export function extractAttachments(text: string): ExtractResult {
  const urlRe = /https?:\/\/[^\s<>()"'\]]+/g;
  const attachments: ExtractedAttachment[] = [];
  const seen = new Set<string>();
  const stripped = text.replace(urlRe, (raw) => {
    // 文末の句読点等は URL から除外する。
    const url = raw.replace(/[).,;]+$/, "");
    if (!ATTACH_URL_PATTERN.test(url) || seen.has(url)) return raw;
    seen.add(url);
    attachments.push({ url, name: attachmentNameFromUrl(url) });
    return ""; // 本文からは取り除き、添付として送る。
  });
  return { text: stripped, attachments };
}

/**
 * URL から Discord 添付用のファイル名を決める（approach A: filename クエリ優先）。
 * 1) `?filename=foo.png` の値（ComfyUI の /view URL はこれを持つ）
 * 2) パス末尾セグメント
 * 拡張子の有無で Discord が画像プレビュー/ダウンロード添付を自動で出し分ける。
 */
function attachmentNameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const q = u.searchParams.get("filename");
    if (q) return q;
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || undefined;
  } catch {
    return undefined;
  }
}

/** メッセージ本文からスレッド名（最大 maxLen 文字）を作る。 */
export function deriveThreadName(content: string, maxLen = 80): string {
  const firstLine = content.trim().split("\n")[0] ?? "";
  const name = firstLine.slice(0, maxLen).trim();
  return name.length > 0 ? name : "AI chat";
}
