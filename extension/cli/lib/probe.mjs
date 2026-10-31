// Bounded, never-throwing external-command probes, shared by doctor, release,
// and the PR-lookup paths. Moved unchanged from `scripts/agento.mjs`.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { root } from "./context.mjs";

const execFileAsync = promisify(execFile);

// execFile with stdin closed, like the synchronous calls' `stdio: ["ignore", …]`.
export function execAsync(cmd, args, opts) {
  const pending = execFileAsync(cmd, args, { encoding: "utf8", ...opts });
  pending.child.stdin?.end();
  return pending;
}

const probeCache = new Map();
const probeKey = (cmd, args) => [cmd, ...args].join("\0");
const probeOptions = () => ({ cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function probeFailure(cmd, error) {
  const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0];
  const stdout = (error?.stdout ?? "").toString().trim().split("\n")[0];
  const timedOut = error?.code === "ETIMEDOUT" || (error?.signal && !error?.status);
  return {
    ok: false,
    missing: error?.code === "ENOENT",
    timedOut,
    detail: timedOut ? `${cmd} timed out after 10 s` : stderr || stdout || error?.message || "unknown error",
  };
}

// Every probe is bounded and never throws: a missing binary, a nonzero exit, and a
// timeout all become a result the caller maps to ok | warn | fail. Each command +
// arguments runs at most once per process (probeAsync may have run it already).
export function probe(cmd, args) {
  const key = probeKey(cmd, args);
  if (!probeCache.has(key)) {
    try {
      probeCache.set(key, { ok: true, out: execFileSync(cmd, args, { ...probeOptions(), stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0] ?? "" });
    } catch (error) {
      probeCache.set(key, probeFailure(cmd, error));
    }
  }
  return probeCache.get(key);
}

const probesInFlight = new Map();

// probe() without blocking the process; concurrent callers share one run.
export function probeAsync(cmd, args) {
  const key = probeKey(cmd, args);
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key));
  if (!probesInFlight.has(key)) {
    probesInFlight.set(
      key,
      execAsync(cmd, args, probeOptions()).then(
        ({ stdout }) => ({ ok: true, out: stdout.trim().split("\n")[0] ?? "" }),
        (error) => probeFailure(cmd, error),
      ).then((result) => {
        probeCache.set(key, result);
        return result;
      }),
    );
  }
  return probesInFlight.get(key);
}

export const ghVersion = () => probe("gh", ["--version"]);
