import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  baseEnv,
  cli,
  git,
  inRepoDelivery,
  makePairRepo,
  makeRepo,
  makeWorktreeRepo,
  okStubs,
  pairDelivery,
  restrictedPath,
} from "../test-helpers/agento-fixtures.mjs";

const byteLength = (text) => Buffer.byteLength(text, "utf8");

function runBrief(cwd, env, ...args) {
  const result = spawnSync("node", [cli, "brief", ...args], { cwd, encoding: "utf8", env: env ?? baseEnv });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// A build window on feature/widget with an in-repo roadmap.
function buildWindow() {
  const { repo, wt } = makeWorktreeRepo();
  const delivery = inRepoDelivery({ repo, wt }, "widget", { status: "in-progress" });
  const env = restrictedPath(okStubs).env;
  return { repo, owner: delivery.owner, env };
}

test("brief exits 1 listing every /agento <name> for an unknown command", () => {
  const repo = makeRepo({});
  const result = runBrief(repo, restrictedPath(okStubs).env, "no-such-command");
  assert.equal(result.code, 1);
  assert.match(result.out, /"status": "usage-error"/);
  assert.match(result.out, /\/agento build-feature/);
  assert.match(result.out, /\/agento review-issue/);
});

test("brief's router form prints only a Dispatch block for a subagent command", () => {
  const { owner, env } = buildWindow();
  const result = runBrief(owner, env, "build-feature", "widget");
  assert.equal(result.code, 0);
  assert.match(result.out, /^Dispatch: 🔨 Agento Builder$/m);
  assert.match(result.out, /copilotModel:/);
  assert.match(result.out, /subagentModel:/);
  assert.match(result.out, /^Prompt: Run `\/agento build-feature widget`/m);
  assert.doesNotMatch(result.out, /Receipt:/);
});

test("brief --as-subagent prints the receipt, session, delivery, and current step within budget", () => {
  const { owner, env } = buildWindow();
  const result = runBrief(owner, env, "build-feature", "widget", "--as-subagent");
  assert.equal(result.code, 0);
  assert.match(result.out, /^Receipt: accepted build-feature:widget:/m);
  assert.match(result.out, /Session:/);
  assert.match(result.out, /Delivery:/);
  assert.match(result.out, /- current step:/);
  assert.ok(byteLength(result.out) <= 7000, `page 1 is ${byteLength(result.out)} bytes`);
});

test("brief --json reports pages, onDemand, and per-block placement", () => {
  const { owner, env } = buildWindow();
  const result = runBrief(owner, env, "build-feature", "widget", "--as-subagent", "--json");
  assert.equal(result.code, 0);
  const json = JSON.parse(result.out);
  assert.equal(json.status, "ok");
  assert.equal(json.command, "build-feature");
  assert.equal(json.dispatch, "subagent");
  assert.ok(json.pages >= 1);
  assert.ok(json.delivery.total >= 1);
  assert.ok(json.delivery.ticked >= 0 && json.delivery.ticked <= json.delivery.total);
  assert.ok(Array.isArray(json.blocks));
  assert.ok(json.blocks.some((b) => b.kind === "command"));
  assert.ok(Array.isArray(json.onDemand));
});

test("brief rejects a window mismatch with the receipt and exit 3", () => {
  const repo = makeRepo({});
  const result = runBrief(repo, restrictedPath(okStubs).env, "build-feature", "widget", "--as-subagent");
  assert.equal(result.code, 3);
  assert.match(result.out, /^Receipt: rejected/);
});

test("brief rejects a hard-capability fail (no gh) with the receipt and exit 3", () => {
  const { owner } = buildWindow();
  const result = runBrief(owner, restrictedPath().env, "build-feature", "widget", "--as-subagent");
  assert.equal(result.code, 3);
  assert.match(result.out, /^Receipt: rejected — gh:/);
});

test("brief shows the companion half in companion mode", () => {
  const pair = makePairRepo();
  const delivery = pairDelivery(pair, "widget", { status: "in-progress" });
  const result = runBrief(delivery.owner, restrictedPath(okStubs).env, "build-feature", "widget", "--as-subagent");
  assert.equal(result.code, 0);
  assert.match(result.out, /- companion: /);
  assert.match(result.out, /Delivery:/);
});

test("brief pages an inline-as-agent command (Planner) within budget", () => {
  const { repo, wt } = makeWorktreeRepo();
  git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "plan-1"), "origin/main");
  const plan = path.join(wt, "plan-1");
  const result = runBrief(plan, restrictedPath(okStubs).env, "new-feature");
  assert.equal(result.code, 0);
  assert.match(result.out, /^Receipt: accepted new-feature:/m);
  assert.ok(byteLength(result.out) <= 7000, `page 1 is ${byteLength(result.out)} bytes`);
  assert.match(result.out, /--page 2/); // the Planner body is larger than one page
});

test("every command's brief pages stay within the budget in a window that accepts it", () => {
  const primary = makeRepo({});
  const nonDefault = makeRepo({});
  git(nonDefault, "switch", "-q", "-c", "changes/x");

  const { repo, wt } = makeWorktreeRepo();
  git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "plan-1"), "origin/main");
  git(repo, "worktree", "add", "-q", "-b", "changes/fh", path.join(wt, "freehand-1"), "origin/main");
  const plan = path.join(wt, "plan-1");
  const freehand = path.join(wt, "freehand-1");
  const build = inRepoDelivery({ repo, wt }, "widget", { status: "in-progress" }).owner;

  const env = restrictedPath(okStubs).env;

  // [command, argument, cwd, --as-subagent?]
  const cases = [
    ["agento-init", null, primary, false],
    ["delivery-status", null, primary, false],
    ["doctor", null, primary, false],
    ["extend-copilot", null, primary, false],
    ["fix-copilot", null, primary, false],
    ["install-skills", null, primary, false],
    ["mission-control", null, primary, false],
    ["models", null, primary, false],
    ["next-feature", null, primary, false],
    ["triage-followups", null, primary, false],
    ["close-session", null, primary, false],
    ["ship", null, primary, false],
    ["new-initiative", null, primary, false],
    ["quick-fix", null, primary, false],
    ["start-freehand", null, primary, false],
    ["start-session", null, primary, false],
    ["continue", null, primary, false],
    ["commit-current-changes", null, nonDefault, false],
    ["new-feature", null, plan, false],
    ["new-issue", null, plan, false],
    ["finish-freehand", null, freehand, false],
    ["ap", "widget", build, false],
    ["build-feature", "widget", build, true],
    ["build-issue", "widget", build, true],
    ["review-feature", "widget", build, true],
    ["review-issue", "widget", build, true],
  ];
  assert.equal(cases.length, 26, `expected 26 commands, got ${cases.length}`);

  for (const [command, argument, cwd, asSubagent] of cases) {
    const args = [command];
    if (argument) args.push(argument);
    if (asSubagent) args.push("--as-subagent");

    const json = JSON.parse(runBrief(cwd, env, ...args, "--json").out);
    assert.equal(json.status, "ok", `${command} should be accepted, got ${JSON.stringify(json.receipt)}`);
    const total = json.pages;
    assert.ok(total >= 1, `${command} should have at least one page`);
    for (let page = 1; page <= total; page += 1) {
      const pageOut = runBrief(cwd, env, ...args, "--page", String(page)).out;
      assert.ok(byteLength(pageOut) <= 7000, `${command} page ${page}/${total} is ${byteLength(pageOut)} bytes`);
    }
    if (total > 1) {
      const first = runBrief(cwd, env, ...args).out;
      assert.match(first, /--page 2/, `${command} page 1 footer must name page 2`);
    }
  }
});
