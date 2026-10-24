// Runs the Agento CLI for the Mission Control canvas: `<clone>/scripts/agento.mjs
// dashboard [--pr]` executed in the session working directory with a bounded
// timeout, then parsed as JSON. Concurrent calls for the same options coalesce
// into one in-flight process. Failures map to typed CliError codes.
//
// `<clone>` is resolved from this module's own location (two levels up in link
// mode) or from the `.agento-stamp.json` written by stamped-copy install mode.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_TIMEOUT_MS = 30_000;

export class CliError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.cause = cause;
  }
}

// Resolve the Agento clone this canvas belongs to. In stamped-copy mode the stamp
// wins; otherwise the clone is the parent of `canvas/agento-mission-control`.
export function cloneRoot(fromUrl = import.meta.url) {
  const dir = path.dirname(fileURLToPath(fromUrl));
  const stampFile = path.join(dir, ".agento-stamp.json");
  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
    if (stamp && typeof stamp.clone === "string" && stamp.clone.length > 0) return stamp.clone;
  } catch {
    // no usable stamp; fall through to link-mode resolution
  }
  return fs.realpathSync(path.join(dir, "..", ".."));
}

// The in-flight coalescer, keyed by the effective invocation identity.
const inFlight = new Map();

function runOnce({ executable, script, args, cwd, timeoutMs, jsonOnExit = false }) {
  const label = args[0] ?? "cli";
  return new Promise((resolve, reject) => {
    execFile(executable, [script, ...args], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err?.code === "ENOENT") {
          reject(new CliError("spawn", `${label} runner not found: ${script}`, err));
        } else if (err?.killed || err?.signal === "SIGTERM") {
          reject(new CliError("timeout", `${label} timed out after ${timeoutMs} ms`, err));
        } else {
          // Commands that report a refusal as JSON on a non-zero exit (handoff: 3).
          if (jsonOnExit) {
            try {
              resolve(JSON.parse(stdout));
              return;
            } catch {
              // not JSON; report the exit below
            }
          }
          reject(new CliError("exit", `${label} exited ${err?.code ?? err?.status ?? "unknown"}: ${(stderr ?? "").trim()}`, err));
        }
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new CliError("parse", `${label} returned invalid JSON`, parseErr));
      }
    });
  });
}

// Run the dashboard once. `options` accepts:
//   pr: boolean            — add `--pr`
//   cwd: string            — session working directory (default process.cwd())
//   script: string|null    — override the CLI script (tests inject a stub)
//   clone: string|null     — override the clone root (tests inject a temp clone)
//   executable: string     — node binary (default process.execPath; tests inject)
//   timeoutMs: number      — bounded timeout (default 30 s)
export function runDashboard(options = {}) {
  const { pr = false, cwd = process.cwd(), script = null, clone = null, executable = process.execPath, timeoutMs = DASHBOARD_TIMEOUT_MS } = options;
  const root = clone ?? cloneRoot();
  const scriptPath = script ?? path.join(root, "scripts", "agento.mjs");
  const args = ["dashboard", ...(pr ? ["--pr"] : [])];
  const key = `${pr}|${scriptPath}|${cwd}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = runOnce({ executable, script: scriptPath, args, cwd, timeoutMs }).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

export const WINDOWS_TIMEOUT_MS = 20_000;
export const HANDOFF_TIMEOUT_MS = 30_000;

function cliScript({ script = null, clone = null }) {
  return script ?? path.join(clone ?? cloneRoot(), "scripts", "agento.mjs");
}

// `agento.mjs windows <checkout>...`: [{ checkout, known, open, target, kind }].
export async function runWindows(checkouts, options = {}) {
  const { cwd = process.cwd(), executable = process.execPath, timeoutMs = WINDOWS_TIMEOUT_MS } = options;
  const result = await runOnce({ executable, script: cliScript(options), args: ["windows", ...checkouts], cwd, timeoutMs });
  return Array.isArray(result?.windows) ? result.windows : [];
}

// `agento.mjs handoff <checkout> "<command>"`: the CLI's JSON, including its
// `rejected` / `failed` refusals (exit 3), which resolve rather than throw.
export function runHandoff({ checkout, command }, options = {}) {
  const { cwd = process.cwd(), executable = process.execPath, timeoutMs = HANDOFF_TIMEOUT_MS } = options;
  return runOnce({ executable, script: cliScript(options), args: ["handoff", checkout, command], cwd, timeoutMs, jsonOnExit: true });
}

export const ARTIFACTS_TIMEOUT_MS = 20_000;

// `agento.mjs artifacts <type> <slug>`: { status, source, files: { plan, roadmap,
// review } }; `missing` (exit 3) resolves rather than throws.
export function runArtifacts({ type, slug }, options = {}) {
  const { cwd = process.cwd(), executable = process.execPath, timeoutMs = ARTIFACTS_TIMEOUT_MS } = options;
  return runOnce({ executable, script: cliScript(options), args: ["artifacts", type, slug], cwd, timeoutMs, jsonOnExit: true });
}
