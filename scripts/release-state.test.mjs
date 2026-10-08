import assert from "node:assert/strict";
import test from "node:test";

import { branchTriggered, classifyRun, globToRegExp, matchesFilter, parseWorkflowTriggers, pickExactRun, pushTriggered, releaseVerdict, withinGrace } from "./release-state.mjs";

// The `on:` block of Soshiki's staging-release.yml, verbatim apart from the trimmed inputs.
const SOSHIKI = `name: Staging release

on:
  push:
    branches:
      - main
    paths-ignore:
      - "docs/**"
      - "ROADMAP.md"
  workflow_dispatch:
    inputs:
      operation:
        description: Release current main, rerun smoke checks, or roll back applications
        required: true
        default: release
        type: choice
        options:
          - release
          - smoke
          - rollback

permissions:
  contents: read

concurrency:
  group: staging-release
  cancel-in-progress: false
`;

test("globToRegExp: * stops at /, ** crosses it, **/ matches zero directories", () => {
  assert.ok(globToRegExp("docs/*").test("docs/a.md"));
  assert.ok(!globToRegExp("docs/*").test("docs/sub/a.md"));
  assert.ok(globToRegExp("docs/**").test("docs/sub/deep/a.md"));
  assert.ok(globToRegExp("**/README.md").test("README.md"));
  assert.ok(globToRegExp("**/README.md").test("a/b/README.md"));
  assert.ok(globToRegExp("src/**/*.js").test("src/x.js"));
  assert.ok(globToRegExp("src/**/*.js").test("src/a/b/x.js"));
  assert.ok(!globToRegExp("docs").test("docs/a.md"));
});

test("globToRegExp: ? matches one non-slash character, classes pass through, ! negates", () => {
  assert.ok(globToRegExp("v?.md").test("v1.md"));
  assert.ok(!globToRegExp("v?.md").test("v/.md"));
  assert.ok(globToRegExp("release/[0-9]*").test("release/2026"));
  assert.ok(!globToRegExp("release/[0-9]*").test("release/x"));
  assert.ok(globToRegExp("a.b").test("a.b"));
  assert.ok(!globToRegExp("a.b").test("axb"));
  const negated = globToRegExp("!docs/**");
  assert.equal(negated.negated, true);
  assert.ok(negated.test("docs/x"));
  assert.equal(globToRegExp("docs/**").negated, false);
});

test("matchesFilter: the last matching pattern wins", () => {
  assert.ok(matchesFilter(["docs/**", "!docs/keep/**"], "docs/a.md"));
  assert.ok(!matchesFilter(["docs/**", "!docs/keep/**"], "docs/keep/a.md"));
  assert.ok(matchesFilter(["docs/**", "!docs/keep/**", "docs/keep/x.md"], "docs/keep/x.md"));
  assert.ok(!matchesFilter([], "anything"));
});

test("parseWorkflowTriggers reads Soshiki's on: block", () => {
  assert.deepEqual(parseWorkflowTriggers(SOSHIKI), {
    push: { branches: ["main"], branchesIgnore: null, paths: null, pathsIgnore: ["docs/**", "ROADMAP.md"], tags: null, tagsIgnore: null },
    dispatch: true,
    unparsed: false,
  });
});

test("parseWorkflowTriggers reads scalar, flow-list, and block-list forms", () => {
  const empty = { branches: null, branchesIgnore: null, paths: null, pathsIgnore: null, tags: null, tagsIgnore: null };
  assert.deepEqual(parseWorkflowTriggers("on: push\n"), { push: empty, dispatch: false, unparsed: false });
  assert.deepEqual(parseWorkflowTriggers("on: [push, workflow_dispatch]\n"), { push: empty, dispatch: true, unparsed: false });
  assert.deepEqual(parseWorkflowTriggers("on: workflow_dispatch\n"), { push: null, dispatch: true, unparsed: false });
  assert.deepEqual(parseWorkflowTriggers("on:\n  - push\n  - pull_request\n"), { push: empty, dispatch: false, unparsed: false });
  const flow = parseWorkflowTriggers("on:\n  push:\n    branches: [main, 'release/**']\n    paths: [\"src/**\"] # code only\n  pull_request:\n");
  assert.deepEqual(flow.push.branches, ["main", "release/**"]);
  assert.deepEqual(flow.push.paths, ["src/**"]);
  assert.equal(flow.dispatch, false);
  const sameIndent = parseWorkflowTriggers("on:\n  push:\n    paths-ignore:\n    - docs/**\n");
  assert.deepEqual(sameIndent.push.pathsIgnore, ["docs/**"]);
  assert.deepEqual(parseWorkflowTriggers("on:\n  push:\n  workflow_dispatch:\n").push, empty);
});

test("parseWorkflowTriggers flags forms it cannot read as unparsed", () => {
  assert.equal(parseWorkflowTriggers("name: x\njobs: {}\n").unparsed, true);
  assert.equal(parseWorkflowTriggers("on: { push: { branches: [main] } }\n").unparsed, true);
  assert.equal(parseWorkflowTriggers("on:\n  push:\n    branches: *anchor\n    weird: 1\n").unparsed, true);
  assert.equal(parseWorkflowTriggers("on:\n  push: { branches: [main] }\n").unparsed, true);
  assert.equal(parseWorkflowTriggers("on:\n").unparsed, true);
});

test("pushTriggered applies Soshiki's branch and paths-ignore filters", () => {
  const triggers = parseWorkflowTriggers(SOSHIKI);
  assert.equal(pushTriggered({ triggers, branch: "main", files: ["docs/a.md", "ROADMAP.md"] }), false);
  assert.equal(pushTriggered({ triggers, branch: "main", files: ["docs/a.md", "apps/web/x.ts"] }), true);
  assert.equal(pushTriggered({ triggers, branch: "develop", files: ["apps/web/x.ts"] }), false);
  assert.equal(pushTriggered({ triggers, branch: "main", files: ["docs/a.md"], filesTruncated: true }), true);
});

test("pushTriggered: paths need one match, negation re-excludes, unparsed and missing push", () => {
  const triggers = parseWorkflowTriggers("on:\n  push:\n    paths:\n      - 'src/**'\n      - '!src/**/*.md'\n");
  assert.equal(pushTriggered({ triggers, branch: "main", files: ["src/a.ts"] }), true);
  assert.equal(pushTriggered({ triggers, branch: "main", files: ["src/notes.md", "README.md"] }), false);
  assert.equal(pushTriggered({ triggers: { push: null, dispatch: true, unparsed: true }, branch: "main", files: [] }), true);
  assert.equal(pushTriggered({ triggers: parseWorkflowTriggers("on: workflow_dispatch\n"), branch: "main", files: ["x"] }), false);
  assert.equal(pushTriggered({ triggers: parseWorkflowTriggers("on: push\n"), branch: "any", files: [] }), true);
});

test("branchTriggered: branches-ignore and tag-only filters", () => {
  const ignore = parseWorkflowTriggers("on:\n  push:\n    branches-ignore:\n      - 'dependabot/**'\n").push;
  assert.equal(branchTriggered(ignore, "main"), true);
  assert.equal(branchTriggered(ignore, "dependabot/npm"), false);
  const tagsOnly = parseWorkflowTriggers("on:\n  push:\n    tags:\n      - 'v*'\n").push;
  assert.equal(branchTriggered(tagsOnly, "main"), false);
  assert.equal(branchTriggered(null, "main"), false);
});

// --- run selection, classification, grace, verdicts ------------------------------

const SHA = "a".repeat(40);
const MERGED = "2026-10-07T10:00:00Z";
const at = (seconds) => Date.parse(MERGED) + seconds * 1000;
const run = (id, fields = {}) => ({ id, event: "push", status: "completed", conclusion: "success", head_sha: SHA, head_branch: "main", created_at: MERGED, html_url: `https://example.test/runs/${id}`, ...fields });
const soshiki = parseWorkflowTriggers(SOSHIKI);
const facts = (fields = {}) => ({ sha: SHA, exactRuns: [], triggers: soshiki, files: ["apps/web/x.ts"], filesTruncated: false, mergeDate: MERGED, now: at(30), laterRuns: [], descendantOf: {}, defaultBranch: "main", ...fields });

test("classifyRun maps run status and conclusion to four states", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) assert.equal(classifyRun(run(1, { status, conclusion: null })), "pending");
  assert.equal(classifyRun(run(1)), "success");
  assert.equal(classifyRun(run(1, { conclusion: "cancelled" })), "cancelled");
  for (const conclusion of ["failure", "timed_out", "action_required", "skipped", "neutral"]) assert.equal(classifyRun(run(1, { conclusion })), "failed");
});

test("withinGrace counts 180 s from the merge commit date", () => {
  assert.equal(withinGrace({ mergeDate: MERGED, now: at(179) }), true);
  assert.equal(withinGrace({ mergeDate: MERGED, now: at(180) }), false);
  assert.equal(withinGrace({ mergeDate: MERGED, now: at(10), graceSeconds: 5 }), false);
  assert.equal(withinGrace({ mergeDate: "garbage", now: at(0) }), false);
});

test("pickExactRun: a newer same-SHA workflow_dispatch run does not shadow the push run", () => {
  const push = run(10, { created_at: "2026-10-07T10:00:05Z", conclusion: "success" });
  const smoke = run(11, { event: "workflow_dispatch", created_at: "2026-10-07T10:30:00Z", conclusion: "failure" });
  assert.equal(pickExactRun([smoke, push], SHA).id, 10);
  assert.equal(releaseVerdict(facts({ exactRuns: [smoke, push] })).verdict, "success");
  assert.equal(pickExactRun([smoke], SHA).id, 11);
  assert.equal(pickExactRun([run(12, { head_sha: "b".repeat(40) })], SHA), null);
  assert.equal(pickExactRun([run(13, { event: "schedule" })], SHA), null);
  const older = run(14, { created_at: "2026-10-07T10:00:01Z" });
  const newer = run(15, { created_at: "2026-10-07T10:00:09Z" });
  assert.equal(pickExactRun([older, newer], SHA).id, 15);
});

test("releaseVerdict: an exact successful run is success", () => {
  const result = releaseVerdict(facts({ exactRuns: [run(1)] }));
  assert.equal(result.verdict, "success");
  assert.equal(result.run.id, 1);
  assert.equal(result.supersededBy, null);
});

test("releaseVerdict: an exact pending run is pending", () => {
  const result = releaseVerdict(facts({ exactRuns: [run(2, { status: "in_progress", conclusion: null })], now: at(9999) }));
  assert.equal(result.verdict, "pending");
  assert.equal(result.run.id, 2);
});

test("releaseVerdict: an exact failed run is failed", () => {
  const result = releaseVerdict(facts({ exactRuns: [run(3, { conclusion: "failure" })] }));
  assert.equal(result.verdict, "failed");
  assert.match(result.reason, /failure/);
});

test("releaseVerdict: no push trigger for the default branch is dispatch-required", () => {
  const triggers = parseWorkflowTriggers("on:\n  workflow_dispatch:\n");
  const result = releaseVerdict(facts({ triggers, files: () => assert.fail("files must not be fetched") }));
  assert.equal(result.verdict, "dispatch-required");
  assert.equal(result.run, null);
  const neither = releaseVerdict(facts({ triggers: parseWorkflowTriggers("on: pull_request\n") }));
  assert.equal(neither.verdict, "not-triggered");
});

test("releaseVerdict: a docs-only merge against paths-ignore is not-triggered", () => {
  const result = releaseVerdict(facts({ files: ["docs/guide.md", "ROADMAP.md"], now: at(9999) }));
  assert.equal(result.verdict, "not-triggered");
  assert.equal(releaseVerdict(facts({ files: ["docs/guide.md"], filesTruncated: true, now: at(9999) })).verdict, "no-run");
});

test("releaseVerdict: no run within grace is pending, after grace is no-run", () => {
  assert.equal(releaseVerdict(facts({ now: at(60) })).verdict, "pending");
  const late = releaseVerdict(facts({ now: at(600) }));
  assert.equal(late.verdict, "no-run");
  assert.equal(late.run, null);
});

test("releaseVerdict reads lazy facts only on the path it takes", () => {
  const untouched = (name) => () => assert.fail(`${name} must not be fetched`);
  assert.equal(releaseVerdict(facts({ exactRuns: () => [run(1)], triggers: untouched("triggers"), files: untouched("files"), laterRuns: untouched("laterRuns") })).verdict, "success");
  const noFilters = parseWorkflowTriggers("on: push\n");
  assert.equal(releaseVerdict(facts({ triggers: () => noFilters, files: untouched("files"), now: at(600) })).verdict, "no-run");
});
