// 動画合成の純粋ロジック（ffmpeg/VOICEVOX を呼ばずに単体テスト可能な部分）
// build-video.mjs から import して使う。

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const OUTRO_SEC = 1.5; // 末尾の案内クレジット秒数

export const BRAND = {
  name: "Litwill Garden",
  colorTop: "0x1a1033", // 深紫
  colorBottom: "0x9B8BBF", // ラベンダー
  voicevoxCredit: "VOICEVOX:四国めたん",
};

// VOICEVOX speaker id → 話者名。クレジット表記に使う。
// 未知の id は名称を断定しないため汎用表記へフォールバックする。
export const VOICEVOX_SPEAKERS = {
  2: "四国めたん", // 既定（ノーマル）
  3: "ずんだもん",
};

/**
 * speaker id からライセンス表記用のクレジット文字列を返す。
 * 既定(2)は BRAND.voicevoxCredit と一致する。未知 id は "VOICEVOX"。
 * @param {number} speaker
 * @returns {string}
 */
export function voicevoxCreditFor(speaker) {
  const name = VOICEVOX_SPEAKERS[speaker];
  return name ? `VOICEVOX:${name}` : "VOICEVOX";
}

/**
 * Noto Sans CJK で描画できない絵文字・記号を除去するサニタイザ。
 * drawtext に渡す前に通すことで豆腐化（□）を防ぐ。
 * 除去対象:
 *   U+1F000–U+1FFFF  Emoji / Mahjong / Domino 等の SMP 絵文字
 *   U+2600–U+27BF    Miscellaneous Symbols, Dingbats 等
 *   U+FE00–U+FE0F    Variation Selectors（絵文字修飾子）
 * @param {string} text
 * @returns {string}
 */
export function stripEmoji(text) {
  if (text == null) return "";
  return String(text)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[☀-➿]/g, "")
    .replace(/[︀-️]/g, "");
}

/**
 * drawtext / 各種フィルタに渡すテキストをエスケープする。
 * ffmpeg の filtergraph では `:` `'` `\` `%` などが特殊扱いされるため退避する。
 * 絵文字は Noto Sans CJK で描画できないため、エスケープ前に stripEmoji を通す。
 * @param {string} text
 * @returns {string}
 */
export function escapeDrawText(text) {
  if (text == null) return "";
  return stripEmoji(String(text))
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’") // アポストロフィは安全な右シングルクォートに置換
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\n/g, " ");
}

/**
 * 各ナレーション行の表示タイムラインを組み立てる。
 * 字幕の表示時間は「対応する WAV の実測秒数」を最優先し、
 * 取得できない場合のみ duration_hint（無ければ既定3秒）にフォールバックする。
 *
 * @param {Array<{text:string, duration_hint?:number}>} script
 * @param {number[]} measuredDurations script と同じ並びの WAV 実測秒数（未測定は null/undefined 可）
 * @returns {{lines: Array<{index:number,text:string,start:number,end:number,duration:number}>, narrationEnd:number, totalDuration:number}}
 */
export function buildTimeline(script, measuredDurations = []) {
  if (!Array.isArray(script) || script.length === 0) {
    throw new Error("script は1行以上の配列である必要があります");
  }
  let cursor = 0;
  const lines = script.map((row, i) => {
    const measured = measuredDurations[i];
    const fallback =
      typeof row.duration_hint === "number" && row.duration_hint > 0
        ? row.duration_hint
        : 3;
    const duration =
      typeof measured === "number" && measured > 0 ? measured : fallback;
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    return { index: i, text: row.text ?? "", start, end, duration };
  });
  const narrationEnd = cursor;
  return {
    lines,
    narrationEnd,
    totalDuration: narrationEnd + OUTRO_SEC,
  };
}

/**
 * ranking テンプレートで、各商品セクションの表示区間を計算する。
 * ナレーション全体を商品数で等分し、3位→2位→1位の順に割り当てる。
 * （script は順位ごとにまとまっている前提だが、厳密な対応が無くても
 *  破綻しないよう時間ベースで等分する）
 *
 * @param {number} productCount
 * @param {number} narrationEnd
 * @returns {Array<{rankLabel:string,start:number,end:number}>}
 */
export function buildRankingSections(productCount, narrationEnd) {
  if (productCount <= 0) return [];
  // products は 3位→1位 の順に格納されている想定
  const rankLabels = productCount === 3 ? ["第3位", "第2位", "第1位"] : null;
  const seg = narrationEnd / productCount;
  const sections = [];
  for (let i = 0; i < productCount; i++) {
    sections.push({
      rankLabel: rankLabels ? rankLabels[i] : `No.${productCount - i}`,
      start: +(seg * i).toFixed(3),
      end: +(seg * (i + 1)).toFixed(3),
    });
  }
  return sections;
}

/**
 * queue JSON の最低限のバリデーション。CI で早期に落とすために使う。
 * @param {any} data
 * @returns {{ok:true}|never}
 */
export function validateQueue(data) {
  const errs = [];
  if (!data || typeof data !== "object") errs.push("ルートがオブジェクトではありません");
  if (!data?.date) errs.push("date がありません");
  if (
    data?.template !== "single" &&
    data?.template !== "ranking" &&
    data?.template !== "edu"
  )
    errs.push('template は "single" / "ranking" / "edu" のいずれかである必要があります');

  if (data?.template === "edu") {
    // 教養ショート: 商品なし・アフィリエイトなし・ブランド発信。
    // title が必須で、products は不要（空配列 or 省略）。#PR も不要。
    if (typeof data?.title !== "string" || data.title.trim().length === 0)
      errs.push("edu テンプレートでは title（動画タイトル）が必須です");
    if (Array.isArray(data?.products) && data.products.length > 0)
      errs.push("edu テンプレートでは products は不要です（空配列または省略）");
  } else {
    // single / ranking: 従来どおり商品必須（既存挙動を変更しない）
    if (!Array.isArray(data?.products) || data.products.length === 0)
      errs.push("products が空です");
    if (data?.template === "single" && data?.products?.length !== 1)
      errs.push("single テンプレートでは products は1件である必要があります");
    if (data?.template === "ranking" && data?.products?.length !== 3)
      errs.push("ranking テンプレートでは products は3件である必要があります");
    for (const [i, p] of (data?.products ?? []).entries()) {
      if (!p?.imageUrl) errs.push(`products[${i}].imageUrl がありません`);
      if (!p?.name) errs.push(`products[${i}].name がありません`);
    }
    // #PR はアフィリエイト投稿（single/ranking）のみ景表法対応で必須
    if (data?.caption && !data.caption.includes("#PR"))
      errs.push("caption に #PR が含まれていません（景表法対応で必須）");
  }

  if (!Array.isArray(data?.script) || data.script.length === 0)
    errs.push("script が空です");
  if (typeof data?.caption !== "string" || data.caption.length === 0)
    errs.push("caption がありません");

  if (errs.length) {
    throw new Error("queue JSON 検証エラー:\n - " + errs.join("\n - "));
  }
  return { ok: true };
}

/**
 * タイトル文字列を、指定幅に収まるよう行分割＆フォントサイズを決める。
 * drawtext は自動改行しないため、edu テンプレのタイトル描画で使う。
 * CJK は概ね「1文字幅 ≒ フォントサイズ」として概算する。
 *
 * @param {string} title
 * @param {{maxWidth?:number, baseFontSize?:number, minFontSize?:number, maxLines?:number}} [opts]
 * @returns {{lines:string[], fontSize:number}}
 */
export function layoutTitle(title, opts = {}) {
  const maxWidth = opts.maxWidth ?? 960; // 1080px 幅の内側マージンを考慮
  const baseFontSize = opts.baseFontSize ?? 78;
  const minFontSize = opts.minFontSize ?? 44;
  const maxLines = opts.maxLines ?? 3;
  const clean = String(title ?? "").trim();
  if (!clean) return { lines: [""], fontSize: baseFontSize };

  for (let fontSize = baseFontSize; fontSize >= minFontSize; fontSize -= 4) {
    const perLine = Math.max(1, Math.floor(maxWidth / fontSize));
    const lines = wrapByChars(clean, perLine);
    if (lines.length <= maxLines) return { lines, fontSize };
  }
  // 最小サイズでも収まらない場合は最小サイズで maxLines 行に丸める
  const perLine = Math.max(1, Math.floor(maxWidth / minFontSize));
  const lines = wrapByChars(clean, perLine).slice(0, maxLines);
  return { lines, fontSize: minFontSize };
}

/**
 * サロゲートペアを壊さずに perLine 文字ずつ改行する。
 * @param {string} text
 * @param {number} perLine
 * @returns {string[]}
 */
export function wrapByChars(text, perLine) {
  const chars = Array.from(String(text ?? ""));
  const n = Math.max(1, Math.floor(perLine));
  const lines = [];
  for (let i = 0; i < chars.length; i += n) {
    lines.push(chars.slice(i, i + n).join(""));
  }
  return lines.length ? lines : [""];
}

/**
 * VOICEVOX のクエリ並びから「単純連結したときの累積秒」を概算する。
 * WAV のヘッダから求めた各秒数を渡すと累積を返す（テスト用ユーティリティ）。
 * @param {number[]} durations
 * @returns {number}
 */
export function sumDurations(durations) {
  return durations.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
}
