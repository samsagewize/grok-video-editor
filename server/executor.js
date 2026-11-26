import fs from "node:fs";
import path from "node:path";
import { OUTPUTS, TMP, UPLOADS, findFontFile, newId, resolveUnder } from "./paths.js";
import { ffmpeg, probe } from "./run-ffmpeg.js";
import {
  addVersion,
  currentVersion,
  findClip,
  loadProject,
  makeVersionRecord,
  saveProject,
} from "./project.js";
import { validateOps } from "./schema.js";

const FONT = findFontFile();

function clipPath(clip) {
  return resolveUnder(UPLOADS, clip.filename);
}

function versionPath(version) {
  return resolveUnder(OUTPUTS, version.filename);
}

function tmpFile(ext = ".mp4") {
  return path.join(TMP, `${newId("t")}${ext}`);
}

function outFile(id, ext = ".mp4") {
  return path.join(OUTPUTS, `${id}${ext}`);
}

async function transcode(input, output, extraInputArgs, extraOutputArgs) {
  const args = [
    ...(extraInputArgs || []),
    "-i",
    input,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    ...(extraOutputArgs || []),
    output,
  ];
  await ffmpeg(args);
  return probe(output);
}

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 2));
  return v % 2 === 0 ? v : v + 1;
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function srtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

function writeSrt(captions) {
  const file = tmpFile(".srt");
  const body = captions
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

function atempoChain(factor) {
  // atempo only accepts 0.5–2.0; chain filters for other values.
  let remaining = factor;
  const parts = [];
  while (remaining > 2 + 1e-6) {
    parts.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(5)}`);
  return parts.join(",");
}

function targetMedia(project, clipId) {
  if (clipId) {
    const clip = findClip(project, clipId);
    if (!clip) throw new Error("clipId not found");
    return { kind: "clip", path: clipPath(clip), meta: clip };
  }
  const version = currentVersion(project);
  if (version && !version.filename.endsWith(".mp3") && !version.filename.endsWith(".wav")) {
    return { kind: "version", path: versionPath(version), meta: version };
  }
  if (project.timeline.length === 1) {
    const clip = findClip(project, project.timeline[0]);
    if (!clip) throw new Error("Timeline clip missing");
    return { kind: "clip", path: clipPath(clip), meta: clip };
  }
  if (project.timeline.length === 0) throw new Error("Add a video first");
  return { kind: "timeline", path: null, meta: null };
}

async function concatClips(clips, output) {
  if (clips.length === 0) throw new Error("Nothing to merge");
  if (clips.length === 1) {
    const info = await probe(clipPath(clips[0]));
    await transcode(clipPath(clips[0]), output, [], info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]);
    return probe(output);
  }

  const probed = [];
  for (const clip of clips) {
    probed.push({ clip, path: clipPath(clip), info: await probe(clipPath(clip)) });
  }
  const width = even(probed[0].info.width || 1280);
  const height = even(probed[0].info.height || 720);
  const anyAudio = probed.some((p) => p.info.hasAudio);

  const filterParts = [];
  const maps = [];
  probed.forEach((p, i) => {
    const v = `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`;
    filterParts.push(v);
    if (anyAudio) {
      if (p.info.hasAudio) {
        filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
      } else {
        filterParts.push(
          `anullsrc=r=48000:cl=stereo,atrim=0:${Math.max(0.05, p.info.duration || 0.05)},asetpts=PTS-STARTPTS[a${i}]`
        );
      }
      maps.push(`[v${i}][a${i}]`);
    } else {
      maps.push(`[v${i}]`);
    }
  });
  const concat = `${maps.join("")}concat=n=${probed.length}:v=1:a=${anyAudio ? 1 : 0}[outv]${anyAudio ? "[outa]" : ""}`;
  filterParts.push(concat);

  const args = [];
  for (const p of probed) args.push("-i", p.path);
  args.push("-filter_complex", filterParts.join(";"), "-map", "[outv]");
  if (anyAudio) args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "192k");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output
  );
  await ffmpeg(args);
  return probe(output);
}

async function resolveInputPath(project, clipId) {
  const target = targetMedia(project, clipId);
  if (target.path) return { ...target, info: await probe(target.path) };
  const id = newId("v");
  const filename = `${id}.mp4`;
  const output = outFile(id, ".mp4");
  const clips = project.timeline.map((cid) => findClip(project, cid)).filter(Boolean);
  const info = await concatClips(clips, output);
  const record = makeVersionRecord({
    label: "Merged timeline",
    summary: "Merged the timeline so the next edit has a single program to work on.",
    ops: [{ type: "merge", clipIds: project.timeline.slice() }],
    probe: info,
    filename,
    kind: "merge",
    parentId: project.currentVersionId,
  });
  // makeVersionRecord generates its own id — keep filename aligned
  const aligned = { ...record, id, filename, url: `/media/outputs/${filename}` };
  addVersion(project, aligned);
  return { kind: "version", path: output, meta: aligned, info };
}

async function applyMediaOp(op, inputPath, info) {
  const ext = op.type === "extract_audio" ? `.${op.format || "mp3"}` : ".mp4";
  const output = tmpFile(ext);
  const duration = info.duration || 0;

  if (op.type === "trim") {
    const start = op.start || 0;
    const end = op.end != null ? op.end : start + (op.duration || 0);
    if (end <= start) throw new Error("trim end must be after start");
    const extraOut = info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"];
    await transcode(inputPath, output, ["-ss", String(start), "-to", String(end)], extraOut);
    return { output, info: await probe(output) };
  }

  if (op.type === "cut_range") {
    const start = op.start;
    const end = Math.min(op.end, duration);
    if (start <= 0 && end >= duration - 0.05) throw new Error("cut_range would remove the entire clip");
    const parts = [];
    if (start > 0.04) {
      const a = tmpFile(".mp4");
      await transcode(inputPath, a, ["-ss", "0", "-to", String(start)], info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]);
      parts.push(a);
    }
    if (end < duration - 0.04) {
      const b = tmpFile(".mp4");
      await transcode(inputPath, b, ["-ss", String(end)], info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]);
      parts.push(b);
    }
    if (parts.length === 0) throw new Error("cut_range produced an empty result");
    if (parts.length === 1) {
      fs.copyFileSync(parts[0], output);
      return { output, info: await probe(output) };
    }
    // Reuse concat via temporary "clips" is heavy; use concat demuxer since both are just-encoded similarly.
    const list = tmpFile(".txt");
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    await ffmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      output,
    ]);
    return { output, info: await probe(output) };
  }

  if (op.type === "speed") {
    const factor = op.factor;
    const v = `setpts=PTS/${factor}`;
    const extra = ["-vf", v];
    if (info.hasAudio) {
      extra.push("-af", atempoChain(factor), "-c:a", "aac", "-b:a", "192k");
    } else {
      extra.push("-an");
    }
    extra.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    await ffmpeg(["-i", inputPath, ...extra, output]);
    return { output, info: await probe(output) };
  }

  if (op.type === "fade") {
    const d = op.duration;
    const filters = [];
    if (op.fadeType === "in" || op.fadeType === "both") filters.push(`fade=t=in:st=0:d=${d}`);
    if (op.fadeType === "out" || op.fadeType === "both") {
      const st = Math.max(0, duration - d);
      filters.push(`fade=t=out:st=${st}:d=${d}`);
    }
    const extra = ["-vf", filters.join(",")];
    if (info.hasAudio) {
      const af = [];
      if (op.fadeType === "in" || op.fadeType === "both") af.push(`afade=t=in:st=0:d=${d}`);
      if (op.fadeType === "out" || op.fadeType === "both") {
        const st = Math.max(0, duration - d);
        af.push(`afade=t=out:st=${st}:d=${d}`);
      }
      extra.push("-af", af.join(","), "-c:a", "aac", "-b:a", "192k");
    } else extra.push("-an");
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "blur") {
    const s = Math.round(op.strength);
    const extra = ["-vf", `boxblur=${s}:${s}`, ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"])];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "grayscale") {
    const extra = ["-vf", "hue=s=0", ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"])];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "crop_ratio") {
    const [rw, rh] = op.ratio.split(":").map(Number);
    const w = info.width || 1280;
    const h = info.height || 720;
    let cropW = w;
    let cropH = Math.round(w * (rh / rw));
    if (cropH > h) {
      cropH = h;
      cropW = Math.round(h * (rw / rh));
    }
    cropW = even(cropW);
    cropH = even(cropH);
    const vf = `crop=${cropW}:${cropH}:(in_w-${cropW})/2:(in_h-${cropH})/2`;
    const extra = ["-vf", vf, ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"])];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "resize") {
    const extra = [
      "-vf",
      `scale=${even(op.width)}:${even(op.height)}:force_original_aspect_ratio=disable`,
      ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    ];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "mute") {
    await transcode(inputPath, output, [], ["-an"]);
    return { output, info: await probe(output) };
  }

  if (op.type === "volume") {
    if (!info.hasAudio) throw new Error("This video has no audio");
    await transcode(inputPath, output, [], ["-af", `volume=${op.level}`, "-c:a", "aac", "-b:a", "192k"]);
    return { output, info: await probe(output) };
  }

  if (op.type === "extract_audio") {
    if (!info.hasAudio) throw new Error("This video has no audio to extract");
    if (op.format === "wav") {
      await ffmpeg(["-i", inputPath, "-vn", "-acodec", "pcm_s16le", output]);
    } else {
      await ffmpeg(["-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", output]);
    }
    return { output, info: await probe(output) };
  }

  if (op.type === "add_text") {
    if (!FONT) throw new Error("No system font found for text overlays");
    const start = op.start ?? 0;
    const end = op.end ?? duration;
    const fontsize = op.fontsize ?? Math.max(24, Math.round((info.height || 720) / 16));
    const xExpr = op.x == null ? "(w-text_w)/2" : `(w-text_w)*${op.x / 100}`;
    const yExpr = op.y == null ? "h*0.08" : `(h-text_h)*${op.y / 100}`;
    const font = escapeFilterPath(FONT);
    const vf = `drawtext=fontfile='${font}':text='${escapeDrawtext(op.text)}':fontsize=${fontsize}:fontcolor=white:borderw=2:bordercolor=black@0.7:x=${xExpr}:y=${yExpr}:enable='between(t,${start},${end})'`;
    const extra = ["-vf", vf, ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"])];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  if (op.type === "add_captions") {
    const srt = writeSrt(op.captions);
    const vf = `subtitles='${escapeFilterPath(srt)}'`;
    const extra = ["-vf", vf, ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"])];
    await transcode(inputPath, output, [], extra);
    return { output, info: await probe(output) };
  }

  throw new Error(`Unsupported media op: ${op.type}`);
}

async function applySplit(project, op, playhead) {
  const at = op.at ?? playhead;
  if (at == null) throw new Error("split needs a time");
  let clip = op.clipId ? findClip(project, op.clipId) : null;
  if (!clip && project.timeline.length === 1) clip = findClip(project, project.timeline[0]);
  if (!clip) throw new Error("Pick a clip on the timeline to split");
  const info = await probe(clipPath(clip));
  if (at <= 0.05 || at >= info.duration - 0.05) {
    throw new Error("Split time is too close to the start or end of the clip");
  }
  const leftId = newId("c");
  const rightId = newId("c");
  const leftName = `${leftId}${clip.ext || ".mp4"}`;
  const rightName = `${rightId}${clip.ext || ".mp4"}`;
  const leftPath = resolveUnder(UPLOADS, leftName);
  const rightPath = resolveUnder(UPLOADS, rightName);
  const audio = info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"];
  await transcode(clipPath(clip), leftPath, ["-ss", "0", "-to", String(at)], audio);
  await transcode(clipPath(clip), rightPath, ["-ss", String(at)], audio);
  const leftProbe = await probe(leftPath);
  const rightProbe = await probe(rightPath);
  const leftClip = {
    id: leftId,
    ext: ".mp4",
    name: `${clip.name} (a)`,
    originalName: clip.originalName,
    filename: leftName,
    duration: leftProbe.duration,
    width: leftProbe.width,
    height: leftProbe.height,
    hasAudio: leftProbe.hasAudio,
    addedAt: new Date().toISOString(),
  };
  const rightClip = {
    id: rightId,
    ext: ".mp4",
    name: `${clip.name} (b)`,
    originalName: clip.originalName,
    filename: rightName,
    duration: rightProbe.duration,
    width: rightProbe.width,
    height: rightProbe.height,
    hasAudio: rightProbe.hasAudio,
    addedAt: new Date().toISOString(),
  };
  project.clips.push(leftClip, rightClip);
  const idx = project.timeline.indexOf(clip.id);
  if (idx === -1) project.timeline.push(leftClip.id, rightClip.id);
  else project.timeline.splice(idx, 1, leftClip.id, rightClip.id);
  saveProject(project);
  return {
    type: "split",
    message: `Split “${clip.name}” at ${at.toFixed(2)}s into two clips.`,
    clips: [leftClip.id, rightClip.id],
  };
}

async function applyMerge(project, op) {
  const ids = op.clipIds && op.clipIds.length ? op.clipIds : project.timeline;
  const clips = ids.map((id) => findClip(project, id)).filter(Boolean);
  if (clips.length === 0) throw new Error("No clips to merge");
  const id = newId("v");
  const filename = `${id}.mp4`;
  const output = outFile(id, ".mp4");
  const info = await concatClips(clips, output);
  const record = {
    ...makeVersionRecord({
      label: "Merged clips",
      summary: `Merged ${clips.length} clip${clips.length === 1 ? "" : "s"} into one program.`,
      ops: [op],
      probe: info,
      filename,
      kind: "merge",
      parentId: project.currentVersionId,
    }),
    id,
    filename,
    url: `/media/outputs/${filename}`,
  };
  addVersion(project, record);
  return { type: "merge", version: record, message: record.summary };
}

function labelFor(ops, summary) {
  if (summary) return summary.slice(0, 80);
  if (ops.length === 1) {
    const t = ops[0].type.replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return `${ops.length} edits`;
}

export async function applyEdits({ ops, summary, playhead, selectedClipId, project } = {}) {
  const validated = validateOps(ops);
  const proj = project || loadProject();
  if (proj.clips.length === 0) throw new Error("Add a video first");

  const notes = [];
  const mediaOps = [];

  for (const op of validated) {
    if (op.type === "split") {
      const at = op.at ?? playhead;
      notes.push(await applySplit(proj, { ...op, at }, playhead));
    } else if (op.type === "merge") {
      notes.push(await applyMerge(proj, op));
    } else {
      const withClip = op.clipId || selectedClipId;
      mediaOps.push({ ...op, clipId: op.clipId || withClip });
    }
  }

  if (mediaOps.length === 0) {
    return { project: proj, notes, version: currentVersion(proj) };
  }

  // Media ops in one batch share a single input (first op's clip, else program).
  const clipId = mediaOps[0].clipId;
  let { path: inputPath, info } = await resolveInputPath(proj, mediaOps[0].type === "trim" || mediaOps.length ? clipId : undefined);
  // If clipIds differ, still start from first; subsequent ops chain on output.

  let currentPath = inputPath;
  let currentInfo = info;
  const temps = [];
  try {
    for (const op of mediaOps) {
      const result = await applyMediaOp(op, currentPath, currentInfo);
      temps.push(result.output);
      currentPath = result.output;
      currentInfo = result.info;
    }
    const isAudio = currentPath.endsWith(".mp3") || currentPath.endsWith(".wav");
    const ext = isAudio ? path.extname(currentPath) : ".mp4";
    const id = newId("v");
    const filename = `${id}${ext}`;
    const dest = outFile(id, ext);
    fs.copyFileSync(currentPath, dest);
    const finalInfo = await probe(dest);
    const record = {
      ...makeVersionRecord({
        label: labelFor(mediaOps, summary),
        summary: summary || labelFor(mediaOps),
        ops: mediaOps,
        probe: finalInfo,
        filename,
        kind: isAudio ? "audio" : "edit",
        parentId: proj.currentVersionId,
      }),
      id,
      filename,
      url: `/media/outputs/${filename}`,
    };
    addVersion(proj, record);
    notes.push({ type: "edit", version: record, message: record.summary });
    return { project: proj, notes, version: record };
  } finally {
    for (const t of temps) {
      try {
        if (t.startsWith(TMP)) fs.unlinkSync(t);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export { concatClips, applyMediaOp, targetMedia };
