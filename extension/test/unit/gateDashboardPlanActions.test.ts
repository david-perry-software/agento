// Issue #84 — gate-dashboard-plan-actions. New Plan, New Initiative, and Plan are
// shown and runnable in every window, so from a build, freehand, or unmanaged window
// they open a duplicate primary window and leave stray pending commands behind.
//
// Evidence directory (companion repo): issues/2026/10/gate-dashboard-plan-actions/evidence/.
// These four tests are the exposing regression tests from plan.md "## Approach";
// they fail before the fix and pass after it (steps 2.1–2.3).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CLOSED_GATE, gateRejection, windowGate, type GatedCommand, type WindowGate } from "../../src/windowGate.js";

interface MenuEntry {
  command: string;
  when: string;
  group?: string;
}

const GATED: GatedCommand[] = ["agento.newPlan", "agento.newInitiative", "agento.planInitiativeMember"];

function session(role: string, worktree: unknown = { detached: false }, extra: Record<string, unknown> = {}): unknown {
  return { status: "ok", role, hosted: false, worktree, ...extra };
}

test("(a) manifest gates New Plan, New Initiative, and Plan on the window role keys", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: { menus: Record<string, MenuEntry[] | undefined> };
  };
  const menus = manifest.contributes.menus;
  const titles = menus["view/title"] ?? [];
  const items = menus["view/item/context"] ?? [];

  const newPlan = titles.filter((entry) => entry.command === "agento.newPlan");
  assert.equal(newPlan.length, 2);
  for (const entry of newPlan) assert.match(entry.when, /&& agento\.canPlan$/, entry.when);

  const newInitiative = titles.filter((entry) => entry.command === "agento.newInitiative");
  assert.equal(newInitiative.length, 1);
  assert.match(newInitiative[0].when, /&& agento\.primary$/, newInitiative[0].when);

  const plan = items.filter((entry) => entry.command === "agento.planInitiativeMember");
  assert.equal(plan.length, 1);
  assert.match(plan[0].when, /&& agento\.canPlan$/, plan[0].when);

  assert.deepEqual(menus.commandPalette, [
    { command: "agento.newPlan", when: "agento.canPlan" },
    { command: "agento.newInitiative", when: "agento.primary" },
    { command: "agento.planInitiativeMember", when: "false" },
  ]);
});

test("(b) windowGate opens only for primary and unpromoted plan windows, fail-closed otherwise", () => {
  assert.deepEqual(windowGate(session("primary")), { primary: true, canPlan: true });
  assert.deepEqual(windowGate(session("plan", { detached: true })), { primary: false, canPlan: true });

  const closed: Array<[string, unknown]> = [
    ["plan attached", session("plan", { detached: false })],
    ["build", session("build")],
    ["promoted plan worktree", session("build", { detached: false, dirPrefix: "plan" })],
    ["freehand", session("freehand")],
    ["unmanaged", session("unmanaged")],
    ["hosted build", session("build", { detached: false }, { hosted: true })],
    ["failed", { status: "failed", role: "primary", worktree: { detached: false } }],
    ["undefined", undefined],
    ["null", null],
    ["no role", { status: "ok", worktree: { detached: true } }],
    ["plan without worktree", { status: "ok", role: "plan" }],
    ["plan with malformed worktree", session("plan", "detached")],
    ["plan with string detached", session("plan", { detached: "true" })],
  ];
  for (const [label, record] of closed) {
    assert.deepEqual(windowGate(record), CLOSED_GATE, label);
  }
});

test("(c) gateRejection names the primary window whenever a command's key is closed", () => {
  const planOnly: WindowGate = { primary: false, canPlan: true };
  const open: WindowGate = { primary: true, canPlan: true };

  for (const command of GATED) {
    assert.match(gateRejection(command, CLOSED_GATE) ?? "", /primary window/, command);
    assert.equal(gateRejection(command, open), undefined, command);
  }
  assert.equal(
    gateRejection("agento.newInitiative", planOnly),
    "New Initiative runs only in the primary window: switch to the primary window and run it there.",
  );
  assert.equal(gateRejection("agento.newPlan", planOnly), undefined);
  assert.equal(gateRejection("agento.planInitiativeMember", planOnly), undefined);
  assert.equal(
    gateRejection("agento.newPlan", CLOSED_GATE),
    "New Plan runs only in the primary window or an unpromoted plan window: switch to the primary window and run it there.",
  );
  assert.equal(
    gateRejection("agento.planInitiativeMember", CLOSED_GATE),
    "Plan runs only in the primary window or an unpromoted plan window: switch to the primary window and run it there.",
  );
});

test("(d) extension.ts sets the context keys fail-closed and guards each handler first", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.match(source, /executeCommand\("setContext", "agento\.primary", /);
  assert.match(source, /executeCommand\("setContext", "agento\.canPlan", /);

  const closedAtActivation = source.indexOf("applyGate(CLOSED_GATE)");
  const firstRefresh = source.indexOf("scheduler.refreshNow(\"activate\")");
  assert.ok(closedAtActivation >= 0, "applyGate(CLOSED_GATE) is called");
  assert.ok(firstRefresh > closedAtActivation, "the closed gate is applied before the first refresh");

  assert.match(source, /gate: windowGate\(sessionResult\.json\)/);
  assert.match(source, /applyGate\(snapshot\.gate\)/);
  assert.match(source, /\(error\) => \{\s*applyGate\(CLOSED_GATE\);/, "the refresh error path closes the gate");

  const handlers: Array<[GatedCommand, RegExp]> = [
    ["agento.newPlan", /newPlanPrompts\.|newPlanRunner\(/],
    ["agento.newInitiative", /newInitiativePrompts\.|newInitiativeRunner\(/],
    ["agento.planInitiativeMember", /Only ready initiative members|newPlanRunner\(/],
  ];
  for (const [command, firstAction] of handlers) {
    const start = source.search(new RegExp(`registerCommand\\(\\s*"${command.replace(".", "\\.")}"`));
    assert.ok(start >= 0, `${command} is registered`);
    const body = source.slice(start);
    const guard = body.indexOf(`gateRejection("${command}"`);
    const action = body.search(firstAction);
    assert.ok(guard >= 0, `${command} calls gateRejection`);
    assert.ok(guard < action, `${command} checks the gate before any prompt or runner`);
  }
});
