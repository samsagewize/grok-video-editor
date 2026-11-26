/**
 * Keyword parser used when XAI_API_KEY is not set.
 * It is intentionally simple so the editor still runs end-to-end without a key.
 * It produces the same validated op objects that Grok's tool calls would.
 */

function numFrom(text, patterns, fallback) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

export function parseMockCommand(text, context = {}) {
  const raw = String(text || "").trim();
  const q = raw.toLowerCase();
  const playhead = Number(context.playhead);
  const hasPlayhead = Number.isFinite(playhead) && playhead >= 0;

  if (!q) return { ops: [], reply: "Tell me what you'd like to change — or tap one of the actions above." };

  if (/\b(merge|combine|join|concatenate)\b/.test(q) && /\b(clip|timeline|video|all)\b/.test(q)) {
    return { ops: [{ type: "merge" }], reply: "I'll merge the clips on the timeline into one program." };
  }

  if (/\b(extract|export|rip)\b.*\b(audio|mp3|wav|sound)\b/.test(q) || /\b(audio|mp3|wav)\b.*\b(extract|export)\b/.test(q)) {
    const format = /\bwav\b/.test(q) ? "wav" : "mp3";
    return { ops: [{ type: "extract_audio", format }], reply: `I'll extract the audio as ${format}.` };
  }

  if (/\bmute\b|\bsilence\b|\bremove (the )?audio\b/.test(q)) {
    return { ops: [{ type: "mute" }], reply: "I'll mute the audio." };
  }

  if (/\bvolume\b|\blouder\b|\bquieter\b/.test(q)) {
    let level = numFrom(q, [/\bvolume(?:\s+to|\s+at)?\s+(\d+(?:\.\d+)?)/], null);
    if (level == null && /\blouder\b/.test(q)) level = 1.5;
    if (level == null && /\bquieter\b/.test(q)) level = 0.5;
    if (level == null) level = 1;
    return { ops: [{ type: "volume", level }], reply: `I'll set the volume to ${level}.` };
  }

  if (/\bgray(?:scale)?\b|\bblack and white\b|\bmonochrome\b/.test(q)) {
    return { ops: [{ type: "grayscale" }], reply: "I'll convert it to grayscale." };
  }

  if (/\bblur\b/.test(q)) {
    const strength = numFrom(q, [/\bblur(?:\s+(?:of|to|by))?\s+(\d+)/, /\bstrength\s+(\d+)/], 4);
    return { ops: [{ type: "blur", strength }], reply: `I'll blur the picture (strength ${strength}).` };
  }

  if (/\b9\s*[x:]\s*16\b|\bvertical\b|\bportrait\b/.test(q) && /\b(crop|resize|frame|aspect|make)\b/.test(q) || /\bcrop(?:ped)? to 9/.test(q)) {
    return { ops: [{ type: "crop_ratio", ratio: "9:16" }], reply: "I'll crop it to 9:16." };
  }
  if (/\b16\s*[x:]\s*9\b|\blandscape\b/.test(q) && /\b(crop|resize|aspect)\b/.test(q)) {
    return { ops: [{ type: "crop_ratio", ratio: "16:9" }], reply: "I'll crop it to 16:9." };
  }
  if (/\bsquare\b|\b1\s*[x:]\s*1\b/.test(q) && /\b(crop|resize|aspect)\b/.test(q)) {
    return { ops: [{ type: "crop_ratio", ratio: "1:1" }], reply: "I'll crop it to a square." };
  }
  if (/\bcrop to 9:16\b|\bcrop to 9 x 16\b/.test(q)) {
    return { ops: [{ type: "crop_ratio", ratio: "9:16" }], reply: "I'll crop it to 9:16." };
  }

  if (/\bresize\b/.test(q)) {
    const m = q.match(/(\d{2,4})\s*[x×]\s*(\d{2,4})/);
    if (m) {
      return {
        ops: [{ type: "resize", width: Number(m[1]), height: Number(m[2]) }],
        reply: `I'll resize it to ${m[1]}×${m[2]}.`,
      };
    }
  }

  if (/\bfade\b/.test(q)) {
    let fadeType = "both";
    const both = /\bin and out\b/.test(q) || (/\bfade in\b/.test(q) && /\bfade out\b/.test(q));
    if (both) fadeType = "both";
    else if (/\bfade in\b/.test(q)) fadeType = "in";
    else if (/\bfade out\b/.test(q)) fadeType = "out";
    const duration = numFrom(q, [/\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/], 0.8);
    return { ops: [{ type: "fade", fadeType, duration }], reply: `I'll add a fade (${fadeType}).` };
  }

  if (/\b(speed up|faster|1\.5x|1\.5×|speed to|playback speed|slow(?:er)? down)\b/.test(q) || /\bspeed\b/.test(q)) {
    let factor = numFrom(q, [/(\d+(?:\.\d+)?)\s*x\b/, /\bspeed(?:\s+up)?(?:\s+to)?\s+(\d+(?:\.\d+)?)/], null);
    if (factor == null && /\bslow/.test(q)) factor = 0.5;
    if (factor == null) factor = 1.5;
    return { ops: [{ type: "speed", factor }], reply: `I'll change the speed to ${factor}×.` };
  }

  if (/\b(add )?(captions?|subtitles?|title|text overlay)\b|\badd text\b|\boverlay text\b/.test(q)) {
    const quoted = raw.match(/[“"]([^”"]+)[”"]/) || raw.match(/[‘']([^’']+)[’']/);
    const text = quoted ? quoted[1] : null;
    if (text) {
      return { ops: [{ type: "add_text", text }], reply: `I'll add the text “${text}”.` };
    }
    if (/\bcaptions?\b|\bsubtitles?\b/.test(q)) {
      return {
        ops: [],
        reply: "What should the captions say? For a title, try: add text \"Your words here\".",
      };
    }
    return { ops: [], reply: "What text should I add? Try: add text \"Your words here\"." };
  }

  if (/\bsplit\b/.test(q)) {
    const at = numFrom(q, [/\bat\s+(\d+(?:\.\d+)?)/, /\b(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/], hasPlayhead ? playhead : null);
    if (at == null) return { ops: [], reply: "Where should I split? Give a time, or move the playhead and say split again." };
    return { ops: [{ type: "split", at }], reply: `I'll split the clip at ${at}s.` };
  }

  if (/\bcut (it |the (clip |video )?)?(at|on) (the )?playhead\b/.test(q) || /\bcut at the playhead\b/.test(q)) {
    if (!hasPlayhead) return { ops: [], reply: "I need a playhead time to cut there." };
    return { ops: [{ type: "split", at: playhead }], reply: `I'll cut the clip at the playhead (${playhead.toFixed(2)}s).` };
  }

  // "cut / remove the first N seconds"
  const first = q.match(/\b(?:cut|remove|drop|trim off|take off|delete)\b.{0,24}\bfirst\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?/);
  if (first) {
    const n = Number(first[1]);
    return { ops: [{ type: "trim", start: n, end: 60 * 60 * 12 }], reply: `I'll cut the first ${n} seconds.` };
  }
  const last = q.match(/\b(?:cut|remove|drop|trim off|take off|delete)\b.{0,24}\blast\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?/);
  if (last) {
    return { ops: [], reply: `I'll drop the last ${last[1]} seconds — applying a trim to everything except that tail.` , pendingLast: Number(last[1]) };
  }

  // trim first N seconds (keep)
  const keepFirst = q.match(/\b(?:trim|keep)\b.{0,20}\bfirst\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?/);
  if (keepFirst) {
    const n = Number(keepFirst[1]);
    return { ops: [{ type: "trim", start: 0, end: n }], reply: `I'll keep the first ${n} seconds.` };
  }
  // "trim clip 2 to 10s" / "trim to 10s" — keep the first N seconds (optionally of a numbered clip)
  const trimTo = q.match(/\btrim(?:\s+clip\s+(\d+))?\s+to\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/);
  if (trimTo) {
    const end = Number(trimTo[2]);
    const clipNo = trimTo[1] ? Number(trimTo[1]) : null;
    const op = { type: "trim", start: 0, end };
    if (clipNo && Array.isArray(context.timeline) && context.timeline[clipNo - 1]) {
      op.clipId = context.timeline[clipNo - 1];
    }
    const which = clipNo ? ` clip ${clipNo}` : "";
    return { ops: [op], reply: `I'll trim${which} to the first ${end} seconds.` };
  }
  const fromTo = q.match(/\btrim\b.{0,16}\bfrom\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\s*(?:to|-|–|through)\s*(\d+(?:\.\d+)?)/);
  if (fromTo) {
    return {
      ops: [{ type: "trim", start: Number(fromTo[1]), end: Number(fromTo[2]) }],
      reply: `I'll trim from ${fromTo[1]}s to ${fromTo[2]}s.`,
    };
  }
  if (/\btrim\b/.test(q) && hasPlayhead && /\bplayhead\b|\bhere\b/.test(q)) {
    if (/\bafter\b|\bonward\b/.test(q)) {
      return { ops: [{ type: "trim", start: playhead, end: 60 * 60 * 12 }], reply: "I'll keep everything from the playhead onward." };
    }
    return { ops: [{ type: "trim", start: 0, end: playhead }], reply: "I'll keep everything up to the playhead." };
  }

  if (/\bcut\b/.test(q) && hasPlayhead && /\bplayhead\b/.test(q)) {
    return { ops: [{ type: "split", at: playhead }], reply: `I'll cut at the playhead (${playhead.toFixed(2)}s).` };
  }

  if (/\bhelp\b|\bwhat can you do\b/.test(q)) {
    return {
      ops: [],
      reply:
        "I can trim, cut or split at the playhead, merge clips, change speed, add text or captions, fade, blur, convert to grayscale, crop to 9:16, mute, or extract audio. Say it in plain language, or tap an action above.",
    };
  }

  return {
    ops: [],
    reply:
      "I didn't catch a specific edit in mock mode (no xAI key is set). Try things like “cut the first 5 seconds”, “speed up”, “crop to 9:16”, “fade in and out”, or tap one of the actions above.",
  };
}

/** Post-process ops that need media duration (e.g. drop last N seconds, trim with open end). */
export function finalizeMockOps(ops, duration) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) return ops;
  return ops.map((op) => {
    if (op.type === "trim" && op.end != null && op.end > dur) {
      return { ...op, end: dur };
    }
    return op;
  });
}

export function parseAndFinalize(text, context = {}) {
  const parsed = parseMockCommand(text, context);
  let ops = parsed.ops || [];
  if (parsed.pendingLast && Number.isFinite(context.duration)) {
    const end = Math.max(0, context.duration - parsed.pendingLast);
    ops = [{ type: "trim", start: 0, end }];
    parsed.reply = `I'll drop the last ${parsed.pendingLast} seconds.`;
  }
  if (Number.isFinite(context.duration)) ops = finalizeMockOps(ops, context.duration);
  return { ...parsed, ops };
}
