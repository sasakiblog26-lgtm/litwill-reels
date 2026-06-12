# litwill-reels

Litwill Garden（占い×心理学ブランド）の **Instagram リール自動生成・投稿パイプライン**。
毎朝クラウド AI が「今日の開運アイテム」紹介リールの台本を `queue/` に push すると、
GitHub Actions が動画を合成し、Instagram に投稿し、Slack に通知します。

---

## 仕組み（2段構成）

```
┌─ 第1段（別リポジトリ / 別ワークフロー：本リポの対象外）─────────┐
│ 毎朝クラウドAI が楽天商品を選定し台本を生成                       │
│   → queue/YYYY-MM-DD.json を push                                  │
└────────────────────────────────────────────────────────────────┘
                              │ push (queue/**.json)
                              ▼
┌─ 第2段（このリポジトリ：.github/workflows/build-and-post.yml）──┐
│ 1. 対象 queue JSON を特定                                         │
│ 2. VOICEVOX ENGINE 起動（Docker サービス）                        │
│ 3. ffmpeg / Noto Sans CJK を apt install                          │
│ 4. scripts/build-video.mjs                                        │
│      ・台本を VOICEVOX で音声合成（行ごと）                        │
│      ・縦グラデ背景＋商品画像＋字幕＋PR表記 を ffmpeg で合成       │
│      → output/YYYY-MM-DD.mp4 (1080x1920 / H.264 / AAC / 30fps)    │
│ 5. output/ を同リポに push → raw.githubusercontent.com で公開URL化 │
│ 6. scripts/publish-instagram.mjs（raw URL で Reels 投稿）         │
│ 7. Slack 通知（Webhook 任意。無ければ Actions サマリで代替）       │
└────────────────────────────────────────────────────────────────┘
```

`paths: ["queue/**.json"]` に限定しているため、手順5の `output/` への push は
ワークフローを **再トリガーしません**。

---

## queue JSON スキーマ

第1段が生成し、`queue/YYYY-MM-DD.json` として push するファイルの形式です。
実例は [`queue/sample.json`](queue/sample.json)。

```jsonc
{
  "date": "2026-06-12",
  "template": "single",          // "single"(単品・約30秒) | "ranking"(TOP3・約45秒)
  "products": [                   // single=1件 / ranking=3件（3位→1位の順で格納）
    {
      "name": "アメジスト さざれ石 100g",
      "price": "1,280円",
      "imageUrl": "https://thumbnail.image.rakuten.co.jp/....jpg",
      "affiliateUrl": "https://hb.afl.rakuten.co.jp/...",  // 動画には出さず caption 誘導用
      "point": "浄化の定番。玄関や枕元に置くだけ"
    }
  ],
  "script": [                     // ナレーション行。text が音声合成され、字幕にもなる
    {"text": "今日の開運アイテムはこちら", "duration_hint": 3}
  ],
  "caption": "今日の開運アイテム✨...\n\n#PR #開運 ...",  // #PR 必須
  "voice_speaker": 2              // VOICEVOX speaker id（既定 2 = 四国めたん ノーマル）
}
```

### フィールド規約
- `template`: `single` は products 1件、`ranking` は 3件（**3位→2位→1位**の順）。
- `script[].duration_hint`: 字幕の目安秒。**実際の表示時間は合成された WAV の実測秒を優先**し、hint はフォールバック。
- `caption`: **`#PR` を必ず含める**（景表法・後述）。ハッシュタグは8個以上推奨、誘導文「リンクはプロフィールから」を入れる。
- `voice_speaker`: VOICEVOX の speaker id。

---

## 動画の仕様
- 1080×1920（縦）/ H.264 high / yuv420p / AAC 128k / 30fps
- 背景: 深紫 `#1a1033` → ラベンダー `#9B8BBF` の縦グラデーション
- 商品画像: 中央に等倍フィット（はみ出さない内接スケール）
- 字幕: 画面下部・白文字・黒縁（Noto Sans CJK）。表示時間=その行の WAV 実測長
- 左上に **「PR」表記を常時表示**（ステマ規制対応。caption だけでなく動画内にも）
- 末尾1.5秒: 「詳しくはプロフィールのリンクから🔗」＋ブランド名＋「VOICEVOX:四国めたん」クレジット
- BGM は入れない（権利リスク回避。v2 でフリー BGM 検討）

---

## ローカル実行方法

> 注意: 音声合成と合成には VOICEVOX ENGINE と ffmpeg が必要です（下記）。
> これらが無い環境では構文チェックとロジックテストのみ実行できます。

### 構文チェック / ロジックテスト（依存ツール不要）
```bash
npm run check        # 全 .mjs の node --check
npm test             # node:test（タイムライン計算・字幕エスケープ・スキーマ検証）
```

### 動画合成をローカルで試す場合
1. VOICEVOX ENGINE を起動（Docker）:
   ```bash
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-ubuntu20.04-latest
   ```
2. ffmpeg と Noto Sans CJK フォントを用意（macOS/Linux はパッケージマネージャ、Windows は別途インストール）。
3. 合成:
   ```bash
   node scripts/build-video.mjs queue/sample.json
   # → output/2026-06-12.mp4
   ```
   `VOICEVOX_URL` や `FONT_FILE` 環境変数で接続先・フォントを上書き可能。

### Instagram 投稿を試す（DRY-RUN）
```bash
node scripts/publish-instagram.mjs --video-url "https://example.com/x.mp4" --caption "テスト #PR"
# env が無い → 「DRY-RUN: 投稿スキップ」で正常終了
```

---

## 手動実行（GitHub Actions）
Actions タブ → **build-and-post** → Run workflow。
`queue_file` に `queue/sample.json` 等を指定するとそのファイルで実行します（空なら push 最新を自動検出）。

---

## ⚖️ 法令・コンプラ注意（必読）

| 項目 | ルール |
|------|--------|
| **景品表示法（ステマ規制）** | アフィリエイト投稿は広告。**全投稿の caption に `#PR` 必須**、かつ**動画内にも「PR」表記を常時表示**。`scripts/lib/video-logic.mjs` の `validateQueue` が `#PR` 欠落を検証で弾く。 |
| **VOICEVOX クレジット** | 音声に VOICEVOX（四国めたん）を使用。**動画内に「VOICEVOX:四国めたん」クレジットを必ず表示**（末尾フレームに実装済み）。 |
| **薬機法・効能の断定禁止** | パワーストーン等の効果を**断定しない**。「絶対」「必ず」「治る」「効く」等は使わない。台本・caption は「親しまれている」「〜と言われる」など伝聞・体験ベースに留める。 |
| **個人情報** | 顧客情報・購入者情報を動画/caption に含めない。 |

---

## ディレクトリ
```
queue/                 第1段が置く台本 JSON（sample.json 同梱）
output/                CI が合成・push する mp4（公開URLの実体）
scripts/
  build-video.mjs        動画合成エントリ
  publish-instagram.mjs  Instagram Graph API 投稿
  lib/
    video-logic.mjs      純粋ロジック（タイムライン/エスケープ/検証）
    video-logic.test.mjs node:test
.github/workflows/
  build-and-post.yml     CI 本体
SETUP_オーナー作業.md    オーナーが行う初期セットアップ手順
```

オーナーが最初に行う API 取得・secrets 登録は [SETUP_オーナー作業.md](SETUP_オーナー作業.md) を参照。
