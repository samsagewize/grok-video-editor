import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOp, validateOps } from "../server/schema.js";

test("accepts a valid trim", () => {
  const op = validateOp({ type: "trim", start: 0, end: 5 });
  assert.equal(op.type, "trim");
  assert.equal(op.start, 0);
  assert.equal(op.end, 5);
});

test("rejects unknown ops", () => {
  assert.throws(() => validateOp({ type: "rm -rf /" }), /Unsupported op/);
});

test("rejects shell-like clip ids and path traversal", () => {
  assert.throws(() => validateOp({ type: "mute", clipId: "../etc/passwd" }), /Invalid clipId/);
  assert.throws(() => validateOp({ type: "mute", clipId: "abc;rm -rf" }), /Invalid clipId/);
  assert.throws(() => validateOp({ type: "mute", clipId: "short" }), /Invalid clipId/);
});

test("rejects out-of-range numbers", () => {
  assert.throws(() => validateOp({ type: "speed", factor: 99 }), /0.25/);
  assert.throws(() => validateOp({ type: "trim", start: -1, end: 2 }), /Invalid start/);
  assert.throws(() => validateOp({ type: "blur", strength: 0 }), /1–20/);
});

test("rejects oversized text", () => {
  assert.throws(() => validateOp({ type: "add_text", text: "x".repeat(600) }), /too long/);
});

test("validateOps requires a short non-empty array", () => {
  assert.throws(() => validateOps([]), /non-empty/);
  assert.throws(() => validateOps("trim"), /non-empty/);
  assert.throws(() => validateOps(Array.from({ length: 21 }, () => ({ type: "mute" }))), /too many/);
});

test("crop and fade enums are closed", () => {
  assert.equal(validateOp({ type: "crop_ratio", ratio: "9:16" }).ratio, "9:16");
  assert.throws(() => validateOp({ type: "crop_ratio", ratio: "99:1" }), /ratio/);
  assert.equal(validateOp({ type: "fade", fadeType: "in" }).fadeType, "in");
});
