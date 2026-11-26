import { spawn } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
    });
  });
}

export function ffmpeg(args, opts) {
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], opts);
}

export function ffprobe(args, opts) {
  return run("ffprobe", ["-v", "error", ...args], opts);
}

export async function probe(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const { stdout } = await ffprobe([
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  const duration = Number(info.format?.duration || video?.duration || 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: video?.width || 0,
    height: video?.height || 0,
    hasAudio: Boolean(audio),
    codec: video?.codec_name || null,
    fps: parseFps(video?.r_frame_rate),
  };
}

function parseFps(rate) {
  if (!rate || typeof rate !== "string") return 30;
  const [a, b] = rate.split("/").map(Number);
  if (!b) return a || 30;
  const fps = a / b;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

export async function ffmpegAvailable() {
  try {
    await run("ffmpeg", ["-version"], { timeoutMs: 8_000 });
    await run("ffprobe", ["-version"], { timeoutMs: 8_000 });
    return true;
  } catch {
    return false;
  }
}
