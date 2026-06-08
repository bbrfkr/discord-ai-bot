# discord-ai-bot

Discord の特定チャンネルへの投稿を起点にスレッドを立て、[opencode](https://opencode.ai) の AI agent が応答する bot です。
opencode サーバー本体は同梱せず、別デプロイの **[opencode-server](https://github.com/bbrfkr/opencode-server)** に `OPENCODE_BASE_URL` で HTTP 接続します。

> サーバー（opencode serve + n8n 短命トークンによるセキュアな git/gh 認証 + defuddle）は opencode-server 側に集約されています。
> この bot は「opencode サーバーを使うクライアント」の 1 つで、サーバーの起動・管理は行いません。

---

## アーキテクチャ

```
Discord ──(メッセージ)──▶ bot ──HTTP(OPENCODE_BASE_URL)──▶ opencode-server ──▶ litellm
                          │
                  .data/ に
            thread↔session を保存
```

- **bot**: `discord.js` で対象チャンネルを監視 → スレッド作成 → opencode に問い合わせ → スレッドへ応答。
- **opencode-server**: 別デプロイ。`OPENCODE_BASE_URL` で到達する（このリポジトリの管理対象外）。
- **会話の継続**: 1 Discord スレッド = 1 opencode セッション。対応表（`thread_id ↔ session_id`）を `.data/thread-sessions.json` に永続化するため、再起動後も会話が続く。
- **ファイルの添付**: メッセージに添付されたファイル（本文なしの添付のみの投稿も可）を mime で振り分ける。
  - **画像など（既定 `image/*`）**: ダウンロードして base64 data URL に変換し、file part として opencode（＝モデル）へ渡す。モデル側で画像入力が有効である必要がある。インライン対象の mime prefix は `OPENCODE_INLINE_MIME_PREFIXES` で変更できる。
  - **それ以外（`model/stl` などのバイナリ）**: file part にすると AI SDK が `file part media type ... functionality not supported` で弾くため、**モデルには渡さず**、Discord の署名付き URL を本文に添えて agent に渡す。agent が必要に応じて curl 等でダウンロードして処理する（例: gdrive スキルで Google Drive へアップロード）。URL は署名付き（クエリ含む・~24h で失効）なので、取得時は URL をダブルクォートで囲む。
- **対話ゲート（permission / question）の橋渡し**: opencode は `bash` 実行やファイル編集の許可待ち（permission）や、ユーザへの選択式/自由入力の質問（question）に当たると、応答を返さずブロックする。bot はイベントストリーム（SSE）でこれらを受け取り、対応スレッドへ通知して返信で応答させる。詳細は[対話（許可・質問）への応答](#対話許可質問への応答)を参照。
- **作業中の進捗反映**: opencode の応答は完了まで何も返らないため、長い作業中はスレッドが「入力中…」のまま無音になる。bot はイベントストリーム（SSE）でツール実行（`bash`/`edit`/`read` など）と TODO 進捗を受け取り、ステップごとにスレッドへ逐次投稿して「今なにをしているか」を可視化する。詳細は[作業中の進捗反映](#作業中の進捗反映)を参照。

### コンポーネント対応表

| レイヤ | 役割 | 主なファイル |
|---|---|---|
| `AgentService` | opencode SDK のラッパ（セッション作成・プロンプト送信） | `src/opencode/agent.ts`, `src/opencode/client.ts` |
| `ThreadSessionStore` | `thread_id ↔ session_id` を JSON で永続化 | `src/store/threadSessionStore.ts` |
| `ThreadAgent` | 上記2つを束ね「スレッド単位の会話」を提供 | `src/threadAgent.ts` |
| `InteractionGate` | 対話要求（許可/質問, SSE）を購読しスレッドへ通知・返信で応答 | `src/discord/interactionGate.ts` |
| `ProgressReporter` | 作業中のツール実行・TODO 進捗（SSE）を購読しスレッドへ逐次投稿 | `src/discord/progressReporter.ts` |
| Discord bot | チャンネル監視・スレッド応答 | `src/discord/bot.ts`, `src/discord/format.ts` |
| 動作確認 CLI | opencode 単体の疎通テスト | `src/cli.ts` |

---

## 対話（許可・質問）への応答

opencode には、実行を止めてユーザの入力を待つ**対話ゲートが 2 種類**ある。どちらも解決するまで**プロンプトの HTTP 応答を返さずブロックする**ため、クライアントが応答しないとセッションは止まったままになる。

- **permission**: `bash` 実行やファイル編集など、サーバ側 `permission` 設定で許可が必要な操作。
- **question**: agent がユーザに尋ねる選択式（場合により自由入力）の質問。

bot はこれを次のように橋渡しする（実装: `src/discord/interactionGate.ts`）。

1. 起動時にイベントストリーム（`GET /event`、SSE）を購読する。購読は bot 側（`bot.ts`）の**単一ディスパッチャ**が 1 本だけ張り、受け取った各イベントを許可/質問ゲートと進捗レポーターの両方へ配る（opencode サーバが SSE を 1 接続にしか流さない/取り合う場合に、購読を複数張ると一部のハンドラへイベントが届かないため）。
2. `permission.asked` / `question.asked` を受け取ると、`sessionID` から対応スレッドを逆引きし、そのスレッドへ内容を投稿する。
3. ユーザがそのスレッドに**返信**すると、応答に変換してサーバへ返し（`POST /session/{id}/permissions/{permissionID}` または `POST /question/{id}/reply`）、ブロックを解除する。解除後は元の応答がそのままスレッドへ投稿される。

対話待ちの間は、解釈できない返信も通常メッセージとして AI へ転送されず、待機中である旨を案内する（進行中の処理に二重で問い合わせないため）。要求が失効（タイムアウト等）した場合は、セッションがアイドルに戻った時点で保留を自動的に破棄する。

### 許可（permission）への返信

次の語（前後の空白は無視、英語も可）が応答として解釈される。

| 返信 | 動作 | opencode への応答 |
|---|---|---|
| `承認` / `許可` / `approve` / `allow` / `ok` / `yes` | 今回だけ許可 | `once` |
| `常に許可` / `常に承認` / `always` | 以後この種別は自動許可 | `always` |
| `拒否` / `却下` / `deny` / `reject` / `no` | 実行しない | `reject` |

### 質問（question）への返信

通知には各選択肢が**番号付き**で並ぶ。返信は次のように解釈される。

- **選択**: 選択肢の**番号**（`1`）または**ラベル文字列**（大小無視）で回答。
- **複数選択可の質問**: 番号/ラベルを空白・カンマ区切りで複数指定（例 `1, 3`）。
- **自由入力可の質問**: 選択肢に当てはまらない返信は、その本文がそのまま回答になる。
- **複数の質問**: **1 行に 1 件ずつ**、質問の順に回答する。
- **取り消し**: `拒否` / `キャンセル` / `reject` で質問への回答を取り消す。

> 💡 そもそも許可を求める頻度を減らしたい場合は、**opencode-server 側**の `opencode.json` の `permission` 設定で、安全な操作を `allow`、危険な操作だけ `ask`/`deny` に振り分けるとよい（設定キー: `edit` / `bash` / `webfetch` / `question` など。`bash` はコマンドのパターン別指定も可能）。

---

## 作業中の進捗反映

opencode の応答（`session.prompt`）は**完了するまで何も返さない**ため、時間のかかる作業中はスレッドが「入力中…」のまま無音になり、ユーザに何が起きているか見えない。`ProgressReporter`（`src/discord/progressReporter.ts`）が（許可/質問ゲートと共有する単一 SSE 購読から配られる）イベントを受け取り、作業の進行をステップごとにスレッドへ投稿する。

反映するイベントは次の2種類:

- **ツール実行**（`message.part.updated` の `tool` パート）: ツールが実行に入った（`running`）タイミングで「今なにをしているか」を1行投稿する。例:
  - `🔧 コマンドを実行中: \`npm test\``（bash）
  - `📖 読み込み中: \`src/app.ts\``（read）／ `✏️ 編集中: …`（edit）／ `📝 作成中: …`（write）
  - `🔍 検索中: …`（grep/glob）／ `🌐 取得中: …`（webfetch）／ `🤖 サブタスク実行中: …`（task）
- **TODO 進捗**（`todo.updated`）: agent の TODO リストが変化したとき `📋 進捗 2/5 完了 — 🔄 着手中の項目` の形で投稿する。

実装上の注意:

- 同一ツール（`callID`）は状態遷移（`pending`→`running`→`completed`）のたびに送られてくるが、**1回だけ**投稿する。
- TODO は完了数や着手中の項目が変化したときだけ投稿し、同内容の連投を防ぐ。
- セッションが `session.idle` に戻ると、そのセッションぶんの通知状態（既知の `callID`・直近 TODO）を破棄する。
- スレッドに紐づかないセッション（CLI 等）は通知先が無いので無視する。

> 💡 投稿が多すぎる場合は `describeTool`（`progressReporter.ts`）で対象ツールを絞り込める。逆に表示を最小限にしたいなら、ツール実行の投稿を止めて TODO 進捗だけ残すといった調整も同ファイルで完結する。

> 🔍 進捗が出ないときは、環境変数 `PROGRESS_DEBUG=1` を付けて起動すると、実際に流れてきたイベント型名（型ごとに初回 1 回）と、`tool` パートの `type` / `tool` / `status` をログ出力する。これで opencode サーバ側のイベント型名・payload が想定とズレていないか確認できる。

---

## 必要なもの

- Docker / docker compose（OrbStack や Docker Desktop でも可）
- 到達可能な **opencode-server** のデプロイ（`OPENCODE_BASE_URL`）
- Discord Bot のトークンと、監視対象チャンネルの ID
- （ローカル実行する場合のみ）Node.js 24 以上

---

## セットアップ

### 1. `.env` を用意

```bash
cp .env.example .env
```

`.env` を編集して以下を設定する（このファイルは `.gitignore` 済み。**コミットしないこと**）。

| 変数 | 必須 | 説明 |
|---|---|---|
| `OPENCODE_BASE_URL` | ✅ | 接続先 opencode-server の URL（例 `http://host:4096`） |
| `DISCORD_TOKEN` | ✅ | Bot トークン（Developer Portal > Bot > Reset Token） |
| `DISCORD_TARGET_CHANNEL_ID` | ✅ | 監視対象チャンネル ID（開発者モードON → 右クリック → IDをコピー） |
| `OPENCODE_PROVIDER_ID` / `OPENCODE_MODEL_ID` | – | 使用モデルの上書き。未指定ならサーバの既定 |
| `OPENCODE_INLINE_MIME_PREFIXES` | – | モデルに file part として渡す添付の mime prefix（カンマ区切り）。既定 `image/`。これに一致しない添付は URL で agent に渡す（例: `image/,application/pdf`） |

> litellm の接続情報やモデル定義、git/gh 認証（n8n 短命トークン）は **opencode-server 側**の設定。bot には不要。

### 2. Discord Bot の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application → **Bot** で作成しトークン取得。
2. **Bot 設定の Privileged Gateway Intents で `MESSAGE CONTENT INTENT` を ON**（本文読み取りに必須）。
3. **OAuth2 > URL Generator** で scope=`bot`、権限に `View Channels` / `Send Messages` / `Create Public Threads` / `Send Messages in Threads` を付与し、生成 URL からサーバーに招待。

---

## 起動（docker compose・推奨）

事前に opencode-server を起動し、`OPENCODE_BASE_URL` がそこへ到達できることを確認しておく。

```bash
docker compose up -d --build      # ビルドして起動
docker compose logs -f bot        # bot のログ追従。"logged in as ..." が出れば成功
docker compose ps                 # 稼働状況
docker compose down               # 停止
```

起動後、対象チャンネルに投稿するとスレッドが立ち AI が応答する。スレッド内で続けて話しかければ会話が継続する。

---

## ローカル実行（開発・デバッグ用）

`OPENCODE_BASE_URL` が到達可能な opencode-server を指している前提。

```bash
npm install

# opencode 単体の疎通テスト（毎回新規セッション）
npm run cli -- "1+1は？"

# スレッド継続のテスト（同じ名前 = 同じセッション。別プロセスでも継続）
npm run cli -- --thread demo "私の名前はタロウ"
npm run cli -- --thread demo "私の名前は？"      # → タロウ

# bot をローカル起動
npm run bot

# 型チェック
npm run typecheck
```

---

## 運用・保守

### ログの確認

```bash
docker compose logs -f bot           # bot
docker compose logs --since 1h bot   # 直近1時間
```

### 再起動 / 更新

```bash
docker compose restart bot                  # 再起動
docker compose up -d --build                # コード変更を反映して再ビルド・再起動
```

### データの永続化とリセット

| データ | 保存先 | リセット方法 |
|---|---|---|
| `thread_id ↔ session_id` | ホスト `./.data/thread-sessions.json` | ファイルを `{}` にするか削除 |

> ⚠️ opencode-server 側のセッション DB を消すと既存スレッドの session ID が無効になる。
> 整合性を保つには `.data/thread-sessions.json` も合わせてリセットする。

### バックアップ

```bash
# マッピング（軽量・テキスト）
cp .data/thread-sessions.json backup-$(date +%F).json
```

---

## トラブルシュート

| 症状 | 確認ポイント |
|---|---|
| bot がメッセージに反応しない | `MESSAGE CONTENT INTENT` が ON か / `DISCORD_TARGET_CHANNEL_ID` が正しいか / bot がそのチャンネルを見える権限を持つか |
| スレッドが作れない | bot に `Create Public Threads` 権限があるか |
| 応答が `⚠️ AI への問い合わせに失敗` | `OPENCODE_BASE_URL` が正しいか / opencode-server が稼働・到達可能か |
| ローカルで `cli` が繋がらない | opencode-server が起動しているか / `OPENCODE_BASE_URL` |

---

## セキュリティ上の注意

- `.env` と `.data/` は `.gitignore` 済み。**Bot トークンは絶対にコミットしない。**
- litellm の API キーや GitHub の秘密情報はこの bot には持たせない（すべて opencode-server 側に閉じている）。
- Bot トークンが漏れた場合は Developer Portal で即 **Reset Token**。

---

## ディレクトリ構成

```
discord-bot/
├── docker-compose.yml        # bot サービス（外部 opencode-server へ接続）
├── Dockerfile                # bot イメージ
├── src/
│   ├── cli.ts                # 動作確認 CLI
│   ├── threadAgent.ts        # スレッド単位の会話層
│   ├── opencode/             # opencode SDK ラッパ（コア層）
│   ├── store/                # thread↔session 永続化
│   └── discord/              # Discord bot 本体
├── .env.example              # 環境変数テンプレート
└── .data/                    # thread↔session マッピング（実行時生成・gitignore）
```
