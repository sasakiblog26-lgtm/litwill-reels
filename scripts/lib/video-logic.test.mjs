import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  escapeDrawText,
  buildTimeline,
  buildRankingSections,
  validateQueue,
  sumDurations,
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

test("同梱の queue/sample.json はスキーマ検証を通る", async () => {
  const p = path.resolve(import.meta.dirname, "..", "..", "queue", "sample.json");
  const data = JSON.parse(await readFile(p, "utf8"));
  assert.deepEqual(validateQueue(data), { ok: true });
  assert.ok(data.caption.includes("#PR"));
  // ハッシュタグ8個以上
  const tags = data.caption.match(/#[^\s#]+/g) ?? [];
  assert.ok(tags.length >= 8, `ハッシュタグは8個以上、実際 ${tags.length}`);
});
