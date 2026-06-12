# SETUP — オーナー作業手順

このパイプラインを本番稼働させるために、オーナー（会長）が一度だけ行う作業です。
コードは実装済みなので、ここでは **外部サービスの登録と GitHub Secrets への鍵の登録** だけを行います。

所要: ①約10分 ②約30〜40分 ③約5分（任意）

> Secrets の登録先（共通）:
> リポジトリ `litwill-reels` → **Settings** → 左メニュー **Secrets and variables** → **Actions** → **New repository secret**

---

## ① 楽天アフィリエイトID ＋ 楽天アプリID の取得（約10分）

第1段（台本生成側）が商品を選ぶのに使います。本リポでは caption の誘導リンク用に使うため、
**取得して控えておく**だけでOK（このリポの secrets には必須ではありません）。

### 楽天アフィリエイトID
1. https://affiliate.rakuten.co.jp/ にアクセスし、楽天会員でログイン。
2. 利用規約に同意して **アフィリエイト利用を開始**。
3. 画面上部メニューの **「レポート」や「ツール」** から自分の **アフィリエイトID**（20桁前後の英数字）を確認し控える。

### 楽天アプリID（Rakuten Developers）
1. https://webservice.rakuten.co.jp/ にアクセスしてログイン。
2. 右上 **「アプリID発行」** をクリック。
3. アプリ名（例: `litwill-reels`）・アプリURL（サイトURLでよい）を入力して発行。
4. 発行された **applicationId** を控える。

> 控えた2つは、第1段（台本生成）側の secrets / 設定に渡します。第1段の構築時にこの値を使います。

---

## ② Instagram 投稿用トークンの取得（約30〜40分）

Instagram への自動投稿は **Instagram Graph API** を使います。
これには「Instagram をビジネス/プロアカウント化」→「Facebook ページと連携」→「Meta 開発者アプリ作成」→「長期トークン取得」という流れが必要です。画面遷移を順に追ってください。

### (1) Instagram をプロアカウント（ビジネス）にする
1. スマホの Instagram アプリ → 自分のプロフィール → 右上 **三本線** → **設定とアクティビティ**。
2. **アカウントの種類とツール** → **プロアカウントに切り替える**。
3. カテゴリを選び、**「ビジネス」** を選択して完了。

### (2) Facebook ページを用意し、Instagram と連携
1. https://www.facebook.com/pages/create でブランド用の **Facebook ページ** を作成（既にあればそれを使用）。
2. その Facebook ページ → **設定** → **リンク済みのアカウント**（または「Instagram」）→ **Instagram アカウントを接続**。
3. ビジネス用 Instagram でログインして接続を完了。

### (3) Meta 開発者アプリを作成
1. https://developers.facebook.com/ にアクセス → 右上 **ログイン**（Facebook アカウント）。
2. 初回は **「開発者として登録」** を求められるので進める。
3. 上部メニュー **マイアプリ** → **アプリを作成**。
4. ユースケースで **「その他」** → アプリタイプ **「ビジネス」** を選択 → 次へ。
5. アプリ名（例 `litwill-reels`）と連絡先メールを入力 → **アプリを作成**。
6. 作成後のダッシュボードで、商品に **「Instagram」**（Instagram Graph API）を追加（「製品を追加」一覧から）。

### (4) アクセストークンと IG_USER_ID を取得する
最も確実なのは **Graph API Explorer** を使う方法です。

1. https://developers.facebook.com/tools/explorer/ を開く。
2. 右上 **Meta App** で先ほど作ったアプリを選択。
3. **User or Page** で **Get User Access Token** を選択。
4. **Add a Permission** で次の権限にチェック:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`
5. **Generate Access Token** → Facebook の許可ダイアログで該当ページ/Instagram を選んで承認。
   → 短期トークン（数時間有効）が表示される。
6. **IG_USER_ID を調べる**: Explorer のリクエスト欄に次を順に投げる。
   - `me/accounts` を GET → 自分の **Facebook ページの id** を控える（`data[].id`）。
   - `{ページID}?fields=instagram_business_account` を GET → 返ってくる
     `instagram_business_account.id` が **IG_USER_ID**。控える。
7. **長期トークン（約60日有効）に変換**: ブラウザのアドレスバーで次の URL を開く（`{...}` を置換）。
   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id={アプリID}&client_secret={アプリシークレット}&fb_exchange_token={手順5の短期トークン}
   ```
   - `client_id` = 開発者アプリの **アプリID**（ダッシュボード上部）。
   - `client_secret` = **設定 → ベーシック → アプリシークレット**（「表示」で取得）。
   - 返ってきた JSON の `access_token` が **長期トークン**。これを **IG_ACCESS_TOKEN** として控える。

> 長期トークンも約60日で失効します。失効前に手順7を再実行して更新してください（将来は自動更新を v2 で検討）。

### (5) GitHub Secrets に登録
リポジトリ `litwill-reels` → Settings → Secrets and variables → Actions → New repository secret で、
次の2つを登録します。

| Name | Value |
|------|-------|
| `IG_USER_ID` | 手順(4)-6 の Instagram ビジネスアカウント ID |
| `IG_ACCESS_TOKEN` | 手順(4)-7 の長期アクセストークン |

> この2つが **未登録のうちは投稿されず DRY-RUN（合成と動画 push までは実行）** になります。
> まず DRY-RUN で動画が `output/` に出ることを確認してから登録するのがおすすめです。

---

## ③ Slack 通知（任意・約5分）

成功/失敗を Slack に飛ばしたい場合のみ。未設定でも CI は動き、結果は Actions の Summary に出ます。

1. https://api.slack.com/apps → **Create New App** → **From scratch** → アプリ名とワークスペースを選択。
2. 左メニュー **Incoming Webhooks** → **Activate Incoming Webhooks** を ON。
3. **Add New Webhook to Workspace** → 通知を送りたいチャンネルを選んで許可。
4. 生成された **Webhook URL**（`https://hooks.slack.com/services/...`）をコピー。
5. GitHub Secrets に登録:

| Name | Value |
|------|-------|
| `SLACK_WEBHOOK_URL` | コピーした Webhook URL |

---

## 動作確認の流れ（おすすめ順）
1. まだ secrets を登録せず、Actions タブ → **build-and-post** → Run workflow → `queue_file` に `queue/sample.json`。
2. 動画が `output/2026-06-12.mp4` に push され、Summary に「DRY-RUN / 動画: <raw URL>」が出ることを確認。
3. その raw URL をブラウザで開いて動画を目視確認。
4. 問題なければ ②の `IG_USER_ID` / `IG_ACCESS_TOKEN` を登録 → 再度 Run workflow で実投稿。
