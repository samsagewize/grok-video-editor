import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ROOT = root;
export const STORAGE = path.join(root, "storage");
export const UPLOADS = path.join(STORAGE, "uploads");
export const OUTPUTS = path.join(STORAGE, "outputs");
export const TMP = path.join(STORAGE, "tmp");
export const PROJECTS = path.join(STORAGE, "projects");
export const DIST = path.join(root, "dist");

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
];

export function ensureDirs() {
  for (const dir of [UPLOADS, OUTPUTS, TMP, PROJECTS]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function findFontFile() {
  return FONT_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

/** IDs may only be short slug-safe tokens. Never accept raw paths from the client or model. */
export function assertSafeId(id, label = "id") {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new Error(`Invalid ${label}`);
  }
  return id;
}

export function resolveUnder(base, filename) {
  const resolved = path.resolve(base, filename);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes storage");
  }
  return resolved;
}

export function newId(prefix = "") {
  const raw = `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
  return raw.slice(0, Math.max(16, prefix.length + 16));
}
