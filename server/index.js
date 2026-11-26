import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import multer from "multer";
import { DIST, OUTPUTS, UPLOADS, ensureDirs, newId, resolveUnder } from "./paths.js";
import { ffmpegAvailable, probe } from "./run-ffmpeg.js";
import {
  addClip,
  loadProject,
  makeClipRecord,
  publicProject,
  reorderTimeline,
  restoreVersion,
} from "./project.js";
import { QUICK_ACTIONS, OP_TYPES, validateOps } from "./schema.js";
import { applyEdits } from "./executor.js";
import { handleChat, mockMode, modelName } from "./chat.js";

ensureDirs();

const app = express();
const PORT = Number(process.env.PORT || 3001);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);

const allowedExt = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".mp4";
    cb(null, `${newId("c")}${allowedExt.has(ext) ? ext : ".mp4"}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = file.mimetype || "";
    if (allowedExt.has(ext) || mime.startsWith("video/")) cb(null, true);
    else cb(new Error("Only video files are accepted (mp4, mov, webm, mkv)"));
  },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    name: "clipwright",
    ffmpeg: await ffmpegAvailable(),
    mockMode: mockMode(),
    model: mockMode() ? "mock" : modelName(),
  });
});

app.get("/api/actions", (_req, res) => {
  res.json({ actions: QUICK_ACTIONS, opTypes: OP_TYPES });
});

app.get("/api/project", (_req, res) => {
  res.json({ project: publicProject(loadProject()) });
});

app.post("/api/upload", upload.array("files", 8), async (req, res, next) => {
  try {
    const project = loadProject();
    const added = [];
    for (const file of req.files || []) {
      const ext = path.extname(file.filename).toLowerCase() || ".mp4";
      const id = path.basename(file.filename, ext);
      const info = await probe(file.path);
      const clip = makeClipRecord({
        id,
        ext,
        originalName: file.originalname,
        probe: info,
      });
      addClip(project, clip);
      added.push(clip);
    }
    res.json({ project: publicProject(project), added: added.map((c) => c.id) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/timeline", (req, res, next) => {
  try {
    const project = reorderTimeline(loadProject(), req.body?.timeline);
    res.json({ project: publicProject(project) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const project = loadProject();
    const { messages, playhead, selectedClipId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages[] is required" });
      return;
    }
    const result = await handleChat({
      project,
      messages,
      playhead: Number.isFinite(Number(playhead)) ? Number(playhead) : undefined,
      selectedClipId: selectedClipId || undefined,
    });
    res.json({
      mode: result.mode,
      reply: result.reply,
      ops: result.ops,
      applied: result.applied,
      error: result.error,
      project: publicProject(result.project),
      version: result.version
        ? {
            id: result.version.id,
            label: result.version.label,
            url: result.version.url,
            duration: result.version.duration,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/ops", async (req, res, next) => {
  try {
    const ops = validateOps(req.body?.ops);
    const result = await applyEdits({
      ops,
      summary: req.body?.summary,
      playhead: Number.isFinite(Number(req.body?.playhead)) ? Number(req.body.playhead) : undefined,
      selectedClipId: req.body?.selectedClipId || undefined,
    });
    res.json({
      project: publicProject(result.project),
      version: result.version
        ? {
            id: result.version.id,
            label: result.version.label,
            url: result.version.url,
            duration: result.version.duration,
          }
        : null,
      notes: result.notes,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/versions/:id/restore", (req, res, next) => {
  try {
    const project = restoreVersion(loadProject(), req.params.id);
    res.json({ project: publicProject(project), currentVersionId: project.currentVersionId });
  } catch (err) {
    next(err);
  }
});

app.get("/api/versions", (_req, res) => {
  const project = loadProject();
  res.json({
    currentVersionId: project.currentVersionId,
    versions: publicProject(project).versions,
  });
});

function sendStored(base, filename, res, next) {
  try {
    const file = resolveUnder(base, filename);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
}

app.get("/media/uploads/:filename", (req, res, next) => sendStored(UPLOADS, req.params.filename, res, next));
app.get("/media/outputs/:filename", (req, res, next) => sendStored(OUTPUTS, req.params.filename, res, next));

if (process.env.NODE_ENV === "production" && fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

app.use((err, _req, res, _next) => {
  const message = err.message || "Server error";
  const status = /too large|File too large/i.test(message)
    ? 413
    : /not found|Invalid|must|needs|unsupported|Add a video|too close|no audio/i.test(message)
      ? 400
      : 500;
  console.error(err);
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Clipwright API on http://localhost:${PORT} (${mockMode() ? "mock mode" : "Grok: " + modelName()})`);
});

export { app, server };
