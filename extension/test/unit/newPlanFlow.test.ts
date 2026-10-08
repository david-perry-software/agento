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
import { OPEN_IN_CHAT } from "../../src/startSessionCli.js";

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
const companionHalf = { path: "/docs/worktrees/plan-new", role: "plan", isManaged: true, dirPrefix: "plan", repo: "companion" };

function session(worktrees: unknown[], extras: Record<string, unknown> = {}): unknown {
  return { status: "ok", worktrees, ...extras };
}

function started(target: NewPlanTarget): unknown {
  return { status: "ok", mode: "plan", subject: "20261008-000113", outcome: "created", target, warnings: [] };
}

function dependencies(snapshot: unknown, startResult: unknown, overrides: Partial<Omit<NewPlanFlowDependencies, "pendingStore">> = {}) {
  const pendingStore = new MemoryStore();
  const submitted: Array<{ command: string; target: NewPlanTarget }> = [];
  const opened: NewPlanTarget[] = [];
  const runs: Array<{ args: string[]; root: string }> = [];
  const offered: string[] = [];
  const value: NewPlanFlowDependencies & {
    pendingStore: MemoryStore;
    submitted: typeof submitted;
    opened: typeof opened;
    runs: typeof runs;
    offered: typeof offered;
  } = {
    readSession: async () => snapshot,
    startSession: async (args, root) => {
      runs.push({ args, root });
      if (startResult instanceof Error) throw startResult;
      return startResult;
    },
    submitCommand: async (command, target) => { submitted.push({ command, target }); },
    pendingStore,
    openTarget: async (target) => { opened.push(target); },
    now: () => 1,
    offerRecovery: async () => undefined,
    offerOpenInChat: async (message) => { offered.push(message); return undefined; },
    submitted,
    opened,
    runs,
    offered,
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

test("runs start-session in the CLI-reported primary and hands the plan to the returned companion workspace", async () => {
  const workspace: NewPlanTarget = { kind: "workspace", path: "/repo/worktrees/plan-new.code-workspace" };
  const deps = dependencies(session([primary, existing, companionHalf]), started(workspace));
  const request = createNewPlanRequest("feature", "Add guided planning");

  const result = await runNewPlanFlow(request, deps);

  assert.deepEqual(result, { kind: "complete", command: request.command, target: workspace });
  assert.deepEqual(deps.runs, [{ args: [], root: "/repo" }]);
  assert.deepEqual(deps.submitted, [], "a successful start never goes through chat");
  assert.deepEqual(deps.opened, [workspace]);
  assert.equal((deps.pendingStore.values.get(pendingDispatchKey(workspace.path)) as { command: string }).command, request.command);
  assert.deepEqual(deps.offered, []);
});

test("opens the returned product folder when start-session reports no pair", async () => {
  const folder: NewPlanTarget = { kind: "folder", path: "/repo/worktrees/plan-new" };
  const deps = dependencies(session([primary]), started(folder));

  const result = await runNewPlanFlow(createNewPlanRequest("issue", "Fix launch"), deps);

  assert.equal(result.kind, "complete");
  assert.deepEqual(deps.opened, [folder]);
});

test("a rejected start-session shows the CLI reason with Open in chat and writes nothing", async () => {
  const deps = dependencies(session([primary]), {
    status: "rejected",
    reason: "primary checkout is dirty (/repo); commit, stash, or discard its changes first",
    allowed: ["/agento start-session"],
  });
  const request = createNewPlanRequest("feature", "Dirty primary");

  const result = await runNewPlanFlow(request, deps);

  assert.equal(result.kind, "failed");
  assert.match((result as { reason: string }).reason, /^Unable to start a planning session: primary checkout is dirty/);
  assert.equal((result as { reported?: boolean }).reported, true);
  assert.deepEqual(deps.offered, [(result as { reason: string }).reason]);
  assert.deepEqual(deps.submitted, []);
  assert.deepEqual(deps.opened, []);
  assert.equal(deps.pendingStore.values.size, 0);
});

test("Open in chat submits /agento start-session to the primary after a failed start", async () => {
  const deps = dependencies(session([primary]), {
    status: "failed",
    reason: "post-add-check",
    message: "companion half /docs/wt/plan-1 is registered in the product clone",
    fix: "git -C /repo worktree remove /docs/wt/plan-1",
  }, { offerOpenInChat: async () => OPEN_IN_CHAT });

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Wrong clone"), deps);

  assert.equal(result.kind, "failed");
  assert.match((result as { reason: string }).reason, /post-add-check: companion half .* Fix: git -C \/repo worktree remove \/docs\/wt\/plan-1/);
  assert.deepEqual(deps.submitted, [{ command: "/agento start-session", target: { kind: "folder", path: "/repo" } }]);
  assert.deepEqual(deps.opened, []);
});

test("a CLI error (timeout, spawn failure) is reported like a failed start", async () => {
  const deps = dependencies(session([primary]), new Error("Agento CLI timed out"));

  const result = await runNewPlanFlow(createNewPlanRequest("feature", "Slow network"), deps);

  assert.equal(result.kind, "failed");
  assert.match((result as { reason: string }).reason, /Agento CLI timed out/);
  assert.equal(deps.offered.length, 1);
  assert.equal(deps.pendingStore.values.size, 0);
});

test("clears a failed handoff and lets recovery retry or focus the target", async () => {
  for (const choice of ["Retry", "Focus target"] as const) {
    let attempts = 0;
    const recoveryActions: string[][] = [];
    const folder: NewPlanTarget = { kind: "folder", path: "/repo/worktrees/plan-new" };
    const deps = dependencies(session([primary]), started(folder), {
      openTarget: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("open failed");
      },
      offerRecovery: async (_message, actions) => {
        recoveryActions.push([...actions]);
        return choice;
      },
    });

    const result = await runNewPlanFlow(createNewPlanRequest("feature", "Recover"), deps);

    assert.equal(result.kind, "complete");
    assert.equal(attempts, 2);
    assert.deepEqual(recoveryActions, [["Retry", "Focus target"]]);
    assert.equal((deps.pendingStore.values.get(pendingDispatchKey(folder.path)) as { command: string }).command, "/agento new-feature Recover");
  }
});

test("runs start-session for non-plan roles and attached plan windows", async () => {
  const folder: NewPlanTarget = { kind: "folder", path: "/repo/worktrees/plan-new" };
  const buildDeps = dependencies(session([primary, existing], { role: "build", worktree: { path: existing.path, detached: false } }), started(folder));
  assert.equal((await runNewPlanFlow(createNewPlanRequest("feature", "From build"), buildDeps)).kind, "complete");
  assert.deepEqual(buildDeps.runs, [{ args: [], root: "/repo" }]);

  const planDeps = dependencies(session([primary], { role: "plan", worktree: { path: "/repo/worktrees/plan-current", detached: false } }), started(folder));
  assert.equal((await runNewPlanFlow(createNewPlanRequest("issue", "From attached plan"), planDeps)).kind, "complete");
  assert.deepEqual(planDeps.runs, [{ args: [], root: "/repo" }]);
  assert.deepEqual(planDeps.submitted, []);
});

test("rejects a malformed session role or worktree field without running the CLI", async () => {
  const badRole = dependencies(session([primary], { role: 42 }), started({ kind: "folder", path: "/x" }));
  const badRoleResult = await runNewPlanFlow(createNewPlanRequest("feature", "Bad role"), badRole);
  assert.equal(badRoleResult.kind, "failed");
  assert.match((badRoleResult as { reason: string }).reason, /session role is invalid/);
  assert.deepEqual(badRole.runs, []);

  const badWorktree = dependencies(session([primary], { worktree: { path: "/repo", detached: "yes" } }), started({ kind: "folder", path: "/x" }));
  const badWorktreeResult = await runNewPlanFlow(createNewPlanRequest("feature", "Bad worktree"), badWorktree);
  assert.equal(badWorktreeResult.kind, "failed");
  assert.match((badWorktreeResult as { reason: string }).reason, /session worktree is invalid/);
});
