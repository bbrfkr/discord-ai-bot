// .env を読み込む（無くてもよい）。Node 標準の loadEnvFile を使用。
try {
  process.loadEnvFile();
} catch {
  // .env が無い場合は環境変数のみで動作する。
}

import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  type SendableChannels,
} from "discord.js";
import { ThreadAgent, type AttachmentInput } from "../threadAgent.js";
import { deriveThreadName, splitForDiscord } from "./format.js";
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
  // 対話要求（許可/質問）の購読を開始（client 経由で通知先スレッドを取得する）。
  interactionGate.start(c);
  console.log("[discord] interaction gate started");
  // 進捗（ツール実行/TODO）の購読を開始。
  progressReporter.start(c);
  console.log("[discord] progress reporter started");
});

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
    const chunks = splitForDiscord(answer);
    if (chunks.length === 0) {
      await channel.send("（応答が空でした）");
      return;
    }
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  } catch (err) {
    console.error("[discord] agent error:", err);
    await channel.send("⚠️ AI への問い合わせに失敗しました。");
  } finally {
    typing.stop();
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
