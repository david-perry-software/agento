// Pending dispatch: the cross-window handoff queue. A window (the Mission Control
// canvas through `agento.mjs handoff`, or the VS Code extension's sidebar) queues
// one canonical `/agento …` command for a target window, then opens or focuses
// that window; the extension in the target window takes the record on activation
// and on every window focus, checks it, and submits the command to chat.
//
// The queue is a directory of one JSON file per target, shared by the CLI and the
// extension: `<agento-config>/pending-dispatch/`, beside model-profiles.json
// (`$AGENTO_CONFIG_HOME`, else `$XDG_CONFIG_HOME/agento`, else `~/.config/agento`).
// File name: sha256 of `agento.pendingDispatch:<encodeURIComponent(target)>` + .json.
// Record: { target, command, createdAt } — `target` is the exact workspace file or
// folder the target window has open. The extension (src/pendingDispatch.ts) keeps
// the same key, record, TTL, and command shape; its parity test reads this module.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { profilesFile } from "./model-profiles.mjs";

export const PENDING_DISPATCH_TTL_MS = 5 * 60 * 1000;
export const KEY_PREFIX = "agento.pendingDispatch:";

export function pendingDispatchDir(env = process.env, home = os.homedir()) {
  return path.join(path.dirname(profilesFile(env, home)), "pending-dispatch");
}

export function pendingDispatchKey(target) {
  return `${KEY_PREFIX}${encodeURIComponent(target)}`;
}

export function pendingDispatchFile(dir, target) {
  const digest = createHash("sha256").update(pendingDispatchKey(target)).digest("hex");
  return path.join(dir, `${digest}.json`);
}

export function isCanonicalAgentoCommand(value) {
  return typeof value === "string" && /^\/agento [a-z][a-z-]*(?: [^\r\n]+)?$/.test(value);
}

// Atomically (tmp + rename, mode 0600) replace the record for `target`.
export function writePendingDispatch(dir, { target, command, createdAt = Date.now() }) {
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("pending dispatch target must be an absolute path");
  if (!isCanonicalAgentoCommand(command)) throw new Error("pending dispatch command must use canonical /agento <name> syntax");
  if (!Number.isFinite(createdAt)) throw new Error("pending dispatch createdAt must be a finite timestamp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pendingDispatchFile(dir, target);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ target, command, createdAt }), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

export function removePendingDispatch(dir, target) {
  fs.rmSync(pendingDispatchFile(dir, target), { force: true });
}
