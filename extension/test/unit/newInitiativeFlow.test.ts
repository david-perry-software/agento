import assert from "node:assert/strict";
import test from "node:test";

import {
  createNewInitiativeRequest,
  primaryInitiativeTarget,
  repositoryRelativeBriefPath,
  runNewInitiativeFlow,
  type NewInitiativeFlowDependencies,
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

function dependencies(overrides: Partial<NewInitiativeFlowDependencies> = {}) {
  const dispatched: Array<{ command: string; target: unknown }> = [];
  return {
    readSession: async () => ({ status: "ok", worktrees: [primary, companion] }),
    isRegularFile: async () => true,
    dispatch: async (command: string, target: unknown) => { dispatched.push({ command, target }); },
    dispatched,
    ...overrides,
  };
}

test("dispatches brief text unchanged to the fresh primary target", async () => {
  const deps = dependencies();
  const text = "A multi-line brief\nwith exact spacing ";

  const result = await runNewInitiativeFlow({ kind: "brief", text }, deps);

  assert.deepEqual(result, {
    kind: "complete",
    command: `/agento new-initiative ${text}`,
    target: { kind: "folder", path: "/repo" },
  });
  assert.deepEqual(deps.dispatched, [{ command: `/agento new-initiative ${text}`, target: { kind: "folder", path: "/repo" } }]);
});

test("dispatches a validated repository-relative file path", async () => {
  const deps = dependencies();

  const result = await runNewInitiativeFlow({ kind: "file", path: "/repo/briefs/q4 plan.md" }, deps);

  assert.equal(result.kind, "complete");
  assert.equal(deps.dispatched[0]?.command, "/agento new-initiative briefs/q4 plan.md");
});

test("cancels and rejects invalid input without dispatching", async () => {
  const cancelled = dependencies();
  assert.deepEqual(await runNewInitiativeFlow(undefined, cancelled), { kind: "cancelled" });
  assert.deepEqual(cancelled.dispatched, []);

  const notAFile = dependencies({ isRegularFile: async () => false });
  assert.deepEqual(await runNewInitiativeFlow({ kind: "file", path: "/repo/briefs" }, notAFile), {
    kind: "failed",
    reason: "selected brief must be a regular file",
  });
  assert.deepEqual(notAFile.dispatched, []);
});

test("reports session and dispatch failures without a partial success", async () => {
  const invalidSession = dependencies({ readSession: async () => ({ status: "failed" }) });
  assert.match((await runNewInitiativeFlow({ kind: "brief", text: "Brief" }, invalidSession) as { reason: string }).reason, /session response/);
  assert.deepEqual(invalidSession.dispatched, []);

  const failedDispatch = dependencies({ dispatch: async () => { throw new Error("dispatch failed"); } });
  assert.deepEqual(await runNewInitiativeFlow({ kind: "brief", text: "Brief" }, failedDispatch), {
    kind: "failed",
    reason: "dispatch failed",
  });
});