// The shared delivery integration helpers (fetch, merge, push) used by
// sync/step-commit/plan-publish/review-publish/publish-pr and by the ship
// teardown, moved unchanged from the legacy `scripts/agento.mjs`.

import { classifyFetchFailure } from "../session-state.mjs";
import { git } from "./context.mjs";
import { gitRun, reauthFor } from "./git.mjs";
import { originOf } from "./paths.mjs";

// The exit codes of the ship/publish-pr run; publish-pr's `pending` (exit 2) is
// shared with ship so both name the identical re-send.
export const SHIP_EXIT = { ok: 0, pending: 2, rejected: 3, blocked: 3, failed: 3 };

// Result-returning, never emitting: each caller reports a failure in its own contract.
function fetchOrigin(dir) {
  const result = gitRun(dir, ["fetch", "--prune", "origin"]);
  if (result.ok) return { ok: true };
  const url = originOf(dir);
  const auth = !result.timedOut && classifyFetchFailure(result.stderr) === "auth";
  const stderr = result.stderr.split("\n")[0];
  return { ok: false, auth, url, stderr, reauth: auth ? reauthFor(url) : null, message: `git -C ${dir} fetch --prune origin: ${stderr}` };
}

// `merge --no-edit`, never a rebase; a conflict is aborted and reported with its files.
function mergeRef(dir, ref) {
  const merge = gitRun(dir, ["merge", "--no-edit", ref], 120000);
  if (merge.ok) return { ok: true, merged: !/Already up to date/.test(merge.stdout) };
  const conflicts = git(dir, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  gitRun(dir, ["merge", "--abort"]);
  return { ok: false, conflicts, clean: git(dir, "status", "--porcelain") === "", stderr: merge.stderr.split("\n")[0] };
}

// A plain push, never forced; `-u` only when the caller asks for it.
function pushRef(dir, refspec, { setUpstream = false } = {}) {
  const args = ["push", ...(setUpstream ? ["-u"] : []), "origin", refspec];
  const result = gitRun(dir, args, 120000);
  if (result.ok) return { ok: true };
  const auth = classifyFetchFailure(result.stderr) === "auth";
  return { ok: false, reason: auth ? "push-auth" : "push-failed", reauth: auth ? reauthFor(originOf(dir)) : null, message: `git -C ${dir} ${args.join(" ")}: ${result.stderr.split("\n")[0]}` };
}

export {
  fetchOrigin,
  mergeRef,
  pushRef,
};
