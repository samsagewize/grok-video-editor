import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, TMP, UPLOADS, OUTPUTS, PROJECTS } from "../server/paths.js";
import { ffmpeg, ffmpegAvailable, probe } from "../server/run-ffmpeg.js";
import { applyEdits } from "../server/executor.js";
import { addClip, loadProject, makeClipRecord, saveProject } from "../server/project.js";
import { parseAndFinalize } from "../server/mock-parser.js";
import { validateOps } from "../server/schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function log(ok, msg) {
  console.log(`${ok ? "ok" : "FAIL"}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (!(await ffmpegAvailable())) {
    console.error("ffmpeg/ffprobe is required for the smoke test");
    process.exit(1);
  }
  ensureDirs();

  const backup = path.join(PROJECTS, "default.json");
  const snapshot = fs.existsSync(backup) ? fs.readFileSync(backup) : null;

  const clipFile = path.join(UPLOADS, "csmoketestclip0001.mp4");
  try {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      clipFile,
    ]);
    const info = await probe(clipFile);
    log(info.duration > 1.5, `generated 2s test clip (${info.duration.toFixed(2)}s)`);

    // Isolate project state for the smoke run.
    saveProject({
      id: "default",
      name: "Smoke",
      clips: [],
      timeline: [],
      currentVersionId: null,
      versions: [],
      updatedAt: new Date().toISOString(),
    });
    const project = loadProject();
    addClip(
      project,
      makeClipRecord({
        id: "csmoketestclip0001",
        ext: ".mp4",
        originalName: "smoke.mp4",
        probe: info,
      })
    );

    const parsed = parseAndFinalize("cut the first 0.5 seconds", { duration: info.duration });
    validateOps(parsed.ops);
    const result = await applyEdits({
      ops: parsed.ops,
      summary: parsed.reply,
      project,
    });
    const dur = result.version?.duration ?? 0;
    log(Boolean(result.version), "applyEdits created a version");
    log(dur > 1.2 && dur < 1.9, `trimmed duration is ${dur.toFixed(2)}s (expected ~1.5s)`);
    const outPath = path.join(OUTPUTS, result.version.filename);
    log(fs.existsSync(outPath), `output exists at storage/outputs/${result.version.filename}`);
  } catch (err) {
    log(false, err.message || String(err));
  } finally {
    try {
      if (fs.existsSync(clipFile)) fs.unlinkSync(clipFile);
    } catch {}
    if (snapshot) fs.writeFileSync(backup, snapshot);
    else if (fs.existsSync(backup)) fs.unlinkSync(backup);
  }

  if (process.exitCode) {
    console.error("Smoke test failed");
    process.exit(1);
  }
  console.log("Smoke test passed");
}

main();
void root;
void TMP;
