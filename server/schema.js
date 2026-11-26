/** Shared edit-operation schema. Used by Grok tool-calling, the mock parser, chips, and the executor. */

export const OP_TYPES = [
  "trim",
  "cut_range",
  "split",
  "merge",
  "speed",
  "add_text",
  "add_captions",
  "fade",
  "blur",
  "grayscale",
  "crop_ratio",
  "resize",
  "mute",
  "extract_audio",
  "volume",
];

export const CROP_RATIOS = ["9:16", "16:9", "1:1", "4:5", "4:3"];
export const FADE_TYPES = ["in", "out", "both"];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "apply_edits",
      description:
        "Apply one or more validated video edit operations to the current project. Use clip IDs and times from the provided project state. Do not invent file paths.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            description: "Short plain-language description of what these edits do.",
          },
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { $ref: "#/definitions/op" },
            description: "Ordered list of edit operations to apply.",
          },
        },
        required: ["ops"],
      },
    },
  },
];

/** JSON Schema-ish documentation for each op, also used to build prompts. */
export const OP_DOCS = {
  trim: "Keep only the range from start to end (seconds) of the target clip or current program.",
  cut_range: "Remove the range from start to end and close the gap.",
  split: "Split the target clip at time `at` (seconds) into two clips on the timeline.",
  merge: "Concatenate the given clipIds (or the whole timeline if omitted) into a new program version.",
  speed: "Change playback speed by factor (e.g. 1.5 is faster, 0.5 is slower). Range 0.25–4.",
  add_text: "Overlay a single text title. Optional start/end in seconds, fontsize, and position x,y as percentages 0–100.",
  add_captions: "Burn in captions: [{text, start, end}, ...].",
  fade: "Fade type: in, out, or both. duration in seconds (default 0.8).",
  blur: "Box blur. strength 1–20 (default 4).",
  grayscale: "Convert the picture to grayscale.",
  crop_ratio: "Center-crop (and scale) to ratio 9:16, 16:9, 1:1, 4:5, or 4:3.",
  resize: "Scale to width and height in pixels (even numbers, 16–3840).",
  mute: "Remove or silence the audio track.",
  extract_audio: "Export audio only as mp3 or wav (format default mp3).",
  volume: "Set audio volume. level 0–4, where 1 is unchanged.",
};

export const QUICK_ACTIONS = [
  { id: "trim", label: "Trim", prompt: "Trim the current video — tell me the start and end times if you have them, otherwise I'll ask." },
  { id: "cut_playhead", label: "Cut at playhead", prompt: "Cut the current video at the playhead." },
  { id: "split", label: "Split", prompt: "Split the current clip at the playhead." },
  { id: "merge", label: "Merge clips", prompt: "Merge all clips on the timeline into one program." },
  { id: "speed", label: "Speed up", prompt: "Speed the current video up to 1.5x." },
  { id: "captions", label: "Add captions", prompt: "Add captions — I'll use any text I already have, or ask what to write." },
  { id: "fade", label: "Fade in/out", prompt: "Add a fade in and fade out." },
  { id: "crop", label: "Crop to 9:16", prompt: "Crop the current video to 9:16." },
  { id: "mute", label: "Mute", prompt: "Mute the audio." },
  { id: "extract_audio", label: "Extract audio", prompt: "Extract the audio from the current video." },
];

function isNum(n, min, max) {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function optionalId(id) {
  if (id == null || id === "") return undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new Error("Invalid clipId");
  }
  return id;
}

function finiteTime(n, label) {
  if (!isNum(n, 0, 60 * 60 * 12)) throw new Error(`Invalid ${label}`);
  return n;
}

export function validateOp(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Each op must be an object");
  }
  const type = raw.type;
  if (!OP_TYPES.includes(type)) {
    throw new Error(`Unsupported op: ${String(type)}`);
  }

  const op = { type, clipId: optionalId(raw.clipId) };

  switch (type) {
    case "trim": {
      const start = finiteTime(Number(raw.start ?? 0), "start");
      const end = raw.end == null ? undefined : finiteTime(Number(raw.end), "end");
      const duration = raw.duration == null ? undefined : finiteTime(Number(raw.duration), "duration");
      if (end == null && duration == null) throw new Error("trim needs end or duration");
      if (end != null && end <= start) throw new Error("trim end must be after start");
      op.start = start;
      if (end != null) op.end = end;
      if (duration != null) op.duration = duration;
      break;
    }
    case "cut_range": {
      op.start = finiteTime(Number(raw.start), "start");
      op.end = finiteTime(Number(raw.end), "end");
      if (op.end <= op.start) throw new Error("cut_range end must be after start");
      break;
    }
    case "split": {
      op.at = finiteTime(Number(raw.at), "at");
      break;
    }
    case "merge": {
      if (raw.clipIds != null) {
        if (!Array.isArray(raw.clipIds) || raw.clipIds.length < 1) {
          throw new Error("merge clipIds must be a non-empty array");
        }
        op.clipIds = raw.clipIds.map((id) => optionalId(id));
      }
      break;
    }
    case "speed": {
      const factor = Number(raw.factor);
      if (!isNum(factor, 0.25, 4)) throw new Error("speed factor must be 0.25–4");
      op.factor = factor;
      break;
    }
    case "add_text": {
      if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
        throw new Error("add_text needs text");
      }
      if (raw.text.length > 500) throw new Error("text is too long");
      op.text = raw.text.trim();
      if (raw.start != null) op.start = finiteTime(Number(raw.start), "start");
      if (raw.end != null) op.end = finiteTime(Number(raw.end), "end");
      if (raw.fontsize != null) {
        const fs = Number(raw.fontsize);
        if (!isNum(fs, 8, 240)) throw new Error("fontsize must be 8–240");
        op.fontsize = fs;
      }
      if (raw.x != null) {
        const x = Number(raw.x);
        if (!isNum(x, 0, 100)) throw new Error("x must be 0–100");
        op.x = x;
      }
      if (raw.y != null) {
        const y = Number(raw.y);
        if (!isNum(y, 0, 100)) throw new Error("y must be 0–100");
        op.y = y;
      }
      break;
    }
    case "add_captions": {
      if (!Array.isArray(raw.captions) || raw.captions.length === 0) {
        throw new Error("add_captions needs captions[]");
      }
      if (raw.captions.length > 200) throw new Error("too many captions");
      op.captions = raw.captions.map((c, i) => {
        if (!c || typeof c.text !== "string" || !c.text.trim()) {
          throw new Error(`caption ${i} needs text`);
        }
        if (c.text.length > 500) throw new Error(`caption ${i} is too long`);
        return {
          text: c.text.trim(),
          start: finiteTime(Number(c.start), `caption ${i} start`),
          end: finiteTime(Number(c.end), `caption ${i} end`),
        };
      });
      break;
    }
    case "fade": {
      const fadeType = raw.fadeType || raw.mode || "both";
      if (!FADE_TYPES.includes(fadeType)) throw new Error("fade type must be in, out, or both");
      op.fadeType = fadeType;
      const duration = raw.duration == null ? 0.8 : Number(raw.duration);
      if (!isNum(duration, 0.05, 30)) throw new Error("fade duration must be 0.05–30");
      op.duration = duration;
      break;
    }
    case "blur": {
      const strength = raw.strength == null ? 4 : Number(raw.strength);
      if (!isNum(strength, 1, 20)) throw new Error("blur strength must be 1–20");
      op.strength = strength;
      break;
    }
    case "grayscale":
      break;
    case "crop_ratio": {
      const ratio = raw.ratio || "9:16";
      if (!CROP_RATIOS.includes(ratio)) throw new Error(`ratio must be one of ${CROP_RATIOS.join(", ")}`);
      op.ratio = ratio;
      break;
    }
    case "resize": {
      const width = Number(raw.width);
      const height = Number(raw.height);
      if (!isNum(width, 16, 3840) || !isNum(height, 16, 3840)) {
        throw new Error("resize width/height must be 16–3840");
      }
      op.width = Math.round(width / 2) * 2;
      op.height = Math.round(height / 2) * 2;
      break;
    }
    case "mute":
      break;
    case "extract_audio": {
      const format = raw.format || "mp3";
      if (!["mp3", "wav"].includes(format)) throw new Error("extract_audio format must be mp3 or wav");
      op.format = format;
      break;
    }
    case "volume": {
      const level = Number(raw.level);
      if (!isNum(level, 0, 4)) throw new Error("volume level must be 0–4");
      op.level = level;
      break;
    }
    default:
      throw new Error(`Unsupported op: ${type}`);
  }

  return op;
}

export function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("ops must be a non-empty array");
  if (ops.length > 20) throw new Error("too many ops (max 20)");
  return ops.map(validateOp);
}
