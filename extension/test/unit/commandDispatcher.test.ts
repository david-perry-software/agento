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
    ...overrides,
  };
}

test("submits in-window commands to Chat in agent mode", async () => {
  const calls: unknown[][] = [];
  const action: CommandAction = { command: "/agento delivery-status", window: "here", reason: null };
  const route = await dispatchCommandAction(action, undefined, dependencies({
    executeCommand: async (...args) => { calls.push(args); },
  }));
  assert.deepEqual(route, { kind: "submit", command: action.command });
  assert.deepEqual(calls, [["workbench.action.chat.open", { query: action.command, mode: "agent" }]]);
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
  await consumePendingCommands([target, "/repo/stale"], {
    pendingStore: store,
    executeCommand: async (...args) => { calls.push(args); },
    reportError: async (message) => { errors.push(message); },
    output: { appendLine() {} },
  });
  assert.equal(store.values.size, 0);
  assert.deepEqual(calls, [["workbench.action.chat.open", { query: "/agento continue widget", mode: "agent" }]]);
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
  });
  assert.equal(store.values.size, 0);
  assert.match(messages[0]!, /chat failed/);
});