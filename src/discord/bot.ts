// .env を読み込む（無くてもよい）。Node 標準の loadEnvFile を使用。
try {
  process.loadEnvFile();
} catch {
  // .env が無い場合は環境変数のみで動作する。
}

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  type SendableChannels,
} from "discord.js";
import { ThreadAgent, type AttachmentInput } from "../threadAgent.js";
import {
  deriveThreadName,
  extractAttachments,
  splitForDiscord,
  type ExtractedAttachment,
} from "./format.js";
import { InteractionGate } from "./interactionGate.js";
import { ProgressReporter } from "./progressReporter.js";

const token = requireEnv("DISCORD_TOKEN");
const targetChannelId = requireEnv("DISCORD_TARGET_CHANNEL_ID");

const threadAgent = new ThreadAgent();
// opencode の対話ゲート（許可/質問）を Discord の返信へ橋渡しする（ask のブロック解除）。
const interactionGate = new InteractionGate(threadAgent);
// 作業中のツール実行・TODO 進捗をスレッドへ逐次反映する（無音の入力中状態を解消）。
const progressReporter = new ProgressReporter(threadAgent);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // メッセージ本文を読むには Developer Portal で MESSAGE CONTENT INTENT を有効化する必要がある。
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  console.log(`[discord] watching channel: ${targetChannelId}`);
  // SSE 購読は 1 本に統合し、各イベントを許可/質問ゲートと進捗レポーターの両方へ配る。
  // （opencode サーバが SSE を 1 接続にしか流さない/取り合う場合に、購読を 2 本張ると
  //   片方にしかイベントが届かないため。）
  void consumeEvents(c);
  console.log("[discord] event dispatcher started (interaction + progress)");
});

/** 単一の SSE 購読ループ。受け取った各イベントを両ハンドラへ配り、切断時は再購読する。 */
async function consumeEvents(c: Client): Promise<void> {
  const debug = process.env.PROGRESS_DEBUG === "1";
  const seenTypes = new Set<string>();
  for (;;) {
    try {
      for await (const ev of threadAgent.events()) {
        // 実体のイベント型名を確認するための診断ログ（型ごとに初回だけ）。
        if (!seenTypes.has(ev.type)) {
          seenTypes.add(ev.type);
          if (debug) console.log(`[events] first seen: ${ev.type}`);
        }
        await interactionGate
          .handleEvent(c, ev)
          .catch((err) =>
            console.error("[interaction] handle event failed:", err),
          );
        await progressReporter
          .handleEvent(c, ev)
          .catch((err) =>
            console.error("[progress] handle event failed:", err),
          );
      }
    } catch (err) {
      console.error("[events] stream error:", err);
    }
    // ストリームが終了/切断したら少し待って再購読する。
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

client.on(Events.MessageCreate, async (message) => {
  // 自分や他 bot の発言は無視（無限ループ防止）。
  if (message.author.bot) return;
  // 本文も添付も無いメッセージは無視（画像だけの投稿は処理する）。
  if (!message.content.trim() && message.attachments.size === 0) return;

  try {
    const channel = message.channel;

    // Discord の添付を、OpenCode へ渡す素のデータへ変換。
    const attachments: AttachmentInput[] = [
      ...message.attachments.values(),
    ].map((a) => ({
      url: a.url,
      mime: a.contentType ?? "application/octet-stream",
      filename: a.name ?? undefined,
    }));

    // ケースA: 対象チャンネル直下への投稿 → スレッドを作って会話を開始。
    if (channel.id === targetChannelId && !channel.isThread()) {
      const thread = await message.startThread({
        name: deriveThreadName(message.content),
        autoArchiveDuration: 1440, // 24時間
      });
      await respond(thread, thread.id, message.content, attachments);
      return;
    }

    // ケースB: 対象チャンネル配下のスレッド内での投稿 → 同じセッションで継続。
    if (channel.isThread() && channel.parentId === targetChannelId) {
      // 対話待ち（許可/質問）のスレッドでは、返信をその応答として解釈する。
      // 解除すると進行中の ask() が答えを返し、既存経路でスレッドへ投稿される。
      if (interactionGate.hasPending(channel.id)) {
        const result = await interactionGate.handleReply(
          channel.id,
          message.content,
        );
        if (result.handled) {
          await channel.send(result.message);
          return;
        }
      }
      await respond(channel, channel.id, message.content, attachments);
      return;
    }
  } catch (err) {
    console.error("[discord] handler error:", err);
    await safeSend(
      message.channel,
      "⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。",
    );
  }
});

/**
 * AI agent に問い合わせ、結果をスレッドへ投稿する。
 * 応答待ちの間は「入力中…」を表示し続ける。
 */
async function respond(
  channel: SendableChannels,
  threadId: string,
  text: string,
  attachments: AttachmentInput[] = [],
): Promise<void> {
  const typing = startTyping(channel);
  try {
    const answer = await threadAgent.ask(threadId, text, attachments);
    // AI 応答内の ComfyUI URL 等は Discord 添付に差し替える（残りは本文として送る）。
    const { text: body, attachments: outFiles } = extractAttachments(answer);
    const chunks = splitForDiscord(body);

    if (chunks.length === 0 && outFiles.length === 0) {
      await channel.send("（応答が空でした）");
      return;
    }

    // 本文チャンクを送る。最後のチャンクに添付をまとめる（本文が無ければ添付だけ送る）。
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isLast = i === chunks.length - 1;
      if (isLast && outFiles.length > 0) {
        await sendWithFiles(channel, chunk, outFiles);
      } else {
        await channel.send(chunk);
      }
    }
    if (chunks.length === 0 && outFiles.length > 0) {
      await sendWithFiles(channel, "", outFiles);
    }
  } catch (err) {
    console.error("[discord] agent error:", err);
    await channel.send("⚠️ AI への問い合わせに失敗しました。");
  } finally {
    typing.stop();
  }
}

/**
 * 本文＋添付（URL）を1メッセージで送る。discord.js は files の URL 文字列を
 * 内部で fetch して Discord CDN にアップロードする（恒久保存される）。
 * サイズ超過・取得失敗時はリンクをテキストで貼るフォールバックに切り替える。
 */
async function sendWithFiles(
  channel: SendableChannels,
  content: string,
  files: ExtractedAttachment[],
): Promise<void> {
  const built = files.map((f) => {
    const a = new AttachmentBuilder(f.url);
    if (f.name) a.setName(f.name);
    return a;
  });
  try {
    await channel.send({ content: content || undefined, files: built });
  } catch (err) {
    console.error("[discord] attach failed, falling back to links:", err);
    const links = files.map((f) => f.url).join("\n");
    await channel.send(content ? `${content}\n${links}` : links);
  }
}

/** typing インジケータを定期送信し続ける（1回の表示は約10秒で切れるため）。 */
function startTyping(channel: SendableChannels): { stop: () => void } {
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => {
    void channel.sendTyping().catch(() => {});
  }, 8000);
  return { stop: () => clearInterval(timer) };
}

async function safeSend(
  channel: Message["channel"],
  content: string,
): Promise<void> {
  if ("send" in channel) {
    await (channel as SendableChannels).send(content).catch(() => {});
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`環境変数 ${name} が未設定です。.env を確認してください。`);
    process.exit(1);
  }
  return value;
}

client.login(token);
