// The PR-lookup helpers shared by session, status, ship-preflight, and the
// dashboard, moved unchanged from the legacy `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";

import { root } from "./context.mjs";
import { checkoutLayout } from "./layout.mjs";
import { execAsync, ghVersion, probeAsync } from "./probe.mjs";

// Only `session --pr` and `ship-preflight --pr` reach this; every failure is a warning, never an exit code.
// `label` names the field in warnings (`pr` for the code PR in the product checkout,
// `companionPr` for the artifact PR looked up in the companion clone).
function lookupPullRequest(branch, { cwd = root, label = "pr" } = {}) {
  if (!branch) return { pr: null, warnings: [`${label}: no branch to look up (detached HEAD)`] };
  const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 };
  if (!ghVersion().ok) return ghMissingLookup(label);
  try {
    return { pr: JSON.parse(execFileSync("gh", prViewArgs(branch), opts)), warnings: [] };
  } catch (error) {
    return failedLookup(label, branch, error);
  }
}

const prViewArgs = (branch) => ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,mergeable,url"];
const ghMissingLookup = (label) => ({ pr: null, warnings: [`${label}: gh CLI not found on PATH; install GitHub CLI to include pull request state`] });

function failedLookup(label, branch, error) {
  const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0] || error?.message || "unknown error";
  return { pr: null, warnings: [`${label}: gh pr view ${branch} failed: ${stderr}`] };
}

// lookupPullRequest's exact result, without blocking the process.
async function lookupPullRequestAsync(branch, { cwd = root, label = "pr" } = {}) {
  if (!branch) return lookupPullRequest(branch, { cwd, label });
  if (!(await probeAsync("gh", ["--version"])).ok) return ghMissingLookup(label);
  try {
    const { stdout } = await execAsync("gh", prViewArgs(branch), { cwd, timeout: 15000 });
    return { pr: JSON.parse(stdout), warnings: [] };
  } catch (error) {
    return failedLookup(label, branch, error);
  }
}

// Runs the thunks with at most `limit` in flight; results keep the input order.
async function runPool(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const lookupKey = (cwd, branch) => `${cwd}\0${branch}`;

// Prefetch: the deduplicated `{ cwd, branch, label }` PR lookups and the doctor's
// external probes (into the probe cache), through one pool. `gh --version` goes first
// so the lookups waiting on it never hold the pool's slots, then the lookups (network
// round-trips of up to a second each), then the probes. Returns the lookups keyed by
// cwd + branch.
async function lookupPullRequests(requests, { probes = [] } = {}) {
  const unique = new Map();
  for (const request of requests) {
    const cwd = request.cwd ?? root;
    if (request.branch && !unique.has(lookupKey(cwd, request.branch))) unique.set(lookupKey(cwd, request.branch), { ...request, cwd });
  }
  const results = new Map();
  const ghFirst = unique.size ? [["gh", ["--version"]]] : [];
  const probeTask = ([cmd, args]) => () => probeAsync(cmd, args);
  const lookupTasks = [...unique].map(([key, { branch, cwd, label }]) => async () => results.set(key, await lookupPullRequestAsync(branch, { cwd, label })));
  await runPool([...ghFirst.map(probeTask), ...lookupTasks, ...probes.map(probeTask)]);
  return results;
}

// A lookupPullRequest-compatible function answering from `lookupPullRequests` results.
const prefetchedLookup = (results) => (branch, opts = {}) => results.get(lookupKey(opts.cwd ?? root, branch)) ?? lookupPullRequest(branch, opts);

// The mirrored artifact PR: the same branch name looked up in the companion clone
// the layout names. In-repo layout → null with no gh call, so today's output is unchanged.
function lookupCompanionPullRequest(branch, layout = checkoutLayout(), lookup = lookupPullRequest) {
  if (!layout.artifacts.external) return { pr: null, warnings: [] };
  return lookup(branch, { cwd: layout.artifactsRoot, label: "companionPr" });
}

export {
  lookupPullRequest,
  lookupPullRequestAsync,
  lookupPullRequests,
  prefetchedLookup,
  lookupCompanionPullRequest,
};
