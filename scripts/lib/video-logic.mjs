// 動画合成の純粋ロジック（ffmpeg/VOICEVOX を呼ばずに単体テスト可能な部分）
// build-video.mjs から import して使う。

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const OUTRO_SEC = 1.5; // 末尾の案内クレジット秒数

// 動画の向き（orientation）ごとのレイアウトプリセット。
//  - portrait  … 1080x1920（リール/ショート・従来の縦動画）
//  - landscape … 1920x1080（横動画・YouTube 横長など。IG リールには非対応）
// portrait の各値は build-video.mjs にベタ書きされていた従来値と完全一致させており、
// orientation 省略時（＝portrait）の出力は 1 バイトも変わらない。
export const LAYOUTS = {
  portrait: {
    width: 1080,
    height: 1920,
    subtitle: { fontSize: 52, yExpr: "h-360" },
    rankBadge: { fontSize: 88, y: 220 },
    title: { startY: 340, maxWidth: 960, baseFontSize: 78, minFontSize: 44, maxLines: 3 },
    outro: { ys: [820, 980, 1120], sizes: [50, 64, 34] },
    productName: { yExpr: "h-520", fontSize: 46 },
    image: { wRatio: 0.82, hRatio: 0.5, yOffset: -120 },
  },
  landscape: {
    width: 1920,
    height: 1080,
    subtitle: { fontSize: 48, yExpr: "h-140" },
    rankBadge: { fontSize: 80, y: 90 },
    title: { startY: 140, maxWidth: 1600, baseFontSize: 84, minFontSize: 48, maxLines: 2 },
    outro: { ys: [430, 560, 690], sizes: [48, 64, 32] },
    productName: { yExpr: "h-260", fontSize: 44 },
    image: { wRatio: 0.5, hRatio: 0.62, yOffset: -40 },
  },
};

/**
 * queue JSON の orientation からレイアウトプリセットを解決する。
 * 省略時・未知値は portrait にフォールバックする（後方互換）。
 * @param {any} data queue JSON
 * @returns {typeof LAYOUTS.portrait}
 */
export function resolveLayout(data) {
  const key = data?.orientation ?? "portrait";
  return LAYOUTS[key] ?? LAYOUTS.portrait;
}

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

  // 効果音（SFX）フィールドの検証。既存フィールドの挙動は変えない。
  //  - script[].sfx: string（空文字可・拡張子なしのファイル名）
  //  - sfx_auto: boolean（省略時 true・edu のみ有効）
  if (Array.isArray(data?.script)) {
    for (const [i, row] of data.script.entries()) {
      if (
        row &&
        Object.prototype.hasOwnProperty.call(row, "sfx") &&
        typeof row.sfx !== "string"
      )
        errs.push(`script[${i}].sfx は文字列である必要があります（空文字可）`);
    }
  }
  if (
    data &&
    Object.prototype.hasOwnProperty.call(data, "sfx_auto") &&
    typeof data.sfx_auto !== "boolean"
  )
    errs.push("sfx_auto は boolean である必要があります");

  // 動画の向き（orientation）の検証。省略時は portrait 扱い（既存挙動を変えない）。
  if (
    data &&
    Object.prototype.hasOwnProperty.call(data, "orientation") &&
    data.orientation !== "portrait" &&
    data.orientation !== "landscape"
  )
    errs.push('orientation は "portrait" / "landscape" のいずれかである必要があります');

  if (errs.length) {
    throw new Error("queue JSON 検証エラー:\n - " + errs.join("\n - "));
  }
  return { ok: true };
}

// SFX 自動プリセット（edu テンプレ用）。明示指定のない先頭/末尾行に割り当てる。
export const SFX_AUTO_FIRST = "Epic Whoosh"; // 1行目（つかみ）
export const SFX_AUTO_LAST = "Epic Shine"; // 最終行（締め）

/**
 * script の各行に割り当てる効果音名（拡張子なし）を解決する純粋関数。
 * ffmpeg を呼ばずにテストできるよう、割当ロジックだけをここに切り出す。
 *
 * ルール:
 *  - 行に `sfx` が明示されていれば最優先。
 *    - 非空文字列 → その効果音を使う（自動適用より優先）。
 *    - 空文字（トリム後に空） → その行は効果音なし＝**無効化**（自動適用もしない）。
 *  - `sfx` 未指定かつ edu テンプレかつ `sfx_auto`（省略時 true）が有効なら、
 *    1行目に SFX_AUTO_FIRST、最終行に SFX_AUTO_LAST を自動適用。
 *  - それ以外は null（効果音なし）。
 *
 * @param {any} data queue JSON
 * @returns {(string|null)[]} script と同じ並びの効果音名 or null
 */
export function resolveLineSfx(data) {
  const script = Array.isArray(data?.script) ? data.script : [];
  const n = script.length;
  const isEdu = data?.template === "edu";
  const autoOn = isEdu && data?.sfx_auto !== false; // 省略時 true・edu のみ
  return script.map((row, i) => {
    if (row && Object.prototype.hasOwnProperty.call(row, "sfx")) {
      const v = typeof row.sfx === "string" ? row.sfx.trim() : "";
      return v.length ? v : null; // 空文字は無効化（自動適用もしない）
    }
    if (autoOn) {
      if (i === 0) return SFX_AUTO_FIRST;
      if (i === n - 1) return SFX_AUTO_LAST;
    }
    return null;
  });
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
