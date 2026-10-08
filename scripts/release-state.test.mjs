import assert from "node:assert/strict";
import test from "node:test";

import { branchTriggered, globToRegExp, matchesFilter, parseWorkflowTriggers, pushTriggered } from "./release-state.mjs";

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
