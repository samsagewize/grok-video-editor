import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { ffmpeg, probe } from "../server/run-ffmpeg.js";
import { applyMediaOp } from "../server/executor.js";
import { validateOp } from "../server/schema.js";

let dir;
let source;

async function makeClip(name, seconds = 2, size = "320x240") {
  const file = path.join(dir, name);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${size}:rate=30:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  return file;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwe-"));
  source = await makeClip("src.mp4", 2);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("trim a generated testsrc clip to about 1 second", async () => {
  const op = validateOp({ type: "trim", start: 0, end: 1 });
  const info = await probe(source);
  const { output, info: out } = await applyMediaOp(op, source, info);
  assert.ok(fs.existsSync(output));
  assert.ok(out.duration > 0.7 && out.duration < 1.4, `duration ${out.duration}`);
});

test("grayscale keeps dimensions", async () => {
  const op = validateOp({ type: "grayscale" });
  const info = await probe(source);
  const { info: out } = await applyMediaOp(op, source, info);
  assert.equal(out.width, info.width);
  assert.equal(out.height, info.height);
});

test("crop to 9:16 produces a taller frame", async () => {
  const wide = await makeClip("wide.mp4", 1, "640x360");
  const info = await probe(wide);
  const op = validateOp({ type: "crop_ratio", ratio: "9:16" });
  const { info: out } = await applyMediaOp(op, wide, info);
  const ratio = out.width / out.height;
  assert.ok(Math.abs(ratio - 9 / 16) < 0.05, `ratio ${ratio}`);
});

test("mute removes audio", async () => {
  const info = await probe(source);
  assert.equal(info.hasAudio, true);
  const { info: out } = await applyMediaOp(validateOp({ type: "mute" }), source, info);
  assert.equal(out.hasAudio, false);
});

test("speed 2x shortens duration", async () => {
  const info = await probe(source);
  const { info: out } = await applyMediaOp(validateOp({ type: "speed", factor: 2 }), source, info);
  assert.ok(out.duration < info.duration * 0.7, `got ${out.duration} from ${info.duration}`);
});
