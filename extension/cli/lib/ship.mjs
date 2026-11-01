// The ship/publish-pr shared helpers: PR lookup and summary, check waiting,
// changelog stamping, the ship token, and the roadmap-step parsers, moved unchanged
// from the legacy `scripts/agento.mjs` (shared by `ship` and `publish-pr`).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { emit, PLUGIN_ROOT } from "./context.mjs";
import { gitRun } from "./git.mjs";
import { ghRun } from "./github.mjs";
import { canonicalizeJson } from "./session.mjs";

const SHIP_PR_FIELDS = "number,state,isDraft,mergeStateStatus,mergeable,url,title,body,mergeCommit,baseRefName";
const WAIT_FOR_CHECKS = path.join(PLUGIN_ROOT, "scripts", "wait-for-checks.sh");

// scripts/wait-for-checks.sh in the foreground, bounded by the caller's seconds budget.
function waitForChecks(kind, target, cwd, { repo = null, maxSeconds = 50 } = {}) {
  const args = [WAIT_FOR_CHECKS, kind, String(target), "--max-seconds", String(Math.max(0, maxSeconds)), "--interval", "10", ...(repo ? ["--repo", repo] : [])];
  const result = spawnSync("bash", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter(Boolean);
  return { code: result.status ?? 3, last: lines.at(-1) ?? (result.error?.message ?? "wait-for-checks.sh produced no output") };
}

// `gh pr view <branch>` with the fields the ship audit and merge need; a merged PR
// is still found by its head branch after the remote branch is deleted.
function shipPrLookup(branch, cwd, label) {
  const result = ghRun(cwd, ["pr", "view", branch, "--json", SHIP_PR_FIELDS], 20000);
  if (!result.ok) return { pr: null, warning: `${label}: gh pr view ${branch} failed: ${result.stderr.split("\n")[0]}` };
  try {
    return { pr: JSON.parse(result.stdout), warning: null };
  } catch {
    return { pr: null, warning: `${label}: gh pr view ${branch} returned non-JSON output` };
  }
}

const prSummary = (pr) => (pr ? { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft), mergeStateStatus: pr.mergeStateStatus ?? null, mergeable: pr.mergeable ?? null, url: pr.url ?? null, mergeCommit: pr.mergeCommit?.oid ?? null } : null);

// GitHub reports a conflict as mergeable CONFLICTING / mergeStateStatus DIRTY; mergeStateStatus is never CONFLICTING.
const isConflicting = (pr) => pr?.mergeable === "CONFLICTING" || pr?.mergeStateStatus === "DIRTY";

const utcDate = () => new Date().toISOString().slice(0, 10);

function stampChangelog(dir, version, date, act, previous = null) {
  const file = path.join(dir, "CHANGELOG.md");
  const before = fs.readFileSync(file, "utf8");
  const from = previous ? `## ${version} (${previous})` : `## ${version} (unreleased)`;
  if (!before.includes(from)) return;
  fs.writeFileSync(file, before.replace(from, `## ${version} (${date})`));
  gitRun(dir, ["add", "--", "CHANGELOG.md"]);
  const commit = gitRun(dir, ["commit", "-q", "-m", `chore(release): stamp CHANGELOG ${version} (${date})`]);
  if (!commit.ok) emit({ status: "failed", reason: "commit-failed", message: `git -C ${dir} commit (changelog stamp): ${commit.stderr}` }, 3);
  act("changelog-stamp", `CHANGELOG.md "## ${version} (${previous ?? "unreleased"})" stamped (${date}) at ${dir}`);
}

function confirmTokenFor(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeJson(payload))).digest("hex").slice(0, 12);
}

function roadmapPathOnRef(layout, ref, type, slug) {
  const top = type === "feature" ? layout.config.artifacts.features : layout.config.artifacts.issues;
  return layout.agit("ls-tree", "-r", "--name-only", ref, `${top}/`).split("\n").find((p) => p.endsWith(`/${slug}/roadmap.md`)) ?? null;
}

function parseRoadmapSteps(content) {
  return [...content.matchAll(/^- \[( |x)\] (\d+\.\d+) (.*)$/gm)].map(([, mark, id, text]) => ({
    id,
    text,
    ticked: mark === "x",
    manual: /^\(manual/.test(text),
    postShip: text.startsWith("(manual, post-ship)"),
  }));
}

export {
  SHIP_PR_FIELDS,
  waitForChecks,
  shipPrLookup,
  prSummary,
  isConflicting,
  utcDate,
  stampChangelog,
  confirmTokenFor,
  roadmapPathOnRef,
  parseRoadmapSteps,
};
