// Header-vs-card command split (public/actions.js): window-wide commands move to
// the header Actions menu, delivery-specific ones stay on their card.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalize } from "./snapshot.mjs";
import { HEADER_CATALOG, cardButtons, cardCommands, commandName, describeWindow, handoffTargets, headerActions, isDeliverySpecific, isOwningWindow, knownSlugs, primaryCheckout } from "./public/actions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "dashboard.json"), "utf8"));
const state = normalize(fixture);
const slugs = knownSlugs(state);

test("commandName reads the command after /agento", () => {
  assert.equal(commandName("/agento start-session feature/x --resume"), "start-session");
  assert.equal(commandName("/agento delivery-status"), "delivery-status");
  assert.equal(commandName("not a command"), null);
});

test("a command is delivery-specific when an argument names a delivery or initiative", () => {
  const known = new Set(["widget", "big-plan"]);
  assert.equal(isDeliverySpecific("/agento ship widget", known), true);
  assert.equal(isDeliverySpecific("/agento start-session feature/widget --resume", known), true);
  assert.equal(isDeliverySpecific("/agento close-session issue/widget", known), true);
  assert.equal(isDeliverySpecific("/agento continue", known), false);
  assert.equal(isDeliverySpecific("/agento finish-freehand 20261024-173037", known), false);
  assert.equal(isDeliverySpecific("/agento new-feature", known), false);
});

test("cards keep only their delivery-specific commands", () => {
  const card = state.cards.find((c) => c.slug === "mission-control-canvas");
  const { allowed, elsewhere } = cardCommands(card, slugs);
  assert.deepEqual(allowed, ["/agento build-feature mission-control-canvas", "/agento ap mission-control-canvas"]);
  assert.deepEqual(elsewhere.map((e) => e.command), ["/agento ship mission-control-canvas"]);
  for (const c of state.cards) {
    const commands = cardCommands(c, slugs).allowed;
    assert.ok(!commands.includes("/agento delivery-status"), `${c.slug} still offers delivery-status`);
    assert.ok(!commands.includes("/agento continue"), `${c.slug} still offers continue`);
  }
  const shipped = state.cards.find((c) => c.slug === "agento-router-skill");
  assert.deepEqual(cardCommands(shipped, slugs).allowed, [], "shipped cards carry only window-wide commands");
});

test("header actions enable exactly this window's window-wide allowed commands", () => {
  const actions = headerActions(state);
  const enabled = actions.filter((a) => a.enabled).map((a) => a.command);
  assert.deepEqual(enabled, ["/agento continue", "/agento delivery-status"]);
  for (const command of enabled) assert.ok(state.allowed.includes(command), `${command} must be dispatchable`);
  const disabled = actions.filter((a) => !a.enabled);
  assert.ok(disabled.every((a) => a.reason), "every disabled action has a reason");
  assert.deepEqual(new Set(actions.map((a) => commandName(a.command))), new Set(HEADER_CATALOG));
  assert.ok(!actions.some((a) => a.command.includes("mission-control-canvas")), "delivery commands never reach the header");
});

test("a freehand window enables its finish/commit commands plus the window-wide reads", () => {
  const freehand = {
    cards: [],
    session: {
      role: "freehand",
      allowed: ["/agento finish-freehand 20261024-173037", "/agento commit-current-changes", "/agento delivery-status", "/agento next-feature"],
      elsewhere: [],
    },
  };
  const actions = headerActions(freehand);
  const enabled = actions.filter((a) => a.enabled).map((a) => a.label);
  assert.deepEqual(enabled, ["delivery-status", "next-feature", "finish-freehand 20261024-173037", "commit-current-changes"]);
  const startFreehand = actions.find((a) => a.label === "start-freehand");
  assert.equal(startFreehand.enabled, false);
  assert.match(startFreehand.reason, /freehand window/);
});

test("a primary window with nothing in flight enables the whole create catalog", () => {
  const primary = {
    cards: [],
    session: {
      role: "primary",
      allowed: ["/agento continue", "/agento start-session", "/agento start-freehand", "/agento new-feature", "/agento new-issue", "/agento new-initiative", "/agento delivery-status", "/agento next-feature"],
      elsewhere: [],
    },
  };
  const actions = headerActions(primary);
  assert.ok(actions.every((a) => a.enabled));
  assert.deepEqual(actions.map((a) => a.label), HEADER_CATALOG);
});

test("an elsewhere window-wide command is listed disabled with the CLI's window and reason", () => {
  const unmanaged = { cards: [], session: { role: "unmanaged", allowed: [], elsewhere: [{ command: "/agento start-session", window: "primary", reason: "not an Agento worktree" }] } };
  const start = headerActions(unmanaged).find((a) => a.label === "start-session");
  assert.equal(start.enabled, false);
  assert.equal(start.reason, "runs in primary window — not an Agento worktree");
});

const card = (slug) => state.cards.find((c) => c.slug === slug);

test("describeWindow names the role and worktree folder", () => {
  assert.equal(describeWindow("build", "/wt/plan-20261020-120000"), "the build window (plan-20261020-120000)");
  assert.equal(describeWindow("primary"), "the primary window");
});

test("in the owning build window the card's commands run; ship stays greyed with its window", () => {
  const buttons = cardButtons(card("mission-control-canvas"), state.session, slugs);
  assert.deepEqual(buttons.map((b) => [b.command, b.enabled]), [
    ["/agento build-feature mission-control-canvas", true],
    ["/agento ap mission-control-canvas", true],
    ["/agento ship mission-control-canvas", false],
  ]);
  assert.match(buttons[2].reason, /^Runs in the primary window — after Verdict: approve/);
});

test("another worktree's delivery is greyed out naming that worktree's window", () => {
  const buttons = cardButtons(card("canvas-paused-fixture"), state.session, slugs);
  assert.ok(buttons.every((b) => !b.enabled));
  assert.equal(buttons[0].command, "/agento build-feature canvas-paused-fixture");
  assert.equal(buttons[0].reason, "Runs in the build window (plan-20261020-120000)");
});

test("a delivery without a worktree runs from the primary window only", () => {
  const planned = card("canvas-planning-fixture");
  assert.equal(isOwningWindow(planned, state.session), false);
  assert.ok(cardButtons(planned, state.session, slugs).every((b) => !b.enabled && b.reason === "Runs in the primary window"));
  const primary = { role: "primary", worktree: { path: "/home/user/DP/agento" } };
  assert.equal(isOwningWindow(planned, primary), true);
  assert.ok(cardButtons(planned, primary, slugs).every((b) => b.enabled));
});

test("a freehand window can run no delivery's commands", () => {
  const freehand = { role: "freehand", worktree: { path: "/home/david/DP/agento-worktrees/freehand-20261024-173037" } };
  for (const c of state.cards.filter((x) => x.lane !== "shipped")) {
    for (const b of cardButtons(c, freehand, slugs)) {
      assert.equal(b.enabled, false, `${b.command} must be greyed out in a freehand window`);
      assert.match(b.reason, /^Runs in the (build|primary) window/);
    }
  }
});

test("a secondary-window elsewhere entry names the delivery's own worktree window", () => {
  const owned = { slug: "widget", owner: { path: "/wt/feature-widget", role: "build" }, allowed: [], elsewhere: [{ command: "/agento build-feature widget", window: "secondary", reason: "builds run in the secondary worktree window" }] };
  const [b] = cardButtons(owned, { role: "primary", worktree: { path: "/repo" } }, new Set(["widget"]));
  assert.equal(b.reason, "Runs in the build window (feature-widget) — builds run in the secondary worktree window");
  const unowned = { ...owned, owner: null };
  assert.match(cardButtons(unowned, { role: "primary" }, new Set(["widget"]))[0].reason, /^Runs in the delivery's plan or build window/);
});

const PRIMARY = "/home/user/DP/agento";
const FREEHAND = { role: "freehand", worktree: { path: "/home/user/DP/agento-worktrees/freehand-1" }, allowed: ["/agento finish-freehand 1"], elsewhere: [] };

test("primaryCheckout reads the product primary from the worktree map", () => {
  assert.equal(primaryCheckout(state), PRIMARY);
  assert.equal(primaryCheckout({}), null);
});

test("greyed card commands carry the checkout whose window runs them; runnable and same-window ones carry none", () => {
  const buttons = cardButtons(card("mission-control-canvas"), state.session, slugs, PRIMARY);
  assert.deepEqual(buttons.map((b) => [b.command, b.checkout]), [
    ["/agento build-feature mission-control-canvas", null],
    ["/agento ap mission-control-canvas", null],
    ["/agento ship mission-control-canvas", PRIMARY],
  ]);
  assert.equal(buttons[2].windowName, "the primary window");

  const paused = cardButtons(card("canvas-paused-fixture"), FREEHAND, slugs, PRIMARY);
  assert.equal(paused[0].checkout, "/home/user/DP/agento-worktrees/plan-20261020-120000");
  assert.equal(paused[0].windowName, "the build window (plan-20261020-120000)");
  assert.equal(cardButtons(card("canvas-planning-fixture"), FREEHAND, slugs, PRIMARY)[0].checkout, PRIMARY);

  const inPrimary = { role: "primary", worktree: { path: PRIMARY } };
  const ship = cardButtons(card("canvas-paused-fixture"), inPrimary, slugs, PRIMARY).find((b) => b.command.startsWith("/agento ship"));
  assert.equal(ship.enabled, false);
  assert.equal(ship.checkout, null, "never hand off to the window you are in");
});

test("greyed header actions outside the primary window hand off to the primary checkout", () => {
  const freehandState = { ...state, session: FREEHAND };
  const actions = headerActions(freehandState);
  const start = actions.find((a) => a.label === "start-session");
  assert.equal(start.checkout, PRIMARY);
  assert.equal(start.windowName, "the primary window");
  assert.equal(actions.find((a) => a.enabled).checkout, null);
  const inPrimary = headerActions({ ...state, session: { role: "primary", worktree: { path: PRIMARY }, allowed: [], elsewhere: [] } });
  assert.ok(inPrimary.every((a) => a.checkout === null), "the primary window cannot hand off to itself");
});

test("handoffTargets maps exactly the greyed commands that have a target window", () => {
  const targets = handoffTargets({ ...state, session: FREEHAND });
  assert.deepEqual(targets.get("/agento build-feature canvas-paused-fixture"), { checkout: "/home/user/DP/agento-worktrees/plan-20261020-120000", windowName: "the build window (plan-20261020-120000)" });
  assert.equal(targets.get("/agento ship canvas-review-fixture").checkout, PRIMARY);
  assert.equal(targets.get("/agento start-freehand").checkout, PRIMARY);
  assert.equal(targets.has("/agento finish-freehand 1"), false, "runnable here, so not a handoff");
  assert.ok(![...targets.keys()].some((c) => c.includes("agento-router-skill")), "shipped deliveries offer no handoffs");
  const inBuild = handoffTargets(state);
  assert.equal(inBuild.has("/agento build-feature mission-control-canvas"), false);
  assert.equal(inBuild.get("/agento ship mission-control-canvas").checkout, PRIMARY);
});
