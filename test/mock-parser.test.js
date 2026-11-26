import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAndFinalize, parseMockCommand } from "../server/mock-parser.js";
import { validateOps } from "../server/schema.js";

test("parses cut the first N seconds", () => {
  const r = parseAndFinalize("cut the first 5 seconds", { duration: 20 });
  assert.deepEqual(r.ops, [{ type: "trim", start: 5, end: 20 }]);
  validateOps(r.ops);
});

test("parses trim first N seconds as keep", () => {
  const keep = parseAndFinalize("trim the first 10 seconds", { duration: 30 });
  assert.equal(keep.ops[0].type, "trim");
  assert.equal(keep.ops[0].start, 0);
  assert.equal(keep.ops[0].end, 10);
});

test("parses trim clip 2 to 10s", () => {
  const ids = ["c111111111111111", "c222222222222222"];
  const r = parseAndFinalize("trim clip 2 to 10s", { duration: 30, timeline: ids });
  assert.equal(r.ops[0].type, "trim");
  assert.equal(r.ops[0].start, 0);
  assert.equal(r.ops[0].end, 10);
  assert.equal(r.ops[0].clipId, ids[1]);
  validateOps(r.ops);
});

test("parses trim from-to and speed, crop, fade, mute", () => {
  const cases = [
    ["trim from 2 to 8", { type: "trim", start: 2, end: 8 }],
    ["speed up", { type: "speed", factor: 1.5 }],
    ["crop to 9:16", { type: "crop_ratio", ratio: "9:16" }],
    ["fade in and out", { type: "fade", fadeType: "both", duration: 0.8 }],
    ["mute the audio", { type: "mute" }],
    ["extract audio", { type: "extract_audio", format: "mp3" }],
    ["convert to grayscale", { type: "grayscale" }],
  ];
  for (const [text, expected] of cases) {
    const r = parseAndFinalize(text, { duration: 15 });
    assert.equal(r.ops.length, 1, text);
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(r.ops[0][k], v, `${text} ${k}`);
    }
    validateOps(r.ops);
  }
});

test("cut at playhead becomes a split", () => {
  const r = parseAndFinalize("cut at the playhead", { playhead: 3.25, duration: 10 });
  assert.deepEqual(r.ops, [{ type: "split", at: 3.25 }]);
  validateOps(r.ops);
});

test("add text with quotes", () => {
  const r = parseMockCommand('add text "Happy Thanksgiving"');
  assert.equal(r.ops[0].type, "add_text");
  assert.equal(r.ops[0].text, "Happy Thanksgiving");
});

test("unknown phrases do not invent ops", () => {
  const r = parseAndFinalize("what's the weather", {});
  assert.equal(r.ops.length, 0);
  assert.match(r.reply, /didn't catch|mock mode/i);
});
