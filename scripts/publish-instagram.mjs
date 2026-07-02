#!/usr/bin/env node
// publish-instagram.mjs — Instagram Graph API でリール動画を投稿する。
//
// 使い方:
//   node scripts/publish-instagram.mjs --video-url <公開URL> --caption-file <path>
//   node scripts/publish-instagram.mjs --video-url <公開URL> --caption "本文..."
//
// 必須環境変数:
//   IG_USER_ID       … Instagram ビジネスアカウントの ID
//   IG_ACCESS_TOKEN  … 長期アクセストークン
// どちらか欠けている場合は「DRY-RUN: 投稿スキップ」と出力して exit 0。
//
// 外部 npm 依存なし（標準 fetch のみ）。

import { readFile } from "node:fs/promises";

const GRAPH = "https://graph.facebook.com/v21.0";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--video-url") args.videoUrl = argv[++i];
    else if (a === "--caption") args.caption = argv[++i];
    else if (a === "--caption-file") args.captionFile = argv[++i];
    else if (a === "--template") args.template = argv[++i];
    else if (a === "--orientation") args.orientation = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `Graph API エラー (${r.status}): ${JSON.stringify(json?.error ?? json)}`
    );
  }
  return json;
}

async function getJson(url) {
  const r = await fetch(url);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `Graph API エラー (${r.status}): ${JSON.stringify(json?.error ?? json)}`
    );
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.videoUrl) {
    console.error("--video-url は必須です");
    process.exit(2);
  }
  // 横動画（landscape / 1920x1080）はリール（9:16 必須）に投稿できない。
  // 明示的にスキップして正常終了する（動画自体は生成・公開 URL 化される）。
  if (args.orientation === "landscape") {
    console.log("landscape（横動画）→ Instagram投稿スキップ（リールは 9:16 のみ対応）");
    console.log("PUBLISH_RESULT " + JSON.stringify({ status: "skipped-landscape" }));
    process.exit(0);
  }
  // edu テンプレート（教養ショート / YouTube 向け・アフィリエイトなし）は
  // Instagram には投稿しない。明示的にスキップして正常終了する。
  if (args.template === "edu") {
    console.log("edu template → Instagram投稿スキップ（YouTubeショート向け・非アフィリエイト）");
    console.log("PUBLISH_RESULT " + JSON.stringify({ status: "skipped-edu" }));
    process.exit(0);
  }

  let caption = args.caption ?? "";
  if (args.captionFile) caption = await readFile(args.captionFile, "utf8");

  const IG_USER_ID = process.env.IG_USER_ID;
  const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

  if (!IG_USER_ID || !IG_ACCESS_TOKEN) {
    console.log("DRY-RUN: 投稿スキップ（IG_USER_ID / IG_ACCESS_TOKEN 未設定）");
    console.log(`  video_url: ${args.videoUrl}`);
    console.log(`  caption(先頭60字): ${caption.slice(0, 60).replace(/\n/g, " ")}…`);
    console.log("PUBLISH_RESULT " + JSON.stringify({ status: "dry-run" }));
    process.exit(0);
  }

  // ① コンテナ作成
  console.log("① メディアコンテナを作成します...");
  const create = await postForm(`${GRAPH}/${IG_USER_ID}/media`, {
    media_type: "REELS",
    video_url: args.videoUrl,
    caption,
    access_token: IG_ACCESS_TOKEN,
  });
  const creationId = create.id;
  if (!creationId) throw new Error("creation id を取得できませんでした");
  console.log(`  creation_id=${creationId}`);

  // ② FINISHED までポーリング（5秒 × 最大60回 = 5分）
  console.log("② 動画処理の完了を待ちます（最大5分）...");
  let finished = false;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const st = await getJson(
      `${GRAPH}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(
        IG_ACCESS_TOKEN
      )}`
    );
    const code = st.status_code;
    console.log(`  [${i + 1}/60] status_code=${code}`);
    if (code === "FINISHED") {
      finished = true;
      break;
    }
    if (code === "ERROR") {
      throw new Error(`メディア処理がエラーになりました: ${st.status ?? ""}`);
    }
  }
  if (!finished) throw new Error("動画処理がタイムアウトしました（5分）");

  // ③ 公開
  console.log("③ 公開します...");
  const publish = await postForm(`${GRAPH}/${IG_USER_ID}/media_publish`, {
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`公開完了: media_id=${publish.id}`);
  console.log(
    "PUBLISH_RESULT " + JSON.stringify({ status: "published", mediaId: publish.id })
  );
}

main().catch((e) => {
  console.error("publish-instagram 失敗:", e?.message || e);
  process.exit(1);
});
