// The `release` command family and the GitHub API helpers it shares with `ship`.
// Moved unchanged from `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";

import { GRACE_SECONDS, parseWorkflowTriggers, releaseVerdict as deriveReleaseVerdict } from "../release-state.mjs";
import { config, root } from "./context.mjs";
import { ghVersion } from "./probe.mjs";

export const RELEASE_EXIT = { success: 0, "superseded-success": 0, "not-triggered": 0, "not-configured": 0, pending: 2, "dispatch-required": 2, failed: 4, "no-run": 4 };
export const RELEASE_STATUS = { 0: "ok", 2: "pending", 4: "failed" };

export class GhFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// `{owner}/{repo}` placeholders are filled in by gh from the cwd's git remote.
export function ghApi(apiPath, { notFound = "gh-error" } = {}) {
  let out;
  try {
    out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", apiPath], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  } catch (error) {
    if (error?.code === "ENOENT") throw new GhFailure("gh-missing", "gh CLI not found on PATH; install GitHub CLI, then re-run");
    const stderr = (error?.stderr ?? "").toString().trim();
    const first = stderr.split("\n")[0] || error?.message || "unknown error";
    if (/HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(stderr)) {
      throw new GhFailure("auth", `gh is not authenticated for this repository (${first}); run \`gh auth login\` in your own terminal, then re-run`);
    }
    if (/HTTP 404|HTTP 422/.test(stderr)) {
      if (notFound === null) return null;
      if (notFound === "unknown-sha") throw new GhFailure("unknown-sha", `GitHub does not know the commit: ${first}`);
    }
    if (error?.code === "ETIMEDOUT") throw new GhFailure("gh-error", `gh api ${apiPath} timed out after 15 s`);
    throw new GhFailure("gh-error", `gh api ${apiPath} failed: ${first}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new GhFailure("gh-error", `gh api ${apiPath} returned non-JSON output`);
  }
}

// The required status-check contexts a branch protection asks for, read through the
// ruleset and classic-protection endpoints. Any error yields `{ known: false }` and
// never a failure: a policy-blocked merge is reported, never guessed at.
export function ghRequiredContexts(cwd, nwo, branch) {
  const get = (apiPath) => {
    try {
      const out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", apiPath], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      return { known: true, json: JSON.parse(out) };
    } catch {
      return { known: false, json: null };
    }
  };
  const rules = get(`repos/${nwo}/rules/branches/${branch}`);
  const protection = get(`repos/${nwo}/branches/${branch}/protection/required_status_checks`);
  return { known: rules.known || protection.known, rules: rules.json, protection: protection.json };
}

const runSummary = (run) => (run ? { id: run.id, event: run.event, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null, headSha: run.head_sha } : null);

export function once(fn) {
  let done = false;
  let value;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

// The immutable facts about a merge commit, fetched at most once per call.
export function releaseContext(workflow, shaArg) {
  const commit = ghApi(`repos/{owner}/{repo}/commits/${shaArg}`, { notFound: "unknown-sha" });
  const sha = commit.sha;
  const mergeDate = commit.commit?.committer?.date ?? null;
  const parent = commit.parents?.[0]?.sha ?? null;
  const runs = `repos/{owner}/{repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const diff = once(() => (parent ? ghApi(`repos/{owner}/{repo}/compare/${parent}...${sha}`) : null));
  const descendants = new Map();
  return {
    sha,
    mergeDate,
    exactRunsPath: `${runs}?head_sha=${sha}&per_page=100`,
    laterRunsPath: `${runs}?branch=${encodeURIComponent(config.branches.default)}&event=push&created=${encodeURIComponent(`>=${mergeDate}`)}&per_page=100`,
    // A missing or non-file workflow is treated as unparsed: wait for a run rather than declare none needed.
    triggers: once(() => {
      if (!/\.ya?ml$/.test(workflow)) return { push: null, dispatch: false, unparsed: true };
      const file = ghApi(`repos/{owner}/{repo}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${sha}`, { notFound: null });
      if (!file?.content) return { push: null, dispatch: false, unparsed: true };
      return parseWorkflowTriggers(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8"));
    }),
    files: () => (diff()?.files ?? []).map((f) => f.filename),
    // GitHub caps compare files[] at 300; a root commit has no parent diff at all.
    filesTruncated: () => !diff() || (diff().files?.length ?? 0) >= 300,
    descendantOf: (head) => {
      if (!descendants.has(head)) descendants.set(head, ghApi(`repos/{owner}/{repo}/compare/${sha}...${head}`).status);
      return descendants.get(head);
    },
  };
}

export function releaseSnapshot(ctx) {
  return deriveReleaseVerdict({
    sha: ctx.sha,
    defaultBranch: config.branches.default,
    mergeDate: ctx.mergeDate,
    now: Date.now(),
    exactRuns: () => ghApi(ctx.exactRunsPath).workflow_runs ?? [],
    laterRuns: () => ghApi(ctx.laterRunsPath).workflow_runs ?? [],
    triggers: ctx.triggers,
    files: ctx.files,
    filesTruncated: ctx.filesTruncated,
    descendantOf: ctx.descendantOf,
  });
}

// The `release` document and its exit code for a merge commit: one snapshot, then
// bounded polls while `pending` (dispatch-required never loops: only the caller can
// start that run). Shared by `case "release"` and the ship release phase.
export function releaseVerdict(shaArg, { wait = 0, interval = 10 } = {}) {
  const workflow = config.checks?.releaseWorkflow ?? null;
  const base = { status: "ok", verdict: null, sha: shaArg, workflow, run: null, supersededBy: null, reason: null, mergeDate: null, graceSeconds: GRACE_SECONDS, polls: 0, waitedSeconds: 0 };
  if (!workflow) return { fields: { ...base, verdict: "not-configured", reason: "checks.releaseWorkflow is not set; there is no release to wait for" }, code: 0 };
  try {
    if (!ghVersion().ok) throw new GhFailure("gh-missing", "gh CLI not found on PATH; install GitHub CLI, then re-run");
    const ctx = releaseContext(workflow, shaArg);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let result = releaseSnapshot(ctx);
    let polls = 1;
    let waited = 0;
    while (result.verdict === "pending" && waited + interval <= wait) {
      Atomics.wait(sleeper, 0, 0, interval * 1000);
      waited += interval;
      result = releaseSnapshot(ctx);
      polls += 1;
    }
    const code = RELEASE_EXIT[result.verdict];
    return { fields: { ...base, status: RELEASE_STATUS[code], verdict: result.verdict, sha: ctx.sha, run: runSummary(result.run), supersededBy: runSummary(result.supersededBy), reason: result.reason, mergeDate: ctx.mergeDate, polls, waitedSeconds: waited }, code };
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    return { fields: { ...base, status: "error", reason: error.reason, message: error.message }, code: 3 };
  }
}
