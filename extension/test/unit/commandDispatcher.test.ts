import assert from "node:assert/strict";
import test from "node:test";

import type { CommandAction } from "../../src/commandActions.js";
import {
  consumePendingCommands,
  dispatchCommandAction,
  dispatchCommandToTarget,
  type CommandDispatcherDependencies,
} from "../../src/commandDispatcher.js";
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

function dependencies(overrides: Partial<CommandDispatcherDependencies> = {}): CommandDispatcherDependencies {
  return {
    currentWindow: () => "primary",
    loadNext: async () => ({ status: "ok", next: { window: "here", target: null } }),
    executeCommand: async () => undefined,
    reportError: async () => undefined,
    reportInfo: async () => undefined,
    output: { appendLine() {} },
    pendingStore: new MemoryStore(),
    openTarget: async () => undefined,
    chatMode: () => ({ mode: null, reason: "unused" }),
    commandFile: () => ({ file: null, reason: "unused" }),
    startSession: async () => { throw new Error("start-session must not run"); },
    offerOpenInChat: async () => undefined,
    ...overrides,
  };
}

const workspace = { kind: "workspace" as const, path: "/repo/wt/feature-widget.code-workspace" };

function startSessionNext(args: string[], then: string | null) {
  return { status: "ok", next: { command: "start-session", args, window: "here", then, target: { path: "/repo", workspace: null }, reason: "start it" } };
}

function startSessionHarness(result: unknown, overrides: Partial<CommandDispatcherDependencies> = {}) {
  const store = new MemoryStore();
  const runs: string[][] = [];
  const opened: string[] = [];
  const calls: unknown[][] = [];
  const offered: string[] = [];
  const deps = dependencies({
    pendingStore: store,
    startSession: async (args) => { runs.push(args); return result; },
    openTarget: async (target) => { opened.push(`${target.kind}:${target.path}`); },
    executeCommand: async (...args) => { calls.push(args); },
    offerOpenInChat: async (message) => { offered.push(message); return undefined; },
    ...overrides,
  });
  return { deps, store, runs, opened, calls, offered };
}

const startedOk = { status: "ok", outcome: "created", target: workspace, warnings: [] };

test("a start-session play button runs the CLI with next.args, queues next.then for the returned target, and opens it", async () => {
  for (const [args, then] of [[["feature/widget"], "/agento continue widget"], [["feature/widget", "--resume"], "/agento continue widget"], [[], "/agento continue member"]] as const) {
    const h = startSessionHarness(startedOk, { loadNext: async () => startSessionNext([...args], then) });
    const action: CommandAction = { command: "/agento start-session feature/widget", window: "here", reason: null };
    const route = await dispatchCommandAction(action, "widget", h.deps);
    assert.deepEqual(route, { kind: "start-session", command: action.command, args: [...args], then });
    assert.deepEqual(h.runs, [[...args]]);
    assert.equal((h.store.values.get(pendingDispatchKey(workspace.path)) as { command: string }).command, then);
    assert.deepEqual(h.opened, [`workspace:${workspace.path}`]);
    assert.deepEqual(h.calls, [], "nothing is submitted to chat");
  }
});

test("/agento continue from the primary runs start-session when the refreshed next says so", async () => {
  const h = startSessionHarness(startedOk, { loadNext: async () => startSessionNext(["issue/bug", "--resume"], "/agento continue bug") });
  const route = await dispatchCommandAction({ command: "/agento continue", window: "here", reason: null }, "bug", h.deps);
  assert.equal(route.kind, "start-session");
  assert.deepEqual(h.runs, [["issue/bug", "--resume"]]);
  assert.deepEqual(h.opened, [`workspace:${workspace.path}`]);
});

test("a bare /agento start-session without a slug runs plan mode and opens the target with nothing queued", async () => {
  const h = startSessionHarness(startedOk);
  const route = await dispatchCommandAction({ command: "/agento start-session", window: "here", reason: null }, undefined, h.deps);
  assert.deepEqual(route, { kind: "start-session", command: "/agento start-session", args: [], then: null });
  assert.deepEqual(h.runs, [[]]);
  assert.equal(h.store.values.size, 0);
  assert.deepEqual(h.opened, [`workspace:${workspace.path}`]);
});

test("a failed start-session shows the CLI reason with Open in chat, which submits the original command", async () => {
  const failed = { status: "failed", reason: "post-add-check", message: "companion half is registered in the product clone", fix: "git -C /repo worktree remove /docs/wt/feature-widget" };
  const action: CommandAction = { command: "/agento start-session feature/widget", window: "here", reason: null };

  const declined = startSessionHarness(failed, { loadNext: async () => startSessionNext(["feature/widget"], "/agento continue widget") });
  const route = await dispatchCommandAction(action, "widget", declined.deps);
  assert.equal(route.kind, "reject");
  assert.match((route as { reason: string }).reason, /post-add-check: companion half .* Fix: git -C \/repo worktree remove/);
  assert.deepEqual(declined.offered, [(route as { reason: string }).reason]);
  assert.deepEqual(declined.calls, []);
  assert.deepEqual(declined.opened, []);
  assert.equal(declined.store.values.size, 0);

  const accepted = startSessionHarness({ status: "rejected", reason: "primary checkout is dirty (/repo)" }, {
    loadNext: async () => startSessionNext(["feature/widget"], "/agento continue widget"),
    offerOpenInChat: async () => "Open in chat",
  });
  await dispatchCommandAction(action, "widget", accepted.deps);
  assert.deepEqual(accepted.calls, [["workbench.action.chat.open", { query: action.command }]]);
  assert.deepEqual(accepted.opened, []);
});

test("submits in-window commands without a mode when none resolves, logging the reason", async () => {
  const calls: unknown[][] = [];
  const logs: string[] = [];
  const action: CommandAction = { command: "/agento delivery-status", window: "here", reason: null };
  const route = await dispatchCommandAction(action, undefined, dependencies({
    executeCommand: async (...args) => { calls.push(args); },
    chatMode: () => ({ mode: null, reason: "no plugin root" }),
    output: { appendLine: (line) => { logs.push(line); } },
  }));
  assert.deepEqual(route, { kind: "submit", command: action.command });
  assert.deepEqual(calls, [["workbench.action.chat.open", { query: action.command }]]);
  assert.deepEqual(logs, [
    "dispatch: no mode for /agento delivery-status: no plugin root",
    "dispatch: no command file for delivery-status: unused",
  ]);
});

test("dashboard dispatch submits the command's agent as chat.open mode (issue #73 / dashboard-dispatch-agent-mode)", async () => {
  const calls: unknown[][] = [];
  const executeCommand = async (...args: unknown[]) => { calls.push(args); };
  const chatMode = (command: string) => command === "/agento delivery-status"
    ? { mode: "agent" }
    : { mode: "📋 Agento Planner" };

  const action: CommandAction = { command: "/agento new-feature widget", window: "here", reason: null };
  await dispatchCommandAction(action, undefined, dependencies({ executeCommand, chatMode }));

  const target = { kind: "folder" as const, path: "/repo" };
  await dispatchCommandToTarget("/agento delivery-status", target, "review there", {
    executeCommand,
    reportInfo: async () => undefined,
    pendingStore: new MemoryStore(),
    openTarget: async () => undefined,
    chatMode,
    commandFile: () => ({ file: null, reason: "unused" }),
    output: { appendLine() {} },
  }, true);

  const store = new MemoryStore();
  store.values.set(pendingDispatchKey("/repo"), { target: "/repo", command: "/agento new-feature widget", createdAt: Date.now() });
  await consumePendingCommands(["/repo"], {
    pendingStore: store,
    executeCommand,
    reportError: async () => undefined,
    output: { appendLine() {} },
    chatMode,
    commandFile: () => ({ file: null, reason: "unused" }),
  });

  assert.deepEqual(calls, [
    ["workbench.action.chat.open", { query: "/agento new-feature widget", mode: "📋 Agento Planner" }],
    ["workbench.action.chat.open", { query: "/agento delivery-status", mode: "agent" }],
    ["workbench.action.chat.open", { query: "/agento new-feature widget", mode: "📋 Agento Planner" }],
  ]);
});

test("persists cross-window commands before opening and offers to refocus the CLI target", async () => {
  const store = new MemoryStore();
  const events: string[] = [];
  const target = { kind: "workspace" as const, path: "/repo/feature.code-workspace" };
  const action: CommandAction = { command: "/agento review-feature widget", window: "secondary", reason: "review there" };
  const route = await dispatchCommandAction(action, "widget", dependencies({
    pendingStore: store,
    loadNext: async () => ({ status: "ok", next: { window: "secondary", target: { path: "/repo/worktree", workspace: { ...target, exists: true } }, reason: "Continue there." } }),
    openTarget: async (opened) => { events.push(`open:${opened.path}`); },
    reportInfo: async (message, label) => { events.push(`info:${message}:${label}`); return label; },
  }));
  assert.equal(route.kind, "open");
  assert.equal((store.values.get(pendingDispatchKey(target.path)) as { command: string }).command, "/agento continue widget");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [`open:${target.path}`, "info:Continue there.:Focus target", `open:${target.path}`]);
});

test("completes cross-window dispatch while the focus notification remains pending", async () => {
  const store = new MemoryStore();
  const target = { kind: "folder" as const, path: "/repo/primary" };
  let notificationShown = false;

  const completed = dispatchCommandToTarget("/agento start-session", target, "Continue there.", {
    executeCommand: async () => undefined,
    reportInfo: async () => {
      notificationShown = true;
      return new Promise<string | undefined>(() => undefined);
    },
    pendingStore: store,
    openTarget: async () => undefined,
    chatMode: () => ({ mode: null, reason: "unused" }),
    commandFile: () => ({ file: null, reason: "unused" }),
    output: { appendLine() {} },
  }, false);
  const resolvedBeforeNotification = await Promise.race([
    completed.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);

  assert.equal(resolvedBeforeNotification, true);
  assert.equal(notificationShown, true);
  assert.equal((store.values.get(pendingDispatchKey(target.path)) as { command: string }).command, "/agento start-session");
});

test("consumes one pending command before submission and surfaces discarded records", async () => {
  const store = new MemoryStore();
  const target = "/repo/worktree";
  store.values.set(pendingDispatchKey(target), { target, command: "/agento continue widget", createdAt: Date.now() });
  store.values.set(pendingDispatchKey("/repo/stale"), { target: "/repo/stale", command: "/agento continue old", createdAt: 0 });
  const calls: unknown[][] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  await consumePendingCommands([target, "/repo/stale"], {
    pendingStore: store,
    executeCommand: async (...args) => { calls.push(args); },
    reportError: async (message) => { errors.push(message); },
    output: { appendLine: (line) => { logs.push(line); } },
    chatMode: () => ({ mode: null, reason: "no plugin root" }),
    commandFile: () => ({ file: null, reason: "no plugin root" }),
  });
  assert.equal(store.values.size, 0);
  assert.deepEqual(calls, [["workbench.action.chat.open", { query: "/agento continue widget" }]]);
  assert.deepEqual(logs, [
    "Discarded pending Agento command for /repo/stale: expired.",
    "dispatch: no mode for /agento continue widget: no plugin root",
    "dispatch: no command file for continue: no plugin root",
  ]);
  assert.match(errors[0]!, /expired/);
});

test("reports routing and adapter failures without submitting", async () => {
  const messages: string[] = [];
  const action: CommandAction = { command: "/agento ship widget", window: "primary", reason: "ship there" };
  const route = await dispatchCommandAction(action, "widget", dependencies({
    currentWindow: () => "secondary",
    loadNext: async () => ({ status: "blocked", reason: "roadmap changed" }),
    reportError: async (message) => { messages.push(message); },
  }));
  assert.deepEqual(route, { kind: "reject", reason: "roadmap changed" });
  assert.deepEqual(messages, ["roadmap changed"]);
});

test("clears pending state and reports when the target cannot be opened", async () => {
  const store = new MemoryStore();
  const messages: string[] = [];
  const action: CommandAction = { command: "/agento review-feature widget", window: "secondary", reason: "review there" };
  const route = await dispatchCommandAction(action, "widget", dependencies({
    pendingStore: store,
    loadNext: async () => ({ status: "ok", next: { window: "secondary", target: { path: "/repo/worktree", workspace: null } } }),
    openTarget: async () => { throw new Error("open failed"); },
    reportError: async (message) => { messages.push(message); },
  }));
  assert.equal(route.kind, "reject");
  assert.equal(store.values.size, 0);
  assert.match(messages[0]!, /open failed/);
});

test("deletes pending state before surfacing a Chat submission failure", async () => {
  const store = new MemoryStore();
  const target = "/repo/worktree";
  store.values.set(pendingDispatchKey(target), { target, command: "/agento continue widget", createdAt: Date.now() });
  const messages: string[] = [];
  await consumePendingCommands([target], {
    pendingStore: store,
    executeCommand: async () => { throw new Error("chat failed"); },
    reportError: async (message) => { messages.push(message); },
    output: { appendLine() {} },
    chatMode: () => ({ mode: null, reason: "unused" }),
    commandFile: () => ({ file: null, reason: "unused" }),
  });
  assert.equal(store.values.size, 0);
  assert.match(messages[0]!, /chat failed/);
});