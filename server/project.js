import fs from "node:fs";
import path from "node:path";
import { PROJECTS, newId } from "./paths.js";

const FILE = path.join(PROJECTS, "default.json");

function emptyProject() {
  return {
    id: "default",
    name: "Untitled project",
    clips: [],
    timeline: [],
    currentVersionId: null,
    versions: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadProject() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.clips)) return emptyProject();
    return data;
  } catch {
    return emptyProject();
  }
}

export function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  fs.mkdirSync(PROJECTS, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
  fs.renameSync(tmp, FILE);
  return project;
}

export function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    clips: project.clips.map(publicClip),
    timeline: project.timeline,
    currentVersionId: project.currentVersionId,
    versions: project.versions.map(publicVersion),
    updatedAt: project.updatedAt,
  };
}

export function publicClip(clip) {
  return {
    id: clip.id,
    name: clip.name,
    originalName: clip.originalName,
    duration: clip.duration,
    width: clip.width,
    height: clip.height,
    hasAudio: clip.hasAudio,
    url: `/media/uploads/${clip.id}${clip.ext}`,
    addedAt: clip.addedAt,
  };
}

export function publicVersion(version) {
  return {
    id: version.id,
    label: version.label,
    summary: version.summary,
    ops: version.ops || [],
    kind: version.kind,
    duration: version.duration,
    width: version.width,
    height: version.height,
    hasAudio: version.hasAudio,
    url: version.url,
    createdAt: version.createdAt,
    parentId: version.parentId || null,
  };
}

export function findClip(project, clipId) {
  return project.clips.find((c) => c.id === clipId) || null;
}

export function addClip(project, clip) {
  project.clips.push(clip);
  project.timeline.push(clip.id);
  return saveProject(project);
}

export function reorderTimeline(project, ids) {
  if (!Array.isArray(ids) || ids.length !== project.timeline.length) {
    throw new Error("timeline must include every current clip id once");
  }
  const current = new Set(project.timeline);
  const next = new Set(ids);
  if (current.size !== next.size || [...current].some((id) => !next.has(id))) {
    throw new Error("timeline must include every current clip id once");
  }
  project.timeline = ids;
  return saveProject(project);
}

export function addVersion(project, version) {
  project.versions.push(version);
  project.currentVersionId = version.id;
  return saveProject(project);
}

export function restoreVersion(project, versionId) {
  const version = project.versions.find((v) => v.id === versionId);
  if (!version) throw new Error("Version not found");
  project.currentVersionId = version.id;
  return saveProject(project);
}

export function currentVersion(project) {
  if (!project.currentVersionId) return null;
  return project.versions.find((v) => v.id === project.currentVersionId) || null;
}

export function makeClipRecord({ id, ext, originalName, probe }) {
  const base = (originalName || "clip").replace(/\.[^.]+$/, "");
  return {
    id,
    ext,
    name: base,
    originalName: originalName || `${id}${ext}`,
    filename: `${id}${ext}`,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
    addedAt: new Date().toISOString(),
  };
}

export function makeVersionRecord({ label, summary, ops, probe, filename, kind, parentId }) {
  const id = newId("v");
  const ext = path.extname(filename) || ".mp4";
  return {
    id,
    label: label || "Edit",
    summary: summary || label || "Edit",
    ops: ops || [],
    kind: kind || "edit",
    filename,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
    url: `/media/outputs/${id}${ext}`,
    createdAt: new Date().toISOString(),
    parentId: parentId || null,
  };
}
