import assert from "node:assert/strict";
import test from "node:test";

import {
  createNewInitiativeRequest,
  primaryInitiativeTarget,
  repositoryRelativeBriefPath,
} from "../../src/newInitiativeFlow.js";

const primary = { path: "/repo", role: "primary", isManaged: false, dirPrefix: null, repo: "product" };
const companion = { path: "/docs", role: "primary", isManaged: false, dirPrefix: null, repo: "companion" };

test("builds the canonical command while preserving multi-line brief text", () => {
  const brief = "First paragraph\n\n- Keep this indentation\n- And trailing space ";

  assert.deepEqual(createNewInitiativeRequest(brief), {
    command: `/agento new-initiative ${brief}`,
  });
});

test("treats cancellation as no request and rejects empty input", () => {
  assert.equal(createNewInitiativeRequest(undefined), undefined);
  assert.throws(() => createNewInitiativeRequest(" \n\t "), /non-empty/);
});

test("selects the unique CLI-reported product primary checkout", () => {
  assert.deepEqual(primaryInitiativeTarget({ status: "ok", worktrees: [primary, companion] }), {
    kind: "folder",
    path: "/repo",
  });
  assert.throws(() => primaryInitiativeTarget({ status: "ok", worktrees: [companion] }), /found 0/);
  assert.throws(() => primaryInitiativeTarget({ status: "ok", worktrees: [primary, { ...primary, path: "/other" }] }), /found 2/);
  assert.throws(() => primaryInitiativeTarget({ status: "failed", worktrees: [primary] }), /session response/);
});

test("normalizes repository-relative brief paths and rejects paths outside the primary", () => {
  assert.equal(repositoryRelativeBriefPath("/repo", "/repo/docs/initiative brief.md"), "docs/initiative brief.md");
  assert.throws(() => repositoryRelativeBriefPath("/repo", "/other/brief.md"), /inside the primary repository/);
  assert.throws(() => repositoryRelativeBriefPath("/repo", "/repo"), /inside the primary repository/);
});