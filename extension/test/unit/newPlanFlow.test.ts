import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitiativePlanRequest,
  createNewPlanRequest,
  runNewPlanFlow,
  type NewPlanFlowDependencies,
  type NewPlanTarget,
} from "../../src/newPlanFlow.js";
import { pendingDispatchKey, type PendingDispatchStore } from "../../src/pendingDispatch.js";

class MemoryStore implements PendingDispatchStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

const primary = { path: "/repo", role: "primary", isManaged: false, dirPrefix: null, repo: "product" };
const existing = { path: "/repo/worktrees/build-old", role: "build", isManaged: true, dirPrefix: "build", repo: "product" };
const planned = { path: "/repo/worktrees/plan-new", role: "plan", isManaged: true, dirPrefix: "plan", repo: "product" };

function session(worktrees: unknown[], extras: Record<string, unknown> = {}): unknown {
  return { status: "ok", worktrees, ...extras };
}

function dependencies(snapshots: unknown[], overrides: Partial<Omit<NewPlanFlowDependencies, "pendingStore">> = {}) {
  const pendingStore = new MemoryStore();
  const submitted: Array<{ command: string; target: NewPlanTarget }> = [];
  const opened: NewPlanTarget[] = [];
  let now = 0;
  let index = 0;
  const value: NewPlanFlowDependencies & {
    pendingStore: MemoryStore;
    submitted: typeof submitted;
    opened: typeof opened;
  } = {
    readSession: async () => snapshots[Math.min(index++, snapshots.length - 1)],
    submitCommand: async (command, target) => { submitted.push({ command, target }); },
    pendingStore,
    openTarget: async (target) => { opened.push(target); },
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
    isCancellationRequested: () => false,
    offerRecovery: async () => undefined,
    submitted,
    opened,
    ...overrides,
  };
  return value;
}

test("validates generic and initiative requests as canonical one-line commands", () => {
  assert.deepEqual(createNewPlanRequest("feature", "  Add guided planning  "), {
    command: "/agento new-feature Add guided planning",
  });
  assert.deepEqual(createNewPlanRequest("issue", "Fix launch failure"), {
    command: "/agento new-issue Fix launch failure",
  });
  assert.deepEqual(createInitiativePlanRequest("agento-extension", "new-plan-flow"), {
    command: "/agento new-feature initiative:agento-extension/new-plan-flow",
  });
  assert.throws(() => createNewPlanRequest("feature", "  "), /non-empty/);
  assert.throws(() => createNewPlanRequest("issue", "first\nsecond"), /one line/);
  assert.throws(() => createInitiativePlanRequest("bad slug", "member"), /slug/);
});

test("routes start-session to the CLI-reported primary and hands the plan to a companion workspace", async () => {
  const targetSession = session([primary, planned], {
    companion: { path: "/docs/worktrees/plan-new", registered: true },
    workspace: { path: "/repo/worktrees/plan-new.code-workspace", exists: true },
  });
  const deps = dependencies([
    session([primary, existing]),
    session([primary, existing]),
    session([primary, existing, planned]),
    targetSession,
  ]);
  const request = createNewPlanRequest("feature", "Add guided planning");

  const result = await runNewPlanFlow(request, deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.deepEqual(result, {
    kind: "complete",
    command: request.command,
    target: { kind: "workspace", path: "/repo/worktrees/plan-new.code-workspace" },
  });
  assert.deepEqual(deps.submitted, [{ command: "/agento start-session", target: { kind: "folder", path: "/repo" } }]);
  assert.deepEqual(deps.opened, [{ kind: "workspace", path: "/repo/worktrees/plan-new.code-workspace" }]);
  assert.equal(
    (deps.pendingStore.values.get(pendingDispatchKey("/repo/worktrees/plan-new.code-workspace")) as { command: string }).command,
    request.command,
  );
});

test("opens the product folder when the new plan has no companion", async () => {
  const deps = dependencies([
    session([primary]),
    session([primary, planned]),
    session([primary, planned], { companion: null, workspace: null }),
  ]);

  const result = await runNewPlanFlow(createNewPlanRequest("issue", "Fix launch"), deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.equal(result.kind, "complete");
  assert.deepEqual(deps.opened, [{ kind: "folder", path: planned.path }]);
});

test("waits for a reported companion workspace to exist", async () => {
  const deps = dependencies([
    session([primary]),
    session([primary, planned]),
    session([primary, planned], { companion: { registered: true }, workspace: { path: "/repo/plan.code-workspace", exists: false } }),
    session([primary, planned], { companion: { registered: true }, workspace: { path: "/repo/plan.code-workspace", exists: true } }),
  ]);

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Wait for pair"), deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.equal(result.kind, "complete");
  assert.deepEqual(deps.opened[0], { kind: "workspace", path: "/repo/plan.code-workspace" });
});

test("times out without writing pending state or opening an arbitrary target", async () => {
  const deps = dependencies([session([primary]), session([primary])]);
  const request = createNewPlanRequest("feature", "Never appears");

  const result = await runNewPlanFlow(request, deps, { pollIntervalMs: 10, timeoutMs: 20 });

  assert.deepEqual(result, { kind: "timeout", command: request.command, reason: "Timed out waiting for a new planning worktree." });
  assert.equal(deps.pendingStore.values.size, 0);
  assert.deepEqual(deps.opened, []);
});

test("cancels without dispatching to the target", async () => {
  let checks = 0;
  const deps = dependencies([session([primary]), session([primary, planned])], {
    isCancellationRequested: () => ++checks > 1,
  });

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Cancel me"), deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.equal(result.kind, "cancelled");
  assert.equal(deps.pendingStore.values.size, 0);
  assert.deepEqual(deps.opened, []);
});

test("rejects ambiguous new managed planning worktrees", async () => {
  const otherPlan = { ...planned, path: "/repo/worktrees/plan-other" };
  const deps = dependencies([session([primary]), session([primary, planned, otherPlan])]);

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Ambiguous"), deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.equal(result.kind, "ambiguous");
  assert.match(result.reason, /2 new planning worktrees/);
  assert.equal(deps.pendingStore.values.size, 0);
});

test("clears a failed handoff and lets recovery retry or focus the target", async () => {
  let attempts = 0;
  const recoveryActions: string[][] = [];
  const deps = dependencies([
    session([primary]),
    session([primary, planned]),
    session([primary, planned], { companion: null, workspace: null }),
  ], {
    openTarget: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("open failed");
    },
    offerRecovery: async (_message, actions) => {
      recoveryActions.push([...actions]);
      return "Retry";
    },
  });

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Recover"), deps, { pollIntervalMs: 10, timeoutMs: 100 });

  assert.equal(result.kind, "complete");
  assert.equal(attempts, 2);
  assert.deepEqual(recoveryActions, [["Retry", "Focus target"]]);
  assert.equal(deps.pendingStore.values.size, 1);
});