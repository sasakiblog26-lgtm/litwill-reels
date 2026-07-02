#!/usr/bin/env node
// build-video.mjs — queue JSON から 1080x1920 のリール動画を合成する。
//
// 使い方:  node scripts/build-video.mjs queue/2026-06-12.json
// 出力:    output/<date>.mp4 （1080x1920 / H.264 / AAC / 30fps）
//
// 前提（CI 環境で用意される）:
//   - VOICEVOX ENGINE が http://127.0.0.1:50021 で稼働
//   - ffmpeg / ffprobe が PATH 上にある
//   - Noto Sans CJK フォントがインストール済み（fonts-noto-cjk）
//
// 外部 npm 依存はゼロ。標準 fetch / child_process / fs のみを使う。

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WIDTH,
  HEIGHT,
  FPS,
  OUTRO_SEC,
  BRAND,
  escapeDrawText,
  buildTimeline,
  buildRankingSections,
  validateQueue,
  layoutTitle,
  voicevoxCreditFor,
  resolveLineSfx,
} from "./lib/video-logic.mjs";

const VOICEVOX_URL = process.env.VOICEVOX_URL || "http://127.0.0.1:50021";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "output");

// 効果音（SFX）の音量係数（ナレーションより控えめ）
const SFX_VOLUME = 0.32;

// ---- フォント解決 -----------------------------------------------------------
// CI(Ubuntu) では fonts-noto-cjk が下記のいずれかに入る。最初に見つかったものを使う。
const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
];
function resolveFontFile() {
  if (process.env.FONT_FILE && existsSync(process.env.FONT_FILE))
    return process.env.FONT_FILE;
  for (const f of FONT_CANDIDATES) if (existsSync(f)) return f;
  // 見つからなくても drawtext の font 名指定で動くことがあるため null を許容
  return null;
}

// ---- 小物 -------------------------------------------------------------------
function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    let err = "";
    if (capture) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}\n${err}`));
    });
  });
}

async function ffprobeDurationSec(file) {
  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { capture: true }
  );
  const v = parseFloat(out);
  return Number.isFinite(v) ? v : 0;
}

// 音声ストリームのサンプルレート/チャンネル数を取得（ミックス出力を元WAVに合わせる用）
async function ffprobeAudioStream(file) {
  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { capture: true }
  );
  const [sr, ch] = out.split(/\s+/);
  return {
    sampleRate: parseInt(sr, 10) || 24000,
    channels: parseInt(ch, 10) || 1,
  };
}

// ---- 効果音（SFX） ----------------------------------------------------------
// SFX_DIR（既定 assets/sfx）を解決する。無ければ null（＝SFXなしで続行）。
function resolveSfxDir() {
  const raw = process.env.SFX_DIR || "assets/sfx";
  const dir = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  if (!existsSync(dir)) {
    console.warn(
      `SFX_DIR が存在しないため効果音なしで続行します: ${dir}（Actions シークレット未登録時など）`
    );
    return null;
  }
  return dir;
}

// 拡張子なしの効果音名から実ファイルパスを解決する。見つからなければ null。
function resolveSfxPath(dir, name) {
  if (!dir || !name) return null;
  const p = path.join(dir, `${name}.mp3`);
  return existsSync(p) ? p : null;
}

// ナレーション WAV に効果音を行頭から重ねてミックスする。
// - SFX は SFX_VOLUME 倍に減衰、amix duration=first で行長（ナレーション実測長）で切る
// - normalize=0 でナレーション音量を維持（amix の自動減衰を無効化）
// - 入力はすべて引数配列で渡す（スペース・日本語を含むパスでも安全）
// - 出力フォーマットは元 WAV に合わせる（後段の concat -c copy を壊さない）
async function mixLineWithSfx(lineWav, sfxPath, outPath, volume = SFX_VOLUME) {
  const { sampleRate, channels } = await ffprobeAudioStream(lineWav);
  const fc =
    `[1:a]volume=${volume}[s];` +
    `[0:a][s]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  await run("ffmpeg", [
    "-y",
    "-i",
    lineWav,
    "-i",
    sfxPath,
    "-filter_complex",
    fc,
    "-map",
    "[a]",
    "-ar",
    String(sampleRate),
    "-ac",
    String(channels),
    outPath,
  ]);
  return outPath;
}

// ---- VOICEVOX --------------------------------------------------------------
async function waitForVoicevox(retries = 30, intervalMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${VOICEVOX_URL}/version`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`VOICEVOX ENGINE に接続できませんでした: ${VOICEVOX_URL}`);
}

async function synthesizeLine(text, speaker, outPath) {
  // 1) audio_query
  const q = await fetch(
    `${VOICEVOX_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`,
    { method: "POST" }
  );
  if (!q.ok) throw new Error(`audio_query 失敗 (${q.status}): ${text}`);
  const query = await q.json();
  // 2) synthesis
  const s = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`synthesis 失敗 (${s.status}): ${text}`);
  const buf = Buffer.from(await s.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
}

// ---- 画像取得 ---------------------------------------------------------------
async function downloadImage(url, outPath) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`画像取得失敗 (${r.status}): ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
}

// ---- filtergraph 構築 -------------------------------------------------------
const FONT = resolveFontFile();

function fontArg() {
  // fontfile が解決できればそれを、無ければ font 名（fontconfig 経由）を使う
  return FONT ? `fontfile='${FONT}'` : `font='Noto Sans CJK JP'`;
}

// 字幕（画面下部・白文字・黒縁）の drawtext を 1 行ぶん組み立てる
function subtitleDraw(line) {
  const t = escapeDrawText(line.text);
  return [
    `drawtext=${fontArg()}`,
    `text='${t}'`,
    `fontcolor=white`,
    `fontsize=52`,
    `borderw=6`,
    `bordercolor=black@0.9`,
    `x=(w-text_w)/2`,
    `y=h-360`,
    `box=1`,
    `boxcolor=black@0.35`,
    `boxborderw=24`,
    `enable='between(t,${line.start.toFixed(3)},${line.end.toFixed(3)})'`,
  ].join(":");
}

// 常時表示の PR バッジ（左上・ステマ規制対応）
function prBadgeDraw() {
  return [
    `drawtext=${fontArg()}`,
    `text='PR'`,
    `fontcolor=white`,
    `fontsize=40`,
    `borderw=4`,
    `bordercolor=black`,
    `box=1`,
    `boxcolor=black@0.5`,
    `boxborderw=16`,
    `x=48`,
    `y=72`,
  ].join(":");
}

// 順位バッジ（ranking 用・中央上）
function rankBadgeDraw(section) {
  const t = escapeDrawText(section.rankLabel);
  return [
    `drawtext=${fontArg()}`,
    `text='${t}'`,
    `fontcolor=0xF6D365`,
    `fontsize=88`,
    `borderw=6`,
    `bordercolor=black@0.9`,
    `x=(w-text_w)/2`,
    `y=220`,
    `enable='between(t,${section.start.toFixed(3)},${section.end.toFixed(3)})'`,
  ].join(":");
}

// アウトロ（末尾 OUTRO_SEC 秒）のテキスト群
function outroDraws(totalDuration) {
  const from = (totalDuration - OUTRO_SEC).toFixed(3);
  const to = totalDuration.toFixed(3);
  const mk = (text, y, size, color) =>
    [
      `drawtext=${fontArg()}`,
      `text='${escapeDrawText(text)}'`,
      `fontcolor=${color}`,
      `fontsize=${size}`,
      `borderw=5`,
      `bordercolor=black@0.9`,
      `x=(w-text_w)/2`,
      `y=${y}`,
      `enable='between(t,${from},${to})'`,
    ].join(":");
  return [
    mk("詳しくはプロフィールのリンクから", 820, 50, "white"),
    mk(BRAND.name, 980, 64, "0xF6D365"),
    mk(BRAND.voicevoxCredit, 1120, 34, "white@0.85"),
  ];
}

// edu 用アウトロ（YouTubeショート向け）。誘導文が「概要欄から」になる。
// VOICEVOX クレジットはライセンス要件のため話者に追従させて必ず表示する。
function eduOutroDraws(totalDuration, speaker) {
  const from = (totalDuration - OUTRO_SEC).toFixed(3);
  const to = totalDuration.toFixed(3);
  const credit = voicevoxCreditFor(speaker);
  const mk = (text, y, size, color) =>
    [
      `drawtext=${fontArg()}`,
      `text='${escapeDrawText(text)}'`,
      `fontcolor=${color}`,
      `fontsize=${size}`,
      `borderw=5`,
      `bordercolor=black@0.9`,
      `x=(w-text_w)/2`,
      `y=${y}`,
      `enable='between(t,${from},${to})'`,
    ].join(":");
  return [
    mk("詳しくは概要欄から🔗", 820, 50, "white"),
    mk(BRAND.name, 980, 64, "0xF6D365"),
    mk(credit, 1120, 34, "white@0.85"),
  ];
}

// edu 用タイトル（画面上部〜中央上寄りに大きく常時表示・白文字黒縁）。
// layoutTitle が決めた行配列とフォントサイズを縦に積む。
function titleDraws(title) {
  const { lines, fontSize } = layoutTitle(title);
  const lineHeight = Math.round(fontSize * 1.45);
  const startY = 340; // 上寄せ（順位バッジ位置よりやや下）
  return lines.map((ln, i) => {
    const t = escapeDrawText(ln);
    return [
      `drawtext=${fontArg()}`,
      `text='${t}'`,
      `fontcolor=white`,
      `fontsize=${fontSize}`,
      `borderw=7`,
      `bordercolor=black@0.9`,
      `x=(w-text_w)/2`,
      `y=${startY + i * lineHeight}`,
    ].join(":");
  });
}

// ---- メイン -----------------------------------------------------------------
async function main() {
  const queuePath = process.argv[2];
  if (!queuePath) {
    console.error("使い方: node scripts/build-video.mjs <queue.json>");
    process.exit(2);
  }
  const data = JSON.parse(await readFile(queuePath, "utf8"));
  validateQueue(data);

  const speaker = Number.isInteger(data.voice_speaker) ? data.voice_speaker : 2;
  const work = path.join(tmpdir(), `reel-${data.date}-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  // 1) ナレーション合成（＋任意の効果音ミックス）
  await waitForVoicevox();
  console.log(`VOICEVOX 起動確認OK (${VOICEVOX_URL})。${data.script.length}行を合成します。`);
  const sfxAssign = resolveLineSfx(data); // 各行の効果音名 or null（純粋ロジック）
  const sfxDir = resolveSfxDir(); // null なら SFX なしで続行
  const wavPaths = [];
  for (let i = 0; i < data.script.length; i++) {
    const wp = path.join(work, `line-${String(i).padStart(2, "0")}.wav`);
    await synthesizeLine(data.script[i].text, speaker, wp);
    let finalWp = wp;
    const sfxName = sfxAssign[i];
    if (sfxName) {
      const sfxPath = resolveSfxPath(sfxDir, sfxName);
      if (sfxPath) {
        const mixed = path.join(work, `line-${String(i).padStart(2, "0")}-mix.wav`);
        await mixLineWithSfx(wp, sfxPath, mixed);
        finalWp = mixed;
        console.log(`  行${i}: 効果音「${sfxName}」をミックスしました`);
      } else {
        console.warn(
          `  行${i}: 効果音「${sfxName}」が見つからないため SFX なしで続行します`
        );
      }
    }
    wavPaths.push(finalWp);
  }

  // 2) 各 WAV 実測秒 → タイムライン
  const measured = [];
  for (const wp of wavPaths) measured.push(await ffprobeDurationSec(wp));
  const timeline = buildTimeline(data.script, measured);
  console.log(
    `ナレーション長 ${timeline.narrationEnd.toFixed(1)}s + アウトロ ${OUTRO_SEC}s = 合計 ${timeline.totalDuration.toFixed(1)}s`
  );

  // 3) ナレーション WAV を連結 → narration.wav
  const concatList = path.join(work, "concat.txt");
  await writeFile(
    concatList,
    wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  const narration = path.join(work, "narration.wav");
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    narration,
  ]);

  // 4) 商品画像をダウンロード（edu は商品なしのため空）
  const products = Array.isArray(data.products) ? data.products : [];
  const imgPaths = [];
  for (let i = 0; i < products.length; i++) {
    const ip = path.join(work, `product-${i}.img`);
    await downloadImage(products[i].imageUrl, ip);
    imgPaths.push(ip);
  }

  // 5) ffmpeg 入力とフィルタを構築
  const total = timeline.totalDuration;
  const inputs = [];
  // [0] 背景: 縦グラデーション（gradients フィルタ）
  inputs.push(
    "-f",
    "lavfi",
    "-t",
    String(total),
    "-i",
    `gradients=s=${WIDTH}x${HEIGHT}:c0=${BRAND.colorTop}:c1=${BRAND.colorBottom}:x0=0:y0=0:x1=0:y1=${HEIGHT}:d=${Math.ceil(total)}:speed=0.01`
  );
  // [1] 無音オーディオは narration を使うので別途不要。narration を入力に追加。
  inputs.push("-i", narration);
  // [2..] 商品画像
  const imgInputStart = 2;
  for (const ip of imgPaths) inputs.push("-loop", "1", "-t", String(total), "-i", ip);

  // --- filter_complex 組み立て ---
  const filters = [];

  // 背景を基準解像度/fps へ
  filters.push(`[0:v]scale=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p[bg]`);

  let lastV = "bg";
  if (data.template === "edu") {
    // edu: 商品画像なし。タイトルを上部に大きく常時表示するだけ。
    const draws = titleDraws(data.title).join(",");
    filters.push(`[${lastV}]${draws}[titled]`);
    lastV = "titled";
  } else if (data.template === "ranking" && imgPaths.length === 3) {
    const sections = buildRankingSections(3, timeline.narrationEnd);
    // 各商品画像を中央に等倍フィット（はみ出さないよう内接）し、セクション区間だけ overlay
    sections.forEach((sec, i) => {
      const imgIdx = imgInputStart + i;
      filters.push(
        `[${imgIdx}:v]scale=${Math.round(WIDTH * 0.82)}:${Math.round(
          HEIGHT * 0.5
        )}:force_original_aspect_ratio=decrease[p${i}]`
      );
      const next = i === sections.length - 1 ? "withimg" : `ov${i}`;
      filters.push(
        `[${lastV}][p${i}]overlay=x=(W-w)/2:y=(H-h)/2-120:enable='between(t,${sec.start.toFixed(
          3
        )},${sec.end.toFixed(3)})'[${next}]`
      );
      lastV = next;
    });
    // 順位バッジ
    const rankDraws = sections.map((s) => rankBadgeDraw(s)).join(",");
    filters.push(`[${lastV}]${rankDraws}[ranked]`);
    lastV = "ranked";
  } else {
    // single: 1枚を中央に等倍フィット
    filters.push(
      `[${imgInputStart}:v]scale=${Math.round(WIDTH * 0.82)}:${Math.round(
        HEIGHT * 0.5
      )}:force_original_aspect_ratio=decrease[p0]`
    );
    filters.push(
      `[${lastV}][p0]overlay=x=(W-w)/2:y=(H-h)/2-120:enable='between(t,0,${timeline.narrationEnd.toFixed(3)})'[withimg]`
    );
    lastV = "withimg";
  }

  // 商品名テロップ（画像の下・字幕より上）
  const product0 = products[0];
  if (data.template === "single") {
    const nameDraw = [
      `drawtext=${fontArg()}`,
      `text='${escapeDrawText(product0.name)}'`,
      `fontcolor=white`,
      `fontsize=46`,
      `borderw=5`,
      `bordercolor=black@0.9`,
      `x=(w-text_w)/2`,
      `y=h-520`,
    ].join(":");
    filters.push(`[${lastV}]${nameDraw}[named]`);
    lastV = "named";
  }

  // 字幕（全行）
  const subDraws = timeline.lines.map((l) => subtitleDraw(l)).join(",");
  filters.push(`[${lastV}]${subDraws}[subbed]`);
  lastV = "subbed";

  // PR バッジ常時 + アウトロ
  // edu はアフィリエイトではないため PR バッジを出さず、YouTube 向けアウトロを使う。
  const overlayDraws =
    data.template === "edu"
      ? eduOutroDraws(total, speaker).join(",")
      : [prBadgeDraw(), ...outroDraws(total)].join(",");
  filters.push(`[${lastV}]${overlayDraws}[vout]`);

  // オーディオ: narration を全体尺へ apad（末尾アウトロ分の無音を足す）
  filters.push(
    `[1:a]apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[aout]`
  );

  const filterComplex = filters.join(";");
  const outFile = path.join(OUTPUT_DIR, `${data.date}.mp4`);

  const ffArgs = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-t",
    String(total),
    "-movflags",
    "+faststart",
    outFile,
  ];

  console.log("ffmpeg 合成を開始します...");
  await run("ffmpeg", ffArgs);
  console.log(`完成: ${outFile}`);

  // 後片付け
  await rm(work, { recursive: true, force: true });

  // 後段（CI）が拾えるよう、結果情報を stdout に1行 JSON で出す
  console.log(
    "RESULT " +
      JSON.stringify({
        outFile: path.relative(ROOT, outFile).replace(/\\/g, "/"),
        date: data.date,
        productName:
          data.template === "edu"
            ? data.title
            : products.map((p) => p.name).join(" / "),
        durationSec: +total.toFixed(1),
      })
  );
}

main().catch((e) => {
  console.error("build-video 失敗:", e?.message || e);
  process.exit(1);
});
