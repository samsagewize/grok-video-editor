import { TOOLS, OP_DOCS, validateOps } from "./schema.js";
import { currentVersion, publicProject } from "./project.js";
import { parseAndFinalize } from "./mock-parser.js";
import { applyEdits } from "./executor.js";

export function mockMode() {
  return !String(process.env.XAI_API_KEY || "").trim();
}

export function modelName() {
  return process.env.XAI_MODEL || "grok-4";
}

export function apiBase() {
  return (process.env.XAI_API_BASE || "https://api.x.ai/v1").replace(/\/$/, "");
}

function programDuration(project) {
  const version = currentVersion(project);
  if (version) return version.duration;
  return project.timeline.reduce((sum, id) => {
    const clip = project.clips.find((c) => c.id === id);
    return sum + (clip?.duration || 0);
  }, 0);
}

function systemPrompt(project, context) {
  const state = publicProject(project);
  const duration = programDuration(project);
  return [
    "You are the editing assistant inside Clipwright, a Grok-powered video editor.",
    "The user talks to you in the editor in natural language, or taps ready-made action chips.",
    "You apply edits only by calling the apply_edits tool with the documented operation schema.",
    "Never invent file paths or suggest shell commands. Use clip IDs and times from the project state.",
    "Times are in seconds. The playhead is the current position in the preview player.",
    "If the request is ambiguous, ask a brief question instead of guessing destructive edits.",
    "After tools run, confirm what changed in one or two short sentences. Do not promise features you cannot apply.",
    "",
    "Supported operations:",
    ...Object.entries(OP_DOCS).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "Current project state (JSON):",
    JSON.stringify(
      {
        clips: state.clips,
        timeline: state.timeline,
        currentVersionId: state.currentVersionId,
        versions: state.versions.map((v) => ({
          id: v.id,
          label: v.label,
          duration: v.duration,
          createdAt: v.createdAt,
        })),
        playhead: context.playhead ?? null,
        selectedClipId: context.selectedClipId ?? null,
        programDuration: duration,
      },
      null,
      2
    ),
  ].join("\n");
}

async function durationContext(project, context) {
  const duration = context.duration ?? programDuration(project);
  return { ...context, duration, timeline: project.timeline || [] };
}

export async function handleChat({ project, messages, playhead, selectedClipId }) {
  const context = await durationContext(project, { playhead, selectedClipId });
  const userText = [...(messages || [])].reverse().find((m) => m.role === "user")?.content || "";

  if (mockMode()) {
    const parsed = parseAndFinalize(userText, context);
    let applied = null;
    let error = null;
    if (parsed.ops.length) {
      try {
        validateOps(parsed.ops);
        applied = await applyEdits({
          ops: parsed.ops,
          summary: parsed.reply,
          playhead: context.playhead,
          selectedClipId: context.selectedClipId,
          project,
        });
      } catch (err) {
        error = err.message || String(err);
      }
    }
    const reply = error
      ? `I understood the edit, but couldn't apply it: ${error}`
      : parsed.reply;
    return {
      mode: "mock",
      reply,
      ops: parsed.ops,
      applied: Boolean(applied && !error),
      error,
      project: applied?.project || project,
      version: applied?.version || null,
    };
  }

  return callGrok({ project, messages, context });
}

async function callGrok({ project, messages, context }) {
  const body = {
    model: modelName(),
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt(project, context) },
      ...(messages || [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const res = await fetch(`${apiBase()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI request failed (${res.status}): ${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error("xAI returned no message");

  const toolCalls = choice.tool_calls || [];
  const applyCall = toolCalls.find((c) => (c.function?.name || c.name) === "apply_edits");

  if (!applyCall) {
    return {
      mode: "grok",
      reply: choice.content || "What would you like to change?",
      ops: [],
      applied: false,
      error: null,
      project,
      version: null,
    };
  }

  let parsedArgs;
  try {
    const argText = applyCall.function?.arguments || applyCall.arguments || "{}";
    parsedArgs = JSON.parse(argText);
  } catch {
    throw new Error("Grok returned invalid tool arguments");
  }

  const ops = validateOps(parsedArgs.ops || []);
  const summary = typeof parsedArgs.summary === "string" ? parsedArgs.summary : choice.content;
  const applied = await applyEdits({
    ops,
    summary,
    playhead: context.playhead,
    selectedClipId: context.selectedClipId,
    project,
  });

  // One follow-up turn so Grok can confirm, without granting more tools.
  let reply = summary || "Done.";
  try {
    const follow = await fetch(`${apiBase()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelName(),
        temperature: 0.2,
        messages: [
          { role: "system", content: "Confirm the applied edits in one or two short sentences. No tools." },
          ...body.messages.slice(1),
          choice,
          {
            role: "tool",
            tool_call_id: applyCall.id,
            content: JSON.stringify({
              ok: true,
              summary,
              ops,
              version: applied.version
                ? { id: applied.version.id, url: applied.version.url, duration: applied.version.duration }
                : null,
              notes: applied.notes,
            }),
          },
        ],
      }),
    });
    if (follow.ok) {
      const followData = await follow.json();
      reply = followData.choices?.[0]?.message?.content || reply;
    }
  } catch {
    // The edit already applied; keep the summary if the follow-up fails.
  }

  return {
    mode: "grok",
    reply,
    ops,
    applied: true,
    error: null,
    project: applied.project,
    version: applied.version || null,
  };
}

