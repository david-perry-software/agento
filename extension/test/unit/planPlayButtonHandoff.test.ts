// Issue #77 — plan-play-button-handoff. The New Plan play button in an unpromoted
// planning window hands the plan to a new session instead of the current window,
// the dispatched command carries no commands/<name>.md attachment, and the 120 s
// handoff poll times out ~2 s before a ~2 min start-session finishes.
//
// Evidence directory (companion repo): issues/2026/10/plan-play-button-handoff/evidence/.
// These three tests are the exposing regression tests from plan.md "## Approach";
// they fail before the fix and pass after it (steps 2.1–2.3).

import assert from "node:assert/strict";
import test from "node:test";

import { consumePendingCommands, dispatchCommandToTarget } from "../../src/commandDispatcher.js";
import {
  createInitiativePlanRequest,
  createNewPlanRequest,
  NEW_PLAN_FLOW_DEFAULTS,
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

test("(a) a plan-role detached session submits the new-feature / new-issue command in the current window", async () => {
  const planWorktree = { path: "/repo/worktrees/plan-current", role: "plan", isManaged: true, dirPrefix: "plan", repo: "product" };
  const planSession = session([planWorktree], {
    role: "plan",
    worktree: { path: "/repo/worktrees/plan-current", detached: true },
  });
  const requests = [
    createInitiativePlanRequest("agento-extension", "new-plan-flow"),
    createNewPlanRequest("issue", "Fix planning window handoff"),
  ];

  for (const request of requests) {
    const deps = dependencies([planSession]);
    const result = await runNewPlanFlow(request, deps, NEW_PLAN_FLOW_DEFAULTS);

    assert.deepEqual(result, {
      kind: "complete",
      command: request.command,
      target: { kind: "folder", path: "/repo/worktrees/plan-current" },
    });
    assert.deepEqual(deps.submitted, [{ command: request.command, target: { kind: "folder", path: "/repo/worktrees/plan-current" } }]);
    assert.equal(deps.pendingStore.values.size, 0);
    assert.deepEqual(deps.opened, []);
  }
});

test("(b) chat.open options attach the command file, and the no-file fallback logs the omission", async () => {
  const sentinel = "/plugin/commands/start-session.md";
  const calls: unknown[][] = [];
  const deps = {
    executeCommand: async (...args: unknown[]) => { calls.push(args); },
    reportInfo: async () => undefined,
    reportError: async () => undefined,
    pendingStore: new MemoryStore(),
    openTarget: async () => undefined,
    chatMode: () => ({ mode: "agent" }),
    output: { appendLine() {} },
    commandFile: () => ({ file: sentinel }),
  };
  const target = { kind: "folder" as const, path: "/repo" };

  await dispatchCommandToTarget("/agento start-session", target, "continue there", deps, true);

  const store = new MemoryStore();
  store.values.set(pendingDispatchKey("/repo"), { target: "/repo", command: "/agento start-session", createdAt: Date.now() });
  await consumePendingCommands(["/repo"], { ...deps, pendingStore: store });

  assert.deepEqual(calls, [
    ["workbench.action.chat.open", { query: "/agento start-session", mode: "agent", attachFiles: [sentinel] }],
    ["workbench.action.chat.open", { query: "/agento start-session", mode: "agent", attachFiles: [sentinel] }],
  ]);

  const fallbackCalls: unknown[][] = [];
  const fallbackLogs: string[] = [];
  const fallbackDeps = {
    ...deps,
    executeCommand: async (...args: unknown[]) => { fallbackCalls.push(args); },
    output: { appendLine: (line: string) => { fallbackLogs.push(line); } },
    commandFile: () => ({ file: null, reason: "no plugin root" }),
  };
  await dispatchCommandToTarget("/agento start-session", target, "continue there", fallbackDeps, true);

  assert.deepEqual(fallbackCalls, [["workbench.action.chat.open", { query: "/agento start-session", mode: "agent" }]]);
  assert.deepEqual(fallbackLogs, ["dispatch: no command file for start-session: no plugin root"]);
});

test("(c) a start-session finishing at 20:37:16.546Z after a 20:35:14.000Z submit completes under NEW_PLAN_FLOW_DEFAULTS", async () => {
  const submitAt = Date.parse("2026-10-02T20:35:14.000Z");
  const worktreeAt = Date.parse("2026-10-02T20:37:05.100Z");
  const workspaceAt = Date.parse("2026-10-02T20:37:16.546Z");
  const primary = { path: "/repo", role: "primary", isManaged: false, dirPrefix: null, repo: "product" };
  const planned = { path: "/repo/worktrees/plan-new", role: "plan", isManaged: true, dirPrefix: "plan", repo: "product" };
  const companion = { path: "/docs/worktrees/plan-new", registered: true };
  const workspacePath = "/repo/worktrees/plan-new.code-workspace";
  let now = submitAt;
  const pendingStore = new MemoryStore();
  const deps: NewPlanFlowDependencies = {
    readSession: async (cwd?: string) => {
      const exists = now >= workspaceAt;
      if (cwd) {
        return session([primary, planned], { companion, workspace: { path: workspacePath, exists } });
      }
      if (now < worktreeAt) return session([primary]);
      return session([primary, planned], { companion, workspace: { path: workspacePath, exists } });
    },
    submitCommand: async () => undefined,
    pendingStore,
    openTarget: async () => undefined,
    sleep: async (milliseconds) => { now += milliseconds; },
    now: () => now,
    isCancellationRequested: () => false,
    offerRecovery: async () => undefined,
  };
  const request = createNewPlanRequest("feature", "Add guided planning");

  const result = await runNewPlanFlow(request, deps, NEW_PLAN_FLOW_DEFAULTS);

  assert.equal(result.kind, "complete");
});
