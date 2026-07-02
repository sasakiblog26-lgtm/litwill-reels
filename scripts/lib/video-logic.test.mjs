import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  escapeDrawText,
  stripEmoji,
  buildTimeline,
  buildRankingSections,
  validateQueue,
  sumDurations,
  layoutTitle,
  wrapByChars,
  voicevoxCreditFor,
  resolveLineSfx,
  SFX_AUTO_FIRST,
  SFX_AUTO_LAST,
  OUTRO_SEC,
} from "./video-logic.mjs";

test("escapeDrawText はコロン・バックスラッシュ・改行を退避する", () => {
  const out = escapeDrawText("a:b\\c\nd");
  assert.ok(out.includes("\\:"), "コロンがエスケープされている");
  assert.ok(out.includes("\\\\"), "バックスラッシュがエスケープされている");
  assert.ok(!out.includes("\n"), "改行は除去されている");
});

test("escapeDrawText はアポストロフィを右シングルクォートへ置換", () => {
  assert.equal(escapeDrawText("it's"), "it’s");
});

test("buildTimeline は実測秒を最優先する", () => {
  const script = [
    { text: "a", duration_hint: 3 },
    { text: "b", duration_hint: 3 },
  ];
  const tl = buildTimeline(script, [2.0, 4.0]);
  assert.equal(tl.lines[0].duration, 2.0);
  assert.equal(tl.lines[1].duration, 4.0);
  assert.equal(tl.lines[0].start, 0);
  assert.equal(tl.lines[1].start, 2.0);
  assert.equal(tl.narrationEnd, 6.0);
  assert.equal(tl.totalDuration, 6.0 + OUTRO_SEC);
});

test("buildTimeline は実測が無ければ duration_hint にフォールバック", () => {
  const script = [{ text: "a", duration_hint: 5 }, { text: "b" }];
  const tl = buildTimeline(script, []);
  assert.equal(tl.lines[0].duration, 5);
  assert.equal(tl.lines[1].duration, 3, "duration_hint 無しは既定3秒");
});

test("buildTimeline は連続する区間が隙間なく連結する", () => {
  const script = [{ text: "a" }, { text: "b" }, { text: "c" }];
  const tl = buildTimeline(script, [1, 2, 3]);
  for (let i = 1; i < tl.lines.length; i++) {
    assert.equal(tl.lines[i].start, tl.lines[i - 1].end, "前の行の end が次の start");
  }
});

test("buildTimeline は空配列で例外", () => {
  assert.throws(() => buildTimeline([], []));
});

test("buildRankingSections は3商品を3位→1位で等分する", () => {
  const sections = buildRankingSections(3, 30);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].rankLabel, "第3位");
  assert.equal(sections[2].rankLabel, "第1位");
  assert.equal(sections[0].start, 0);
  assert.equal(sections[2].end, 30);
});

test("validateQueue は正しい single を通す", () => {
  const data = {
    date: "2026-06-12",
    template: "single",
    products: [{ name: "x", imageUrl: "http://x" }],
    script: [{ text: "a" }],
    caption: "本文 #PR",
  };
  assert.deepEqual(validateQueue(data), { ok: true });
});

test("validateQueue は #PR 欠落を弾く", () => {
  const data = {
    date: "d",
    template: "single",
    products: [{ name: "x", imageUrl: "u" }],
    script: [{ text: "a" }],
    caption: "PRなし本文",
  };
  assert.throws(() => validateQueue(data), /#PR/);
});

test("validateQueue は ranking の件数違反を弾く", () => {
  const data = {
    date: "d",
    template: "ranking",
    products: [{ name: "x", imageUrl: "u" }],
    script: [{ text: "a" }],
    caption: "#PR",
  };
  assert.throws(() => validateQueue(data), /3件/);
});

test("sumDurations は負値や非数を無視して合計する", () => {
  assert.equal(sumDurations([1, 2, -3, NaN, 4]), 7);
});

test("stripEmoji は SMP 絵文字（🔗など）を除去する", () => {
  assert.equal(stripEmoji("詳しくはプロフィールのリンクから🔗"), "詳しくはプロフィールのリンクから");
  assert.equal(stripEmoji("テキスト🎉のみ"), "テキストのみ");
});

test("escapeDrawText は絵文字を含む文字列から絵文字を除去しつつエスケープする", () => {
  const result = escapeDrawText("リンク🔗はこちら:詳細");
  assert.ok(!result.includes("🔗"), "絵文字が除去されている");
  assert.ok(result.includes("\\:"), "コロンがエスケープされている");
  assert.equal(result, "リンクはこちら\\:詳細");
});

// ---- edu テンプレート -------------------------------------------------------

test("validateQueue は正しい edu を通す（title 必須・products 不要・#PR 不要）", () => {
  const data = {
    date: "2026-07-02",
    template: "edu",
    title: "【占い診断の重要性】",
    script: [{ text: "占いは自己理解のツールです" }],
    caption: "占い診断の意義について解説しました。\n\n#占い #Litwillガーデン",
  };
  assert.deepEqual(validateQueue(data), { ok: true });
});

test("validateQueue は edu で products を省略しても通る", () => {
  const data = {
    date: "d",
    template: "edu",
    title: "タイトル",
    script: [{ text: "a" }],
    caption: "本文",
  };
  assert.deepEqual(validateQueue(data), { ok: true });
});

test("validateQueue は edu で title 欠落を弾く", () => {
  const data = {
    date: "d",
    template: "edu",
    script: [{ text: "a" }],
    caption: "本文",
  };
  assert.throws(() => validateQueue(data), /title/);
});

test("validateQueue は edu で products を入れると弾く", () => {
  const data = {
    date: "d",
    template: "edu",
    title: "タイトル",
    products: [{ name: "x", imageUrl: "u" }],
    script: [{ text: "a" }],
    caption: "本文",
  };
  assert.throws(() => validateQueue(data), /products は不要/);
});

test("validateQueue は edu では #PR を要求しない", () => {
  const data = {
    date: "d",
    template: "edu",
    title: "タイトル",
    script: [{ text: "a" }],
    caption: "PRなし本文",
  };
  assert.deepEqual(validateQueue(data), { ok: true });
});

test("validateQueue は未知の template を弾く", () => {
  const data = {
    date: "d",
    template: "unknown",
    script: [{ text: "a" }],
    caption: "本文",
  };
  assert.throws(() => validateQueue(data), /edu/);
});

test("layoutTitle は短いタイトルを1行・基準サイズで返す", () => {
  const { lines, fontSize } = layoutTitle("占い診断");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "占い診断");
  assert.ok(fontSize >= 44 && fontSize <= 78);
});

test("layoutTitle は長いタイトルを複数行に折り、幅内に収める", () => {
  const long = "西洋占星術とインド占星術と四柱推命を統合した鑑定の重要性について";
  const { lines, fontSize } = layoutTitle(long);
  assert.ok(lines.length >= 2, "複数行に分割される");
  assert.ok(lines.length <= 3, "最大3行に収まる");
  // 各行が概算幅 960px を超えない（1文字幅 ≒ fontSize）
  for (const ln of lines) {
    assert.ok(Array.from(ln).length * fontSize <= 960 + fontSize, "行幅が概算内");
  }
});

test("wrapByChars はサロゲートペアを壊さない", () => {
  const out = wrapByChars("🎉🎊🎈🎏", 2);
  assert.deepEqual(out, ["🎉🎊", "🎈🎏"]);
});

test("voicevoxCreditFor は既定(2)で四国めたん、未知idで汎用表記", () => {
  assert.equal(voicevoxCreditFor(2), "VOICEVOX:四国めたん");
  assert.equal(voicevoxCreditFor(3), "VOICEVOX:ずんだもん");
  assert.equal(voicevoxCreditFor(999), "VOICEVOX");
});

// ---- 効果音（SFX） ---------------------------------------------------------

test("validateQueue は script[].sfx が文字列なら通す（空文字可）", () => {
  const data = {
    date: "d",
    template: "edu",
    title: "タイトル",
    script: [{ text: "a", sfx: "Bell Ding" }, { text: "b", sfx: "" }],
    caption: "本文",
  };
  assert.deepEqual(validateQueue(data), { ok: true });
});

test("validateQueue は script[].sfx が非文字列だと弾く", () => {
  const data = {
    date: "d",
    template: "edu",
    title: "タイトル",
    script: [{ text: "a", sfx: 123 }],
    caption: "本文",
  };
  assert.throws(() => validateQueue(data), /sfx は文字列/);
});

test("validateQueue は sfx_auto が boolean なら通し、非booleanを弾く", () => {
  const ok = {
    date: "d",
    template: "edu",
    title: "タイトル",
    sfx_auto: false,
    script: [{ text: "a" }],
    caption: "本文",
  };
  assert.deepEqual(validateQueue(ok), { ok: true });

  const ng = { ...ok, sfx_auto: "yes" };
  assert.throws(() => validateQueue(ng), /sfx_auto は boolean/);
});

test("resolveLineSfx は edu の先頭に Epic Whoosh・末尾に Epic Shine を自動適用", () => {
  const data = {
    template: "edu",
    script: [{ text: "a" }, { text: "b" }, { text: "c" }],
  };
  const got = resolveLineSfx(data);
  assert.deepEqual(got, [SFX_AUTO_FIRST, null, SFX_AUTO_LAST]);
});

test("resolveLineSfx は sfx_auto=false で自動適用しない", () => {
  const data = {
    template: "edu",
    sfx_auto: false,
    script: [{ text: "a" }, { text: "b" }],
  };
  assert.deepEqual(resolveLineSfx(data), [null, null]);
});

test("resolveLineSfx は明示 sfx を自動適用より優先する", () => {
  const data = {
    template: "edu",
    script: [
      { text: "a", sfx: "Magic Effect" }, // 先頭でも明示を優先
      { text: "b", sfx: "Bell Ding" },
      { text: "c" }, // 末尾は自動 Epic Shine
    ],
  };
  assert.deepEqual(resolveLineSfx(data), [
    "Magic Effect",
    "Bell Ding",
    SFX_AUTO_LAST,
  ]);
});

test("resolveLineSfx は空文字指定で自動適用も無効化する", () => {
  const data = {
    template: "edu",
    script: [{ text: "a", sfx: "" }, { text: "b" }, { text: "c", sfx: "  " }],
  };
  // 先頭は空文字で無効、末尾も空白のみ→無効
  assert.deepEqual(resolveLineSfx(data), [null, null, null]);
});

test("resolveLineSfx は edu 以外では自動適用しない（明示のみ有効）", () => {
  const data = {
    template: "single",
    script: [{ text: "a" }, { text: "b", sfx: "POP" }],
  };
  assert.deepEqual(resolveLineSfx(data), [null, "POP"]);
});

test("resolveLineSfx は日本語ファイル名の効果音も返す", () => {
  const data = {
    template: "edu",
    script: [{ text: "a", sfx: "データ表示1" }],
  };
  assert.deepEqual(resolveLineSfx(data), ["データ表示1"]);
});

test("同梱の queue/sample.json はスキーマ検証を通る", async () => {
  const p = path.resolve(import.meta.dirname, "..", "..", "queue", "sample.json");
  const data = JSON.parse(await readFile(p, "utf8"));
  assert.deepEqual(validateQueue(data), { ok: true });
  assert.ok(data.caption.includes("#PR"));
  // ハッシュタグ8個以上
  const tags = data.caption.match(/#[^\s#]+/g) ?? [];
  assert.ok(tags.length >= 8, `ハッシュタグは8個以上、実際 ${tags.length}`);
});
