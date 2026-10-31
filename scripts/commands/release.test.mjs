import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeRoadmap, reopenRoadmap } from "../delivery-roadmap-resolver.mjs";
import { linkType } from "../harness.mjs";
import { profilesHash, setHandoffModels, setModel } from "../model-profiles.mjs";
import { LIFECYCLES, SESSION_WORKSPACE_SETTINGS } from "../session-state.mjs";
import {
  assertDashboardMatches,
  baseEnv,
  both,
  byId,
  cli,
  cloneWithOrigin,
  commitAt,
  codes,
  commonDirOf,
  cloneState,
  companionOf,
  DONE_STEPS,
  git,
  gitLoggingPath,
  harnessFixture,
  inRepoDelivery,
  landBranch,
  legacyPins,
  makeDashboardRepo,
  makeFlipRepo,
  makePairRepo,
  makeRepo,
  makeWorktreeRepo,
  mergeCommitAt,
  MERGE,
  modelsFixture,
  okStubs,
  LATER,
  PARENT,
  pairDelivery,
  PASSING,
  prStub,
  publishBranch,
  refState,
  releaseGh,
  releaseRoutes,
  releaseRun,
  repoRoot,
  restrictedPath,
  roadmapFor,
  RUNS,
  run,
  runWith,
  shippable,
  shipReady,
  shipRun,
  shipStub,
  stableMetrics,
  stepsOf,
  strip,
  T1,
  worktreeCount,
  workflowFile,
  worktreeListCalls,
  writeBreakdown,
  writeFile,
  writeRoadmap,
} from "../test-helpers/agento-fixtures.mjs";

// --- release ---------------------------------------------------------------------

const releaseConfig = { checks: { releaseWorkflow: "release.yml" } };


// A gh stub answering `gh api <path>` from routes keyed on path prefix (longest wins);
// an array value is a sequence, one entry per call, repeating the last.


const recent = () => new Date(Date.now() - 30_000).toISOString();

const release = (repo, gh, ...args) => runWith({ cwd: repo, env: gh.env }, "release", ...args);

test("release: unset checks.releaseWorkflow is not-configured, exit 0, with no gh call", () => {
  const repo = makeRepo();
  const gh = releaseGh(releaseRoutes());
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.verdict, "not-configured");
  assert.equal(json.workflow, null);
  assert.deepEqual(gh.calls(), []);
});

test("release: an exact successful push run is success, exit 0, in two API calls", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(101)] } }));
  const { code, json } = release(repo, gh, MERGE.slice(0, 7));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.verdict, "success");
  assert.equal(json.sha, MERGE);
  assert.equal(json.workflow, "release.yml");
  assert.deepEqual(json.run, { id: 101, event: "push", status: "completed", conclusion: "success", url: "https://github.test/runs/101", headSha: MERGE });
  assert.equal(json.supersededBy, null);
  assert.equal(json.mergeDate, "2020-01-01T00:00:00Z");
  assert.equal(json.graceSeconds, 180);
  assert.equal(json.polls, 1);
  assert.equal(json.waitedSeconds, 0);
  for (const key of ["reason", "root", "configSource"]) assert.ok(key in json, key);
  assert.equal(gh.apiCalls().length, 2, gh.apiCalls().join("\n"));
  assert.match(gh.apiCalls()[1], new RegExp(`head_sha=${MERGE}&per_page=100$`));
});

test("release: an exact in-progress run is pending, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(102, { status: "in_progress", conclusion: null })] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 2);
  assert.equal(json.status, "pending");
  assert.equal(json.verdict, "pending");
});

test("release: a dispatch-only workflow is dispatch-required, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  workflow_dispatch:\n") }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 2);
  assert.equal(json.status, "pending");
  assert.equal(json.verdict, "dispatch-required");
  assert.ok(gh.apiCalls().every((c) => !c.includes("/compare/")), gh.apiCalls().join("\n"));
});

test("release: a failed exact run is failed, exit 4", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(103, { conclusion: "failure" })] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 4);
  assert.equal(json.status, "failed");
  assert.equal(json.verdict, "failed");
});

test("release: no run long after the merge is no-run, exit 4; within grace it is pending", () => {
  const repo = makeRepo({ config: releaseConfig });
  const late = release(repo, releaseGh(releaseRoutes()), MERGE);
  assert.equal(late.code, 4);
  assert.equal(late.json.verdict, "no-run");
  const early = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: mergeCommitAt(recent()) })), MERGE);
  assert.equal(early.code, 2);
  assert.equal(early.json.verdict, "pending");
});

test("release: a docs-only merge against paths-ignore is not-triggered, exit 0", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/compare/${PARENT}...`]: { status: "ahead", files: [{ filename: "docs/a.md" }] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0);
  assert.equal(json.verdict, "not-triggered");
});

test("release: a cancelled run with a passing descendant push run is superseded-success, exit 0", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({
    [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(104, { conclusion: "cancelled" })] },
    [`${RUNS}?branch=`]: { workflow_runs: [releaseRun(105, { head_sha: LATER, created_at: "2026-10-07T10:05:00Z" })] },
    [`repos/{owner}/{repo}/compare/${MERGE}...${LATER}`]: { status: "ahead" },
  }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.verdict, "superseded-success");
  assert.equal(json.run.id, 104);
  assert.equal(json.supersededBy.id, 105);
  assert.equal(json.supersededBy.url, "https://github.test/runs/105");
  assert.ok(gh.apiCalls().some((c) => c.includes("branch=main&event=push&created=%3E%3D")), gh.apiCalls().join("\n"));
});

test("release: gh missing, HTTP 401, and an unknown SHA exit 3", () => {
  const repo = makeRepo({ config: releaseConfig });
  const missing = runWith({ cwd: repo, env: restrictedPath().env }, "release", MERGE);
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "error");
  assert.equal(missing.json.reason, "gh-missing");

  const auth = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: { __stderr: "gh: Bad credentials (HTTP 401)" } })), MERGE);
  assert.equal(auth.code, 3);
  assert.equal(auth.json.reason, "auth");
  assert.match(auth.json.message, /gh auth login/);

  const unknown = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: { __stderr: "gh: No commit found for SHA: 1111111 (HTTP 422)" } })), MERGE);
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.reason, "unknown-sha");
});

test("release: usage errors exit 1 and the usage lists the subcommand", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes());
  for (const args of [[MERGE, "--wait", "61"], [MERGE, "--wait", "-1"], [MERGE, "--wait", "1.5"], [MERGE, "--interval", "0"], ["XYZ"], [], [MERGE, "extra"]]) {
    const { code, json } = release(repo, gh, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error");
  }
  assert.deepEqual(gh.calls(), []);
  assert.ok(run(repo, "bogus").json.usage.some((line) => line.includes("release <merge-sha> [--wait N] [--interval N]")));
});

test("release --wait polls until a pending run succeeds", () => {
  const repo = makeRepo({ config: releaseConfig });
  const pending = { workflow_runs: [releaseRun(106, { status: "in_progress", conclusion: null })] };
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: [pending, { workflow_runs: [releaseRun(106)] }] }));
  const { code, json } = release(repo, gh, MERGE, "--wait", "3", "--interval", "1");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.verdict, "success");
  assert.ok(json.polls >= 2, String(json.polls));
  assert.equal(json.waitedSeconds, json.polls - 1);
  assert.equal(gh.apiCalls().filter((c) => c.includes("/commits/")).length, 1);
});

test("release --wait gives up within its budget on an always-pending run, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(107, { status: "queued", conclusion: null })] } }));
  const started = Date.now();
  const { code, json } = release(repo, gh, MERGE, "--wait", "2", "--interval", "1");
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.equal(code, 2);
  assert.equal(json.verdict, "pending");
  assert.equal(json.polls, 3);
  assert.equal(json.waitedSeconds, 2);
});

test("release --wait never loops on dispatch-required", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on: workflow_dispatch\n") }));
  const { code, json } = release(repo, gh, MERGE, "--wait", "5", "--interval", "1");
  assert.equal(code, 2);
  assert.equal(json.verdict, "dispatch-required");
  assert.equal(json.polls, 1);
  assert.equal(json.waitedSeconds, 0);
});
