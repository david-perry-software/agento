// Private durable storage for the Mission Control canvas: feed history, agent
// notes, and UI preferences, persisted outside the repository.
//
// Path: <copilot-home>/extension-data/agento-mission-control/<repo-key>.json
// where <copilot-home> is $COPILOT_HOME exactly as given when non-empty, else
// ~/.copilot — the same rule the Copilot runtime uses (create-canvas skill).
// Records are keyed by a hash of the primary clone path so every window of a repo
// shares one history and workspaces never overwrite each other.
//
// Writes are atomic (unique tmp file in the same directory, then rename), every
// read validates the format marker, version, and shape, and corrupt or
// unknown-version files are reported and never overwritten. The feed history is
// capped so the file stays bounded.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FORMAT = "agento-mission-control";
export const VERSION = 1;
export const FEED_CAP = 200;
export const NOTES_CAP = 200;

// The Copilot home the runtime and this canvas both use.
export function copilotHome(env = process.env) {
  const home = env?.COPILOT_HOME;
  if (typeof home === "string" && home.length > 0) return home;
  return path.join(os.homedir(), ".copilot");
}

// A short, stable key for the repo the session works in. Hash the real path so
// the key survives symlinks and does not leak the path into the filename.
export function repoKeyFor(primaryClonePath) {
  let real = primaryClonePath;
  if (real) {
    try {
      real = fs.realpathSync(real);
    } catch {
      // The path may not exist yet (tests, first run); hash the given value.
    }
  }
  return crypto.createHash("sha256").update(real ?? "").digest("hex").slice(0, 16);
}

export function storePath(repoKey, { copilotHome: home = copilotHome() } = {}) {
  return path.join(home, "extension-data", "agento-mission-control", `${repoKey}.json`);
}

export function emptyStore() {
  return { feed: [], notes: [], prefs: {} };
}

function validShape(store) {
  return (
    store !== null &&
    typeof store === "object" &&
    !Array.isArray(store) &&
    Array.isArray(store.feed) &&
    Array.isArray(store.notes) &&
    store.prefs !== null &&
    typeof store.prefs === "object" &&
    !Array.isArray(store.prefs)
  );
}

// Read and validate the store. Returns:
//   { ok: true, store, absent: false }
//   { ok: true, store: null, absent: true }          (no file yet)
//   { ok: false, error: "corrupt"|"unknown-version"|"invalid-shape", message }
export function load(repoKey, { copilotHome: home = copilotHome() } = {}) {
  const file = storePath(repoKey, { copilotHome: home });
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, store: null, absent: true, path: file };
    return { ok: false, error: "corrupt", message: `read failed: ${err?.message ?? err}`, path: file };
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, error: "corrupt", message: `corrupt JSON in ${file}`, path: file };
  }
  if (envelope?.format !== FORMAT) {
    return { ok: false, error: "unknown-version", message: `unexpected format ${JSON.stringify(envelope?.format)} in ${file}`, path: file };
  }
  if (envelope?.version !== VERSION) {
    return { ok: false, error: "unknown-version", message: `unknown version ${JSON.stringify(envelope?.version)} in ${file}`, path: file };
  }
  if (!validShape(envelope)) {
    return { ok: false, error: "invalid-shape", message: `invalid store shape in ${file}`, path: file };
  }
  return { ok: true, store: envelope, absent: false, path: file };
}

// Atomically write the store. Refuses to overwrite a corrupt or unknown-version
// file that is already present. Returns { ok: true, path } | { ok: false, error, message }.
export function save(repoKey, store, { copilotHome: home = copilotHome() } = {}) {
  if (!validShape(store)) return { ok: false, error: "invalid-shape", message: "refusing to write an invalid store" };
  const file = storePath(repoKey, { copilotHome: home });
  if (fs.existsSync(file)) {
    const current = load(repoKey, { copilotHome: home });
    if (!current.ok) {
      return { ok: false, error: "refusing-overwrite", message: `existing store is not overwritable: ${current.message}`, path: file };
    }
  }
  const envelope = { format: FORMAT, version: VERSION, ...store };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    return { ok: false, error: "write-failed", message: `atomic write failed: ${err?.message ?? err}`, path: file };
  }
  return { ok: true, path: file };
}

function stamp(entry) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
}

// Append a feed event, keeping the history capped (oldest dropped first).
export function appendFeed(store, event) {
  store.feed.push(stamp(event));
  if (store.feed.length > FEED_CAP) store.feed.splice(0, store.feed.length - FEED_CAP);
  return store;
}

// Append an agent note, keeping the list capped.
export function appendNote(store, note) {
  store.notes.push(stamp(note));
  if (store.notes.length > NOTES_CAP) store.notes.splice(0, store.notes.length - NOTES_CAP);
  return store;
}
