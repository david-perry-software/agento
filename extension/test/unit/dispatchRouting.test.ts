import assert from "node:assert/strict";
import test from "node:test";

import type { CommandAction } from "../../src/commandActions.js";
import { routeCommandAction } from "../../src/dispatchRouting.js";

const here: CommandAction = { command: "/agento build-feature widget", window: "here", reason: null };
const elsewhere: CommandAction = { command: "/agento review-feature widget", window: "secondary", reason: "review there" };

function next(window: "here" | "primary" | "secondary", target: unknown = null) {
  return { status: "ok", next: { window, target, reason: `route ${window}` } };
}

test("submits the exact selected command when the refreshed target is here", () => {
  assert.deepEqual(routeCommandAction(here, { currentWindow: "secondary", slug: "widget", next: next("here") }), {
    kind: "submit",
    command: "/agento build-feature widget",
  });
  assert.deepEqual(
    routeCommandAction({ command: "/agento ap bug", window: "here", reason: "unattended" }, { currentWindow: "secondary", slug: "bug", next: next("here") }),
    {
      kind: "submit",
      command: "/agento ap bug",
    },
  );
  assert.deepEqual(routeCommandAction({ command: "/agento delivery-status", window: "here", reason: null }, { currentWindow: "primary" }), {
    kind: "submit",
    command: "/agento delivery-status",
  });
});

test("uses continue and the CLI target for primary and secondary handoffs", () => {
  assert.deepEqual(
    routeCommandAction(elsewhere, {
      currentWindow: "secondary",
      slug: "widget",
      next: next("primary", { path: "/repo", workspace: null }),
    }),
    {
      kind: "open",
      command: "/agento continue widget",
      window: "primary",
      target: { kind: "folder", path: "/repo" },
      reason: "route primary",
    },
  );
  assert.deepEqual(
    routeCommandAction(elsewhere, {
      currentWindow: "primary",
      slug: "widget",
      next: next("secondary", { path: "/repo/worktree", workspace: { path: "/repo/worktree.code-workspace", exists: true } }),
    }),
    {
      kind: "open",
      command: "/agento continue widget",
      window: "secondary",
      target: { kind: "workspace", path: "/repo/worktree.code-workspace" },
      reason: "route secondary",
    },
  );
});

test("falls back to the target folder when the workspace is missing", () => {
  const route = routeCommandAction(elsewhere, {
    currentWindow: "primary",
    slug: "widget",
    next: next("secondary", { path: "/repo/worktree", workspace: { path: "/repo/worktree.code-workspace", exists: false } }),
  });
  assert.deepEqual(route, {
    kind: "open",
    command: "/agento continue widget",
    window: "secondary",
    target: { kind: "folder", path: "/repo/worktree" },
    reason: "route secondary",
  });
});

test("a stale cross-window action follows a refreshed here target with continue", () => {
  assert.deepEqual(routeCommandAction(elsewhere, { currentWindow: "primary", slug: "widget", next: next("here") }), {
    kind: "submit",
    command: "/agento continue widget",
  });
});

test("rejects blocked, malformed, targetless, and non-primary ship routes", () => {
  const ship: CommandAction = { command: "/agento ship widget", window: "primary", reason: "ship there" };
  assert.deepEqual(routeCommandAction(ship, { currentWindow: "secondary", slug: "widget", next: next("secondary", { path: "/worktree" }) }), {
    kind: "reject",
    reason: "Ship commands run only in the primary window.",
  });
  assert.deepEqual(routeCommandAction(ship, { currentWindow: "secondary", slug: "widget", next: next("here") }), {
    kind: "reject",
    reason: "Ship commands run only in the primary window.",
  });
  assert.deepEqual(routeCommandAction(elsewhere, { currentWindow: "primary", slug: "widget", next: { status: "blocked", reason: "roadmap changed" } }), {
    kind: "reject",
    reason: "roadmap changed",
  });
  assert.equal(routeCommandAction(elsewhere, { currentWindow: "primary", slug: "widget", next: next("secondary") }).kind, "reject");
  assert.equal(routeCommandAction(elsewhere, { currentWindow: "primary" }).kind, "reject");
});