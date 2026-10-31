import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeRoadmap, reopenRoadmap } from "../delivery-roadmap-resolver.mjs";
import { linkType } from "../harness.mjs";
import { profilesHash, setHandoffModels, setModel } from "../model-profiles.mjs";
import { LIFECYCLES, SESSION_WORKSPACE_SETTINGS } from "../session-state.mjs";
import {
  assertDashboardMatches,
  baseEnv,
  both,
  byId,
  cli,
  cloneWithOrigin,
  commitAt,
  ciCheck,
  codes,
  commonDirOf,
  cloneState,
  companionOf,
  DONE_STEPS,
  git,
  gitLoggingPath,
  harnessFixture,
  inRepoDelivery,
  landBranch,
  legacyPins,
  makeDashboardRepo,
  makeFlipRepo,
  makePairRepo,
  makeRepo,
  makeWorktreeRepo,
  mergeCommitAt,
  MERGE,
  modelsFixture,
  okStubs,
  LATER,
  PARENT,
  pairDelivery,
  PASSING,
  prStub,
  publishBranch,
  publishPrRun,
  refState,
  releaseGh,
  releaseRoutes,
  releaseRun,
  repoRoot,
  restrictedPath,
  roadmapFor,
  RUNS,
  run,
  runWith,
  shippable,
  shipReady,
  shipRun,
  shipStub,
  stableMetrics,
  stepsOf,
  strip,
  T1,
  worktreeCount,
  workflowFile,
  worktreeListCalls,
  writeBreakdown,
  writeFile,
  writeRoadmap,
} from "../test-helpers/agento-fixtures.mjs";

function rolePinsFixture() {
  const { plugin, home, env, models, writeProfiles } = modelsFixture();
  const config = { worktrees: { dir: "../wt" }, branches: { default: "main", feature: "feature/", issue: "issue/", freehand: "changes/", postShip: "post-ship/" } };
  fs.mkdirSync(path.join(plugin, ".github"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".github", "agento.json"), JSON.stringify(config));
  git(plugin, "add", "-A");
  git(plugin, "commit", "-q", "-m", "config");
  const wtDir = path.resolve(plugin, "../wt");
  const buildWt = path.join(wtDir, "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "feature/x", buildWt);
  const freeWt = path.join(wtDir, "freehand-1");
  git(plugin, "worktree", "add", "-q", "-b", "changes/fh", freeWt);
  const pinsFrom = (cwd, ...args) => runWith({ cwd, env }, "models", ...args, "--plugin-root", plugin);
  return { plugin, home, env, models, writeProfiles, buildWt, freeWt, pinsFrom };
}

test("models list without a profiles file reports nothing applied", () => {
  const { plugin, home, models } = modelsFixture();
  const { code, json } = models();
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.verb, "list");
  assert.deepEqual(json.profiles, []);
  assert.deepEqual(json.profilesFile, { path: path.join(home, "model-profiles.json"), exists: false, hash: null });
  assert.equal(json.pluginRoot, plugin);
  assert.equal(json.active, null);
  assert.deepEqual(json.skipWorktree, []);
  assert.deepEqual(json.legacySkipWorktree, []);
  assert.equal(json.filter.installed, false);
  assert.deepEqual(json.filter.unrecorded, []);
  assert.deepEqual(json.dirty, []);
  assert.match(json.hint, /git filter.*survive pull, merge, switch, and stash/);
});

test("models list reports roles: the derived active profile and the roles file", () => {
  const { home, models, writeProfiles } = modelsFixture();
  const bare = models("list");
  assert.equal(bare.code, 0, JSON.stringify(bare.json));
  assert.equal(bare.json.roles.primary, null);
  assert.equal(bare.json.roles.secondary, null);
  assert.deepEqual(bare.json.rolesFile, { path: path.join(home, "model-roles.json"), exists: false, hash: null });
  assert.deepEqual(bare.json.rolesErrors, []);

  writeProfiles({ a: { default: "A (copilot)" } });
  assert.equal(models("apply", "a").code, 0);
  const applied = models("list");
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal(applied.json.roles.primary, "a");
  assert.equal(applied.json.roles.secondary, null);
});

test("models list reports rolesErrors for an invalid roles file but still exits 0", () => {
  const { home, models } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "Bad_Name" }));
  const { code, json } = models("list");
  assert.equal(code, 0, JSON.stringify(json));
  assert.ok(json.rolesErrors.length > 0, JSON.stringify(json.rolesErrors));
  assert.equal(json.rolesFile.exists, true);
  assert.equal(json.roles.secondary, null);
});

test("models reports profilesFile.hash and list reports copilotModels", () => {
  const { home, models, writeProfiles } = modelsFixture();
  const absent = models("list");
  assert.equal(absent.code, 0);
  assert.equal(absent.json.profilesFile.hash, null);
  assert.deepEqual(absent.json.copilotModels, {});

  writeProfiles({ mixed: { description: "d" } });
  const file = path.join(home, "model-profiles.json");
  const expected = profilesHash(fs.readFileSync(file, "utf8"));
  const listed = models("list");
  assert.equal(listed.code, 0);
  assert.equal(listed.json.profilesFile.hash, expected);
  assert.deepEqual(listed.json.copilotModels, {});

  fs.writeFileSync(file, JSON.stringify({ copilotModels: { "A (copilot)": "a" }, profiles: { mixed: {} } }));
  const withAlias = models("list");
  assert.equal(withAlias.code, 0);
  assert.deepEqual(withAlias.json.copilotModels, { "A (copilot)": "a" });
  assert.equal(withAlias.json.profilesFile.hash, profilesHash(fs.readFileSync(file, "utf8")));
});

test("models create writes only the new profile to a missing file", () => {
  const { home, models } = modelsFixture();
  const file = path.join(home, "model-profiles.json");
  const { code, json } = models("create", "a");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.verb, "create");
  assert.equal(json.written, true);
  assert.equal(json.profilesFile.exists, true);
  const text = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(text), { profiles: { a: {} } });
  assert.ok(!/[<>]/.test(text));
  assert.equal(json.profilesFile.hash, profilesHash(text));
});

test("models create empty, from a deep copy, and with --description", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ src: { description: "Source", default: "S (copilot)", agents: { planner: ["P (copilot)"] } } });
  const file = path.join(home, "model-profiles.json");

  const empty = models("create", "empty");
  assert.equal(empty.code, 0, JSON.stringify(empty.json));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).profiles.empty, {});

  const copy = models("create", "copy", "--from", "src");
  assert.equal(copy.code, 0, JSON.stringify(copy.json));
  const afterCopy = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(afterCopy.profiles.copy, afterCopy.profiles.src);
  assert.deepEqual(afterCopy.profiles.src, { description: "Source", default: "S (copilot)", agents: { planner: ["P (copilot)"] } });

  const described = models("create", "described", "--from", "src", "--description", "Override");
  assert.equal(described.code, 0, JSON.stringify(described.json));
  const afterDescribed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(afterDescribed.profiles.described.description, "Override");
  assert.deepEqual(afterDescribed.profiles.described.default, "S (copilot)");
});

test("models create exists and --from not-found exit 3", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const exists = models("create", "a");
  assert.equal(exists.code, 3);
  assert.equal(exists.json.status, "exists");
  const notFound = models("create", "b", "--from", "nope");
  assert.equal(notFound.code, 3);
  assert.equal(notFound.json.status, "not-found");
  assert.deepEqual(notFound.json.known, ["a"]);
});

test("models create --from an invalid profile is invalid", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ bad: { default: "<placeholder>" } });
  const { code, json } = models("create", "copy", "--from", "bad");
  assert.equal(code, 3);
  assert.equal(json.status, "invalid");
  assert.ok(json.errors.some((e) => /placeholder/.test(e)), JSON.stringify(json.errors));
});

test("models create honors --expect with conflict and success", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const file = path.join(home, "model-profiles.json");
  const stale = "0".repeat(64);
  const before = fs.readFileSync(file, "utf8");
  const conflict = models("create", "b", "--expect", stale);
  assert.equal(conflict.code, 3);
  assert.equal(conflict.json.status, "conflict");
  assert.equal(conflict.json.expected, stale);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const hash = profilesHash(before);
  const ok = models("create", "b", "--expect", hash);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.equal(ok.json.status, "ok");
  assert.equal(ok.json.previousHash, hash);
});

test("models create refuses an unparseable file without touching it", () => {
  const { home, models } = modelsFixture();
  const file = path.join(home, "model-profiles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const before = fs.readFileSync(file, "utf8");
  const { code, json } = models("create", "a");
  assert.equal(code, 3);
  assert.equal(json.status, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("models create on a hand-formatted file reports reformatted", () => {
  const { home, models } = modelsFixture();
  const file = path.join(home, "model-profiles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, '{"profiles":{"a":{}}}');
  const { code, json } = models("create", "b");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.reformatted, true);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes('  "profiles"'));
});

test("models create leaves no temp files and keeps the mode", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const file = path.join(home, "model-profiles.json");
  fs.chmodSync(file, 0o600);
  const { code, json } = models("create", "b");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith(".model-profiles.json.")), []);
});

test("models create works alongside the template's placeholder mixed profile", () => {
  const { home, models } = modelsFixture();
  assert.equal(models("init").code, 0);
  const { code, json } = models("create", "clean");
  assert.equal(code, 0, JSON.stringify(json));
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.ok(Object.hasOwn(parsed.profiles, "mixed"));
  assert.ok(Object.hasOwn(parsed.profiles, "clean"));
  assert.deepEqual(parsed.profiles.clean, {});
});

test("models create preserves the template's top-level key order after init", () => {
  const { home, models } = modelsFixture();
  assert.equal(models("init").code, 0);
  const { code, json } = models("create", "x");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.reformatted, false);
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed), ["copilotModels", "profiles"]);
});

test("models create keeps an existing empty copilotModels key", () => {
  const { home, models } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "model-profiles.json"), JSON.stringify({ copilotModels: {}, profiles: { a: {} } }, null, 2) + "\n");
  const { code, json } = models("create", "b");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.reformatted, false);
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed), ["copilotModels", "profiles"]);
  assert.deepEqual(parsed.copilotModels, {});
  assert.deepEqual(Object.keys(parsed.profiles), ["a", "b"]);
});

test("models create keeps a profiles-first file profiles-first", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const { code, json } = models("create", "b");
  assert.equal(code, 0, JSON.stringify(json));
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed), ["profiles"]);
  assert.deepEqual(Object.keys(parsed.profiles), ["a", "b"]);
});

test("models update replaces the profile in place from stdin", () => {
  const { home, models, modelsInput } = modelsFixture();
  assert.equal(models("init").code, 0);
  assert.equal(models("create", "other").code, 0);
  const body = JSON.stringify({ description: "Real", default: "M (copilot)", agents: { planner: "P (copilot)" } });
  const { code, json } = modelsInput(body, "update", "mixed");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.written, true);
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed.profiles), ["mixed", "other"]);
  assert.deepEqual(parsed.profiles.mixed, { description: "Real", default: "M (copilot)", agents: { planner: "P (copilot)" } });
});

test("models update rejects non-JSON and array input without touching the file", () => {
  const { home, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  const file = path.join(home, "model-profiles.json");
  const before = fs.readFileSync(file, "utf8");
  const nonJson = modelsInput("{ not json", "update", "a");
  assert.equal(nonJson.code, 3);
  assert.equal(nonJson.json.status, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const array = modelsInput("[]", "update", "a");
  assert.equal(array.code, 3);
  assert.equal(array.json.status, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("models update --dry-run validates without writing", () => {
  const { home, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  const file = path.join(home, "model-profiles.json");
  const before = fs.readFileSync(file, "utf8");
  const { code, json } = modelsInput(JSON.stringify({ default: "N (copilot)" }), "update", "a", "--dry-run");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.dryRun, true);
  assert.equal(json.written, false);
  assert.deepEqual(json.errors, []);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("models update --expect conflicts after an out-of-band write", () => {
  const { home, models, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  const file = path.join(home, "model-profiles.json");
  const show = models("show", "a");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  const hash = show.json.profilesFile.hash;
  writeProfiles({ a: { default: "Changed (copilot)" } });
  const after = fs.readFileSync(file, "utf8");
  const { code, json } = modelsInput(JSON.stringify({ default: "N (copilot)" }), "update", "a", "--expect", hash);
  assert.equal(code, 3);
  assert.equal(json.status, "conflict");
  assert.equal(fs.readFileSync(file, "utf8"), after);
});

test("models update of the applied profile reports reapply and active custom", () => {
  const { plugin, models, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  assert.equal(models("apply", "a").code, 0);
  const { code, json } = modelsInput(JSON.stringify({ default: "N (copilot)" }), "update", "a");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.activeBefore, "a");
  assert.equal(json.active, "custom");
  assert.equal(json.reapply, `agento.mjs models apply a --plugin-root ${plugin}`);
});

test("models rename rejects not-found and exists", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {}, b: {} });
  const notFound = models("rename", "nope", "x");
  assert.equal(notFound.code, 3);
  assert.equal(notFound.json.status, "not-found");
  const exists = models("rename", "a", "b");
  assert.equal(exists.code, 3);
  assert.equal(exists.json.status, "exists");
});

test("models rename keeps position and active follows by content", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" }, b: {} });
  assert.equal(models("apply", "a").code, 0);
  const { code, json } = models("rename", "a", "z");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.activeBefore, "a");
  assert.equal(json.active, "z");
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed.profiles), ["z", "b"]);
  assert.deepEqual(parsed.profiles.z, { default: "M (copilot)" });
});

test("models delete rejects not-found and the applied profile without --force", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  const file = path.join(home, "model-profiles.json");
  assert.equal(models("apply", "a").code, 0);
  const before = fs.readFileSync(file, "utf8");
  const active = models("delete", "a");
  assert.equal(active.code, 3);
  assert.equal(active.json.status, "active");
  assert.match(active.json.message, /models clear/);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const notFound = models("delete", "nope");
  assert.equal(notFound.code, 3);
  assert.equal(notFound.json.status, "not-found");
});

test("models delete --force removes the applied profile and active becomes custom", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" }, b: {} });
  assert.equal(models("apply", "a").code, 0);
  const { code, json } = models("delete", "a", "--force");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.activeBefore, "a");
  assert.equal(json.active, "custom");
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed.profiles), ["b"]);
});

test("models delete of a non-applied profile succeeds", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" }, b: {} });
  const { code, json } = models("delete", "b");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  const parsed = JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(parsed.profiles), ["a"]);
});

test("models alias set creates, updates, and remove deletes a copilotModels entry", () => {
  const { home, models } = modelsFixture();
  const file = path.join(home, "model-profiles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ profiles: { a: {} } }));

  const set1 = models("alias", "set", "A (copilot)", "a-id");
  assert.equal(set1.code, 0, JSON.stringify(set1.json));
  assert.equal(set1.json.status, "ok");
  assert.deepEqual(set1.json.copilotModels, { "A (copilot)": "a-id" });

  const set2 = models("alias", "set", "A (copilot)", "new-id");
  assert.equal(set2.code, 0, JSON.stringify(set2.json));
  assert.deepEqual(set2.json.copilotModels, { "A (copilot)": "new-id" });

  const remove = models("alias", "remove", "A (copilot)");
  assert.equal(remove.code, 0, JSON.stringify(remove.json));
  assert.deepEqual(remove.json.copilotModels, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).copilotModels, {});

  const removeUnknown = models("alias", "remove", "No Such (copilot)");
  assert.equal(removeUnknown.code, 3);
  assert.equal(removeUnknown.json.status, "not-found");
});

test("models alias set rejects an invalid id or picker", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const badId = models("alias", "set", "A (copilot)", "<x>");
  assert.equal(badId.code, 3);
  assert.equal(badId.json.status, "invalid");
  const emptyPicker = models("alias", "set", "", "a-id");
  assert.equal(emptyPicker.code, 3);
  assert.equal(emptyPicker.json.status, "invalid");
});

test("models alias picker is one argument with spaces and parentheses", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const { code, json } = models("alias", "set", "Claude Opus 5.5 (copilot)", "claude-opus-5.5");
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.copilotModels, { "Claude Opus 5.5 (copilot)": "claude-opus-5.5" });
});

test("models pins picks up a new alias as copilotModel", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { agents: { planner: "Planner Model (copilot)" } } });
  assert.equal(models("apply", "a").code, 0);
  assert.equal(models("alias", "set", "Planner Model (copilot)", "planner-copilot-id").code, 0);
  const pins = models("pins");
  assert.equal(pins.code, 0, JSON.stringify(pins.json));
  assert.equal(pins.json.pins.planner.copilotModel, "planner-copilot-id");
});

test("models init copies the template once; show reports placeholders and unknown profiles", () => {
  const { home, models } = modelsFixture();
  const first = models("init");
  assert.equal(first.code, 0);
  assert.equal(first.json.created, true);
  assert.equal(first.json.profilesFile.exists, true);
  const file = path.join(home, "model-profiles.json");
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join(repoRoot, "templates", "model-profiles.json"), "utf8"));
  fs.appendFileSync(file, " ");
  const second = models("init");
  assert.equal(second.code, 0);
  assert.equal(second.json.created, false);
  assert.match(fs.readFileSync(file, "utf8"), / $/);

  const list = models("list");
  assert.deepEqual(list.json.profiles.map((p) => p.name), ["mixed"]);
  assert.ok(list.json.profiles[0].errors.length > 0);

  const show = models("show", "mixed");
  assert.equal(show.code, 3);
  assert.equal(show.json.status, "invalid");
  assert.ok(show.json.errors.every((e) => /placeholder/.test(e)), JSON.stringify(show.json.errors));

  const unknown = models("show", "nope");
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.status, "not-found");
  assert.deepEqual(unknown.json.known, ["mixed"]);
});

test("models show resolves agents, inherited prompts, and mirrors", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap", agents: { planner: "Strong" }, prompts: { doctor: "Tiny" } } });
  const { code, json } = models("show", "mixed");
  assert.equal(code, 0, JSON.stringify(json));
  const value = (file) => json.targets.find((t) => t.file === file)?.value;
  assert.equal(value(".github/agents/delivery-planner.agent.md"), "Strong");
  assert.equal(value(".github/agents/delivery-builder.agent.md"), "Cheap");
  assert.equal(value(".github/prompts/new-feature.prompt.md"), "Strong");
  assert.equal(value("skills/agento/commands/new-feature.md"), "Strong");
  assert.equal(value(".github/prompts/doctor.prompt.md"), "Tiny");
  assert.equal(value("skills/agento/commands/doctor.md"), "Tiny");
  assert.equal(value(".github/prompts/start-session.prompt.md"), "Cheap");
});

test("models show reports the stored body and update round-trips through it", () => {
  const { models, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  const empty = models("show", "a");
  assert.equal(empty.code, 0, JSON.stringify(empty.json));
  assert.deepEqual(empty.json.body, {});

  const body = { description: "d", default: "M (copilot)", agents: { planner: ["A (copilot)", "B (copilot)"] }, prompts: { doctor: "T (copilot)" } };
  const updated = modelsInput(JSON.stringify(body), "update", "a");
  assert.equal(updated.code, 0, JSON.stringify(updated.json));
  const shown = models("show", "a");
  assert.equal(shown.code, 0, JSON.stringify(shown.json));
  assert.deepEqual(shown.json.body, body);
});

test("models list entries carry warnings and targets matching models show", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { description: "d", default: "Cheap", agents: { planner: "Strong" }, prompts: { doctor: "Tiny" } } });
  const listed = models("list");
  assert.equal(listed.code, 0, JSON.stringify(listed.json));
  const entry = listed.json.profiles.find((p) => p.name === "mixed");
  assert.ok(entry, "mixed profile listed");
  const shown = models("show", "mixed");
  assert.equal(shown.code, 0, JSON.stringify(shown.json));
  assert.deepEqual(entry.targets, shown.json.targets);
  assert.deepEqual(entry.warnings, shown.json.warnings);
  // Existing fields are unchanged and the keys are exactly the expected set.
  assert.equal(entry.name, "mixed");
  assert.equal(entry.description, "d");
  assert.deepEqual(entry.errors, []);
  assert.deepEqual(Object.keys(entry).sort(), ["description", "errors", "name", "targets", "warnings"]);
});

test("models list pinnable equals the prompts update --dry-run accepts as prompts.<command>", () => {
  const { plugin, models, modelsInput, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "M (copilot)" } });
  const listed = models("list");
  assert.equal(listed.code, 0, JSON.stringify(listed.json));
  // The six agent aliases, in AGENT_ALIASES key order.
  assert.deepEqual(listed.json.pinnable.agents, ["planner", "builder", "reviewer", "autopilot", "mechanic", "architect"]);

  // Every prompt in the plugin: accepted by `prompts.<command>` unless the dry run
  // reports the custom-agent error. `pinnable.prompts` must be exactly that set.
  const promptNames = fs.readdirSync(path.join(plugin, ".github", "prompts")).filter((f) => f.endsWith(".prompt.md")).map((f) => path.basename(f, ".prompt.md"));
  assert.ok(promptNames.length > 0, "the fixture has prompts");
  const accepted = [];
  const custom = [];
  for (const name of promptNames) {
    const { code, json } = modelsInput(JSON.stringify({ prompts: { [name]: "M (copilot)" } }), "update", "a", "--dry-run");
    assert.equal(code, 0, JSON.stringify(json));
    if ((json.errors ?? []).some((e) => e.includes("inherits its model"))) custom.push(name);
    else accepted.push(name);
  }
  assert.ok(custom.length > 0, "the fixture has custom-agent prompts");
  assert.deepEqual(listed.json.pinnable.prompts, [...accepted].sort(), "pinnable.prompts is exactly the commands accepted without the custom-agent error");

  // Existing `list` fields are unchanged: same profile entry keys, and the same
  // top-level report fields as before `pinnable` was added.
  assert.equal(listed.json.status, "ok");
  assert.equal(listed.json.verb, "list");
  const entry = listed.json.profiles.find((p) => p.name === "a");
  assert.ok(entry, "profile a listed");
  assert.equal(entry.description, null);
  assert.deepEqual(entry.errors, []);
  assert.deepEqual(Object.keys(entry).sort(), ["description", "errors", "name", "targets", "warnings"]);
  assert.deepEqual(listed.json.copilotModels, {});
  assert.deepEqual(listed.json.errors, []);
  assert.equal(listed.json.profilesFile.exists, true);
});

test("models list entries for an invalid profile have empty targets and its errors", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ good: { default: "Cheap (copilot)" }, bad: { default: "<placeholder>" } });
  const { code, json } = models("list");
  assert.equal(code, 0, JSON.stringify(json));
  const bad = json.profiles.find((p) => p.name === "bad");
  assert.ok(bad, "bad profile listed");
  assert.deepEqual(bad.targets, []);
  assert.deepEqual(bad.warnings, []);
  assert.ok(bad.errors.some((e) => /placeholder/.test(e)), JSON.stringify(bad.errors));
  const good = json.profiles.find((p) => p.name === "good");
  assert.ok(good.targets.length > 0, JSON.stringify(good));
});

test("models usage errors: bad verb, arguments, profile name, and plugin root", () => {
  const { models, env, plugin } = modelsFixture();
  assert.equal(models("bogus").code, 1);
  assert.equal(models("show").code, 1);
  assert.equal(models("list", "extra").code, 1);
  assert.equal(models("pins", "extra").code, 1);
  assert.equal(models("apply", "Bad_Name").code, 1);
  const notPlugin = runWith({ cwd: plugin, env }, "models", "--plugin-root", path.dirname(plugin));
  assert.equal(notPlugin.code, 1);
  assert.match(notPlugin.json.message, /not an Agento plugin clone/);
  assert.equal(runWith({ cwd: plugin, env }, "models", "--plugin-root").code, 1);
});

test("models usage errors: options a verb does not accept", () => {
  const { models } = modelsFixture();
  const hash = "a".repeat(64);
  assert.equal(models("list", "--force").code, 1);
  assert.equal(models("show", "a", "--force").code, 1);
  assert.equal(models("apply", "a", "--expect", hash).code, 1);
  assert.equal(models("pins", "--dry-run").code, 1);
  assert.equal(models("init", "--from", "a").code, 1);
});

test("models --role usage errors: bad value, missing value, and verbs that do not accept it", () => {
  const { models } = modelsFixture();
  assert.equal(models("list", "--role", "bogus").code, 1);
  assert.equal(models("list", "--role").code, 1);
  assert.equal(models("list", "--role", "primary").code, 1);
  assert.equal(models("apply", "a", "--role", "primary").code, 1);
});

test("models use --role secondary writes and clears the roles file", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const rolesPath = path.join(home, "model-roles.json");

  const set = models("use", "a", "--role", "secondary");
  assert.equal(set.code, 0, JSON.stringify(set.json));
  assert.equal(set.json.status, "ok");
  assert.equal(set.json.verb, "use");
  assert.equal(set.json.secondaryBefore, null);
  assert.equal(set.json.written, true);
  assert.deepEqual(set.json.roles, { secondary: "a" });
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: "a" });

  const off = models("use", "none", "--role", "secondary");
  assert.equal(off.code, 0, JSON.stringify(off.json));
  assert.equal(off.json.secondaryBefore, "a");
  assert.equal(off.json.written, true);
  assert.deepEqual(off.json.roles, { secondary: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: null });
});

test("models use --role secondary rejects a missing or invalid profile without writing", () => {
  const { home, models, writeProfiles } = modelsFixture();
  const rolesPath = path.join(home, "model-roles.json");

  const missing = models("use", "missing", "--role", "secondary");
  assert.equal(missing.code, 3, JSON.stringify(missing.json));
  assert.equal(missing.json.status, "not-found");
  assert.equal(fs.existsSync(rolesPath), false);

  writeProfiles({ bad: { default: "<placeholder>" } });
  const invalid = models("use", "bad", "--role", "secondary");
  assert.equal(invalid.code, 3, JSON.stringify(invalid.json));
  assert.equal(invalid.json.status, "invalid");
  assert.equal(fs.existsSync(rolesPath), false);
});

test("models use --role secondary honors --expect", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const rolesPath = path.join(home, "model-roles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "b" }));
  const current = profilesHash(fs.readFileSync(rolesPath, "utf8"));

  const stale = models("use", "a", "--role", "secondary", "--expect", "f".repeat(64));
  assert.equal(stale.code, 3, JSON.stringify(stale.json));
  assert.equal(stale.json.status, "conflict");
  assert.equal(fs.readFileSync(rolesPath, "utf8"), JSON.stringify({ secondary: "b" }));

  const matching = models("use", "a", "--role", "secondary", "--expect", current);
  assert.equal(matching.code, 0, JSON.stringify(matching.json));
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: "a" });
});

test("models use --role secondary leaves no temp files and keeps the mode", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const rolesPath = path.join(home, "model-roles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: null }), { mode: 0o600 });
  const before = fs.statSync(rolesPath).mode;

  const { code, json } = models("use", "a", "--role", "secondary");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(fs.statSync(rolesPath).mode & 0o777, before & 0o777);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith(".model-roles.json.") && f.endsWith(".tmp")), []);
});

test("models use --role secondary replaces an invalid roles file", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const rolesPath = path.join(home, "model-roles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "a", extra: 1 }));

  const off = models("use", "none", "--role", "secondary");
  assert.equal(off.code, 0, JSON.stringify(off.json));
  assert.equal(off.json.status, "ok");
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: null });

  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: null, extra: 1 }));
  const set = models("use", "a", "--role", "secondary");
  assert.equal(set.code, 0, JSON.stringify(set.json));
  assert.equal(set.json.status, "ok");
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: "a" });
});

test("models use --role primary changes the same files as apply and clear", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });

  const apply = models("apply", "a");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  const afterApply = new Map(apply.json.changed.map((f) => [f, fs.readFileSync(path.join(plugin, f), "utf8")]));
  const clear = models("clear");
  assert.equal(clear.code, 0, JSON.stringify(clear.json));
  const afterClear = new Map(clear.json.changed.map((f) => [f, fs.readFileSync(path.join(plugin, f), "utf8")]));

  const usePrimary = models("use", "a", "--role", "primary");
  assert.equal(usePrimary.code, 0, JSON.stringify(usePrimary.json));
  assert.equal(usePrimary.json.verb, "use");
  assert.deepEqual(usePrimary.json.changed, apply.json.changed);
  for (const f of usePrimary.json.changed) assert.equal(fs.readFileSync(path.join(plugin, f), "utf8"), afterApply.get(f));

  const useNonePrimary = models("use", "none", "--role", "primary");
  assert.equal(useNonePrimary.code, 0, JSON.stringify(useNonePrimary.json));
  assert.deepEqual(useNonePrimary.json.changed, clear.json.changed);
  for (const f of useNonePrimary.json.changed) assert.equal(fs.readFileSync(path.join(plugin, f), "utf8"), afterClear.get(f));
});

test("models use --role primary from a linked worktree reports worktree", () => {
  const { plugin, env, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-models-wtbase-")), "wt");
  git(plugin, "worktree", "add", "-q", "--detach", wt, "HEAD");
  const useWt = runWith({ cwd: wt, env }, "models", "use", "a", "--role", "primary", "--plugin-root", wt);
  assert.equal(useWt.code, 3, JSON.stringify(useWt.json));
  assert.equal(useWt.json.status, "worktree");
  assert.match(useWt.json.message, /linked worktree/);
});

test("models use usage errors: missing --role and --expect with --role primary", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ a: {} });
  assert.equal(models("use", "a").code, 1);
  assert.equal(models("use", "a", "--role", "primary", "--expect", "a".repeat(64)).code, 1);
});

test("models create none and rename to none are usage errors", () => {
  const { models, writeProfiles } = modelsFixture();
  assert.equal(models("create", "none").code, 1);
  writeProfiles({ a: {} });
  assert.equal(models("rename", "a", "none").code, 1);
});

test("models pins resolves the window role in managed worktrees and the primary", () => {
  const { home, models, buildWt, freeWt, pinsFrom } = rolePinsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({
      copilotModels: { "Builder Model (copilot)": "builder-copilot-id", "Reviewer Model (copilot)": "reviewer-copilot-id" },
      profiles: { b: { agents: { builder: ["Builder Model (copilot)", "Builder Fallback (copilot)"], reviewer: "Reviewer Model (copilot)" } } },
    }),
  );
  assert.equal(models("use", "b", "--role", "secondary").code, 0);

  const build = pinsFrom(buildWt, "pins");
  assert.equal(build.code, 0, JSON.stringify(build.json));
  assert.equal(build.json.windowRole, "build");
  assert.equal(build.json.role, "secondary");
  assert.equal(build.json.roleSource, "window");
  assert.equal(build.json.source, "role-profile");
  assert.equal(build.json.profile, "b");
  assert.equal(build.json.pins.builder.subagentModel, "Builder Model (copilot)");
  assert.equal(build.json.pins.builder.copilotModel, "builder-copilot-id");
  assert.equal(build.json.pins.reviewer.subagentModel, "Reviewer Model (copilot)");
  assert.equal(build.json.pins.reviewer.copilotModel, "reviewer-copilot-id");

  const freehand = pinsFrom(freeWt, "pins");
  assert.equal(freehand.json.windowRole, "freehand");
  assert.equal(freehand.json.role, "secondary");
  assert.equal(freehand.json.source, "role-profile");

  const primary = models("pins");
  assert.equal(primary.json.windowRole, "primary");
  assert.equal(primary.json.role, "primary");
  assert.equal(primary.json.source, "file-pins");

  const flagPrimary = pinsFrom(buildWt, "pins", "--role", "primary");
  assert.equal(flagPrimary.json.roleSource, "flag");
  assert.equal(flagPrimary.json.role, "primary");
  assert.equal(flagPrimary.json.source, "file-pins");

  const flagSecondary = models("pins", "--role", "secondary");
  assert.equal(flagSecondary.json.role, "secondary");
  assert.equal(flagSecondary.json.roleSource, "flag");
  assert.equal(flagSecondary.json.source, "role-profile");
});

test("models pins falls back to file pins when the secondary role is off", () => {
  const { models, buildWt, pinsFrom } = rolePinsFixture();
  const primary = models("pins");
  const build = pinsFrom(buildWt, "pins");
  assert.equal(build.code, 0, JSON.stringify(build.json));
  assert.equal(build.json.windowRole, "build");
  assert.equal(build.json.role, "secondary");
  assert.equal(build.json.source, "file-pins");
  assert.deepEqual(build.json.pins, primary.json.pins);
  assert.deepEqual(build.json.warnings, primary.json.warnings);
});

test("models pins warns and falls back to file pins for a dangling or invalid secondary", () => {
  const { home, buildWt, pinsFrom } = rolePinsFixture();
  const rolesPath = path.join(home, "model-roles.json");
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "gone" }));
  const dangling = pinsFrom(buildWt, "pins");
  assert.equal(dangling.code, 0, JSON.stringify(dangling.json));
  assert.equal(dangling.json.source, "file-pins");
  assert.ok(dangling.json.warnings.some((w) => /models use none --role secondary/.test(w)), JSON.stringify(dangling.json.warnings));

  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "Bad_Name" }));
  const invalid = pinsFrom(buildWt, "pins");
  assert.equal(invalid.code, 0, JSON.stringify(invalid.json));
  assert.equal(invalid.json.source, "file-pins");
  assert.ok(invalid.json.warnings.some((w) => /models use none --role secondary/.test(w)), JSON.stringify(invalid.json.warnings));
});

test("models pins outside any repository reports windowRole unmanaged and role primary", () => {
  const { env, plugin } = rolePinsFixture();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agento-outside-"));
  const outside = runWith({ cwd: tmp, env }, "models", "pins", "--plugin-root", plugin);
  assert.equal(outside.code, 0, JSON.stringify(outside.json));
  assert.equal(outside.json.windowRole, "unmanaged");
  assert.equal(outside.json.role, "primary");
  assert.equal(outside.json.roleSource, "window");
});

test("models resolve returns file pins for a built-in and a custom-agent command", () => {
  const { plugin, models } = modelsFixture();
  const promptFile = (name) => path.join(plugin, ".github", "prompts", `${name}.prompt.md`);
  fs.writeFileSync(promptFile("delivery-status"), setModel(fs.readFileSync(promptFile("delivery-status"), "utf8"), "Status Model (copilot)"));
  fs.writeFileSync(promptFile("new-feature"), setModel(fs.readFileSync(promptFile("new-feature"), "utf8"), ["Planner Model (copilot)", "planner-copilot-id"]));

  const built = models("resolve", "delivery-status");
  assert.equal(built.code, 0, JSON.stringify(built.json));
  assert.equal(built.json.status, "ok");
  assert.equal(built.json.verb, "resolve");
  assert.equal(built.json.command, "delivery-status");
  assert.equal(built.json.agent, "agent");
  assert.equal(built.json.role, "primary");
  assert.equal(built.json.roleSource, "window");
  assert.equal(built.json.source, "file-pins");
  assert.equal(built.json.model, "Status Model (copilot)");
  assert.equal(built.json.qualified, "Status Model (copilot)");
  assert.equal(built.json.name, "Status Model");
  assert.equal(built.json.vendor, "copilot");

  const custom = models("resolve", "new-feature");
  assert.equal(custom.code, 0, JSON.stringify(custom.json));
  assert.equal(custom.json.agent, "📋 Agento Planner");
  assert.equal(custom.json.source, "file-pins");
  assert.deepEqual(custom.json.model, ["Planner Model (copilot)", "planner-copilot-id"]);
  assert.equal(custom.json.qualified, "Planner Model (copilot)");
  assert.equal(custom.json.name, "Planner Model");
  assert.equal(custom.json.vendor, "copilot");
});

test("models resolve --role secondary resolves prompts.<name> and the default fallback", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ b: { default: "Fallback (copilot)", prompts: { doctor: "Doctor (deepseek)" } } });
  assert.equal(models("use", "b", "--role", "secondary").code, 0);

  const named = models("resolve", "doctor", "--role", "secondary");
  assert.equal(named.code, 0, JSON.stringify(named.json));
  assert.equal(named.json.role, "secondary");
  assert.equal(named.json.roleSource, "flag");
  assert.equal(named.json.source, "role-profile");
  assert.equal(named.json.profile, "b");
  assert.equal(named.json.model, "Doctor (deepseek)");
  assert.equal(named.json.qualified, "Doctor (deepseek)");
  assert.equal(named.json.name, "Doctor");
  assert.equal(named.json.vendor, "deepseek");

  const fallback = models("resolve", "delivery-status", "--role", "secondary");
  assert.equal(fallback.code, 0, JSON.stringify(fallback.json));
  assert.equal(fallback.json.source, "role-profile");
  assert.equal(fallback.json.model, "Fallback (copilot)");
  assert.equal(fallback.json.qualified, "Fallback (copilot)");
  assert.equal(fallback.json.vendor, "copilot");
});

test("models resolve falls back to file pins when the secondary role is off", () => {
  const { plugin, models } = modelsFixture();
  const promptFile = path.join(plugin, ".github", "prompts", "doctor.prompt.md");
  fs.writeFileSync(promptFile, setModel(fs.readFileSync(promptFile, "utf8"), "File Doctor (copilot)"));

  const { code, json } = models("resolve", "doctor", "--role", "secondary");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.role, "secondary");
  assert.equal(json.source, "file-pins");
  assert.equal(json.model, "File Doctor (copilot)");
  assert.deepEqual(json.warnings, []);
});

test("models resolve warns and falls back to file pins for a dangling or invalid secondary", () => {
  const { home, models } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "gone" }));
  const dangling = models("resolve", "doctor", "--role", "secondary");
  assert.equal(dangling.code, 0, JSON.stringify(dangling.json));
  assert.equal(dangling.json.source, "file-pins");
  assert.ok(dangling.json.warnings.some((w) => /models use none --role secondary/.test(w)), JSON.stringify(dangling.json.warnings));

  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "Bad_Name" }));
  const invalid = models("resolve", "doctor", "--role", "secondary");
  assert.equal(invalid.code, 0, JSON.stringify(invalid.json));
  assert.equal(invalid.json.source, "file-pins");
  assert.ok(invalid.json.warnings.some((w) => /models use none --role secondary/.test(w)), JSON.stringify(invalid.json.warnings));
});

test("models resolve reports null model fields for an unpinned command", () => {
  const { models } = modelsFixture();
  const { code, json } = models("resolve", "doctor");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.source, "file-pins");
  assert.equal(json.model, null);
  assert.equal(json.qualified, null);
  assert.equal(json.name, null);
  assert.equal(json.vendor, null);
  assert.equal(json.copilotModel, null);
});

test("models resolve reports not-found with known and exit 3 for an unknown command", () => {
  const { models } = modelsFixture();
  const { code, json } = models("resolve", "no-such-command");
  assert.equal(code, 3);
  assert.equal(json.status, "not-found");
  assert.equal(json.command, "no-such-command");
  assert.ok(Array.isArray(json.known) && json.known.includes("doctor"), JSON.stringify(json.known));
});

test("models resolve derives copilotModel from copilotModels", () => {
  const { home, models, writeProfiles } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({ copilotModels: { "Aliased (copilot)": "aliased-id" }, profiles: { a: { prompts: { doctor: "Aliased (copilot)" } } } }),
  );
  assert.equal(models("use", "a", "--role", "secondary").code, 0);
  const { code, json } = models("resolve", "doctor", "--role", "secondary");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.qualified, "Aliased (copilot)");
  assert.equal(json.copilotModel, "aliased-id");
});

test("models resolve writes nothing", () => {
  const { plugin, models } = modelsFixture();
  const promptFile = path.join(plugin, ".github", "prompts", "doctor.prompt.md");
  fs.writeFileSync(promptFile, setModel(fs.readFileSync(promptFile, "utf8"), "Doctor (copilot)"));
  const before = git(plugin, "status", "--porcelain");
  assert.equal(models("resolve", "doctor").code, 0);
  assert.equal(models("resolve", "doctor", "--role", "secondary").code, 0);
  assert.equal(git(plugin, "status", "--porcelain"), before);
});

test("models rename moves the secondary assignment and reports secondaryBefore", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  assert.equal(models("use", "a", "--role", "secondary").code, 0);
  const rolesPath = path.join(home, "model-roles.json");

  const renamed = models("rename", "a", "b");
  assert.equal(renamed.code, 0, JSON.stringify(renamed.json));
  assert.equal(renamed.json.secondaryBefore, "a");
  assert.deepEqual(renamed.json.roles, { secondary: "b" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "model-profiles.json"), "utf8")).profiles, { b: { default: "A (copilot)" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: "b" });
});

test("models rename of a non-assigned profile leaves the roles file byte-identical", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" }, c: { default: "C (copilot)" } });
  assert.equal(models("use", "c", "--role", "secondary").code, 0);
  const rolesPath = path.join(home, "model-roles.json");
  const before = fs.readFileSync(rolesPath, "utf8");

  const renamed = models("rename", "a", "b");
  assert.equal(renamed.code, 0, JSON.stringify(renamed.json));
  assert.equal(fs.readFileSync(rolesPath, "utf8"), before);
});

test("models rename and delete --force repair an invalid roles file", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  const rolesPath = path.join(home, "model-roles.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "a", extra: 1 }));

  const renamed = models("rename", "a", "b");
  assert.equal(renamed.code, 0, JSON.stringify(renamed.json));
  assert.equal(renamed.json.status, "ok");
  assert.equal(renamed.json.secondaryBefore, "a");
  assert.deepEqual(renamed.json.roles, { secondary: "b" });
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: "b" });

  fs.writeFileSync(rolesPath, JSON.stringify({ secondary: "b", extra: 1 }));
  const deleted = models("delete", "b", "--force");
  assert.equal(deleted.code, 0, JSON.stringify(deleted.json));
  assert.equal(deleted.json.secondaryBefore, "b");
  assert.deepEqual(deleted.json.roles, { secondary: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: null });
});

test("models delete refuses the assigned secondary profile and --force turns the role off", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  assert.equal(models("use", "a", "--role", "secondary").code, 0);
  const rolesPath = path.join(home, "model-roles.json");
  const profilesPath = path.join(home, "model-profiles.json");
  const profilesBefore = fs.readFileSync(profilesPath, "utf8");
  const rolesBefore = fs.readFileSync(rolesPath, "utf8");

  const refused = models("delete", "a");
  assert.equal(refused.code, 3, JSON.stringify(refused.json));
  assert.equal(refused.json.status, "assigned");
  assert.match(refused.json.message, /models use none --role secondary/);
  assert.equal(fs.readFileSync(profilesPath, "utf8"), profilesBefore);
  assert.equal(fs.readFileSync(rolesPath, "utf8"), rolesBefore);

  const forced = models("delete", "a", "--force");
  assert.equal(forced.code, 0, JSON.stringify(forced.json));
  assert.equal(forced.json.secondaryBefore, "a");
  assert.deepEqual(forced.json.roles, { secondary: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(profilesPath, "utf8")).profiles, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(rolesPath, "utf8")), { secondary: null });
});

test("models delete reports active first when a profile is both applied and secondary", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" } });
  assert.equal(models("apply", "a").code, 0);
  assert.equal(models("use", "a", "--role", "secondary").code, 0);
  const refused = models("delete", "a");
  assert.equal(refused.code, 3, JSON.stringify(refused.json));
  assert.equal(refused.json.status, "active");
});

test("models delete of a non-assigned profile leaves the roles file untouched", () => {
  const { home, models, writeProfiles } = modelsFixture();
  writeProfiles({ a: { default: "A (copilot)" }, c: { default: "C (copilot)" } });
  assert.equal(models("use", "c", "--role", "secondary").code, 0);
  const rolesPath = path.join(home, "model-roles.json");
  const before = fs.readFileSync(rolesPath, "utf8");

  const deleted = models("delete", "a");
  assert.equal(deleted.code, 0, JSON.stringify(deleted.json));
  assert.equal(fs.readFileSync(rolesPath, "utf8"), before);
});

test("models usage errors: new verb arity, malformed options, and alias sub-verbs", () => {
  const { models } = modelsFixture();
  // Wrong arity for each new verb.
  assert.equal(models("create").code, 1);
  assert.equal(models("update").code, 1);
  assert.equal(models("rename", "a").code, 1);
  assert.equal(models("delete").code, 1);
  assert.equal(models("alias", "set", "only-picker").code, 1);
  assert.equal(models("alias", "remove").code, 1);
  // Malformed --expect and missing --from value are parser usage errors.
  assert.equal(models("create", "a", "--expect", "not-hex").code, 1);
  assert.equal(models("create", "a", "--from").code, 1);
  assert.equal(models("update", "a", "--expect", "A".repeat(64)).code, 1);
  // Unknown or missing alias sub-verb.
  assert.equal(models("alias", "bogus").code, 1);
  assert.equal(models("alias").code, 1);
});

test("models pins reads each agent's current pin and rejects an argument", () => {
  const { models, writeProfiles } = modelsFixture();
  assert.equal(models("pins", "extra").code, 1);

  // Unpinned: every model/subagentModel is null.
  const bare = models("pins");
  assert.equal(bare.code, 0, JSON.stringify(bare.json));
  assert.deepEqual(Object.keys(bare.json.pins).sort(), ["architect", "autopilot", "builder", "mechanic", "planner", "reviewer"]);
  for (const alias of Object.keys(bare.json.pins)) {
    assert.equal(bare.json.pins[alias].model, null, alias);
    assert.equal(bare.json.pins[alias].subagentModel, null, alias);
  }

  writeProfiles({ mixed: { agents: { planner: "Planner Model (copilot)", builder: "Builder Model (copilot)", reviewer: ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"], autopilot: "Autopilot Model (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  const pinned = models("pins");
  assert.equal(pinned.code, 0, JSON.stringify(pinned.json));
  assert.equal(pinned.json.pins.builder.model, "Builder Model (copilot)");
  assert.equal(pinned.json.pins.builder.subagentModel, "Builder Model (copilot)");
  assert.deepEqual(pinned.json.pins.reviewer.model, ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"]);
  assert.equal(pinned.json.pins.reviewer.subagentModel, "Reviewer Model (copilot)");
  assert.equal(pinned.json.pins.autopilot.model, "Autopilot Model (copilot)");
  assert.equal(pinned.json.pins.planner.name, "📋 Agento Planner");
  assert.equal(pinned.json.pins.builder.file, ".github/agents/delivery-builder.agent.md");
  assert.deepEqual(pinned.json.warnings, []);
});

test("models pins reports copilotModel for mapped, unmapped, and unpinned agents", () => {
  const { home, models } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({
      copilotModels: {
        "Planner Model (copilot)": "planner-copilot-id",
        "Builder Model (copilot)": "builder-copilot-id",
      },
      profiles: { mixed: { agents: { planner: "Planner Model (copilot)", builder: "Builder Model (copilot)", reviewer: "Reviewer Model (copilot)" } } },
    }),
  );
  assert.equal(models("apply", "mixed").code, 0);
  const pins = models("pins");
  assert.equal(pins.code, 0, JSON.stringify(pins.json));
  // Mapped: the copilotModels alias of the first picker entry.
  assert.equal(pins.json.pins.planner.copilotModel, "planner-copilot-id");
  assert.equal(pins.json.pins.builder.copilotModel, "builder-copilot-id");
  // Unmapped: a pinned agent whose picker name has no alias.
  assert.equal(pins.json.pins.reviewer.copilotModel, null);
  assert.equal(pins.json.pins.reviewer.subagentModel, "Reviewer Model (copilot)");
  // Unpinned: no pin at all.
  assert.equal(pins.json.pins.architect.copilotModel, null);
  assert.equal(pins.json.pins.architect.model, null);
});

test("models show, apply, and pins warn when autopilot is BYOK and delegates to a Copilot model", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { agents: { autopilot: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } });
  const show = models("show", "mixed");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  assert.equal(show.json.warnings.length, 1);
  assert.match(show.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)".*reviewer "Claude Fable 5.1 \(copilot\)"/);
  assert.match(show.json.warnings[0], /pin autopilot at least as high as the highest-tier model it delegates to/);

  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  assert.equal(apply.json.warnings.length, 1);
  assert.match(apply.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)"/);

  const pins = models("pins");
  assert.equal(pins.code, 0);
  assert.equal(pins.json.warnings.length, 1);
  assert.match(pins.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)"/);
});

test("models show, apply, and pins warn for agent pins without a Copilot alias", () => {
  const { home, models } = modelsFixture();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({
      copilotModels: { "Claude Opus 5.5 (copilot)": "claude-opus-5.5" },
      profiles: { mixed: { agents: { planner: "Claude Opus 5.5 (copilot)", builder: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } },
    }),
  );

  const show = models("show", "mixed");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  const showWarn = show.json.warnings.find((w) => /agent pins without a Copilot alias/.test(w));
  assert.ok(showWarn, JSON.stringify(show.json.warnings));
  assert.match(showWarn, /builder "DeepSeek V4 Pro \(deepseek\)" and reviewer "Claude Fable 5\.1 \(copilot\)"/);
  assert.match(showWarn, /top-level copilotModels map/);

  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.ok(apply.json.warnings.some((w) => /agent pins without a Copilot alias/.test(w)), JSON.stringify(apply.json.warnings));

  const pins = models("pins");
  assert.equal(pins.code, 0, JSON.stringify(pins.json));
  assert.ok(pins.json.warnings.some((w) => /agent pins without a Copilot alias/.test(w)), JSON.stringify(pins.json.warnings));

  // A fully aliased profile carries no missing-alias warning.
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({
      copilotModels: { "Claude Opus 5.5 (copilot)": "claude-opus-5.5", "DeepSeek V4 Pro (deepseek)": "deepseek/deepseek-v4-pro", "Claude Fable 5.1 (copilot)": "claude-fable-5.1" },
      profiles: { mixed: { agents: { planner: "Claude Opus 5.5 (copilot)", builder: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } },
    }),
  );
  const clean = models("show", "mixed");
  assert.equal(clean.code, 0, JSON.stringify(clean.json));
  assert.deepEqual(clean.json.warnings, [], JSON.stringify(clean.json.warnings));
});

test("models: the usage header lists the subcommand and keeps the full Options paragraph", () => {
  const repo = makeRepo();
  const usage = run(repo, "bogus").json.usage;
  assert.ok(usage.some((line) => line.includes("models <verb> [--plugin-root <dir>]")), JSON.stringify(usage));
  const options = usage.slice(usage.findIndex((l) => l.startsWith("Options:"))).join(" ");
  assert.match(options, /^Options: --root <dir> .* re-anchors on its product checkout\)\.$/);
});

const sBits = (plugin) => git(plugin, "ls-files", "-v").split("\n").filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
const gitQuiet = (plugin, ...args) => spawnSync("git", ["-C", plugin, ...args]).status;

const filterConfig = (plugin) => spawnSync("git", ["-C", plugin, "config", "--local", "--get-regexp", "^filter\\.agento-models\\."], { encoding: "utf8" }).stdout.trim();

const attributesBlock = (plugin) => {
  const file = path.join(commonDirOf(plugin), "info", "attributes");
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("agento model pins");
};

const pinState = (plugin) => {
  const file = path.join(commonDirOf(plugin), "agento", "model-pins.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};

const assertFilterGone = (plugin) => {
  assert.equal(filterConfig(plugin), "");
  assert.equal(attributesBlock(plugin), false);
  assert.equal(fs.existsSync(path.join(commonDirOf(plugin), "agento")), false);
  assert.deepEqual(sBits(plugin), []);
};

test("models apply pins agents, prompts, and mirrors through the git filter; clear restores HEAD", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({
    mixed: { default: "Cheap", agents: { planner: "Strong", reviewer: ["A (copilot)", "B"] }, prompts: { doctor: "Tiny" } },
    partial: { agents: { planner: "Strong" } },
  });
  const agents = fs.readdirSync(path.join(plugin, ".github", "agents"));
  const prompts = fs.readdirSync(path.join(plugin, ".github", "prompts"));
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.profile, "mixed");
  assert.equal(apply.json.active, "mixed");
  assert.equal(apply.json.changed.length, agents.length + 2 * prompts.length);
  const read = (rel) => fs.readFileSync(path.join(plugin, rel), "utf8");
  assert.match(read(".github/agents/delivery-planner.agent.md"), /^argument-hint: .*\nmodel: "Strong"\n/m);
  assert.match(read(".github/agents/delivery-reviewer.agent.md"), /^model: \["A \(copilot\)", "B"\]$/m);
  assert.match(read(".github/agents/delivery-builder.agent.md"), /^model: "Cheap"$/m);
  assert.match(read(".github/prompts/doctor.prompt.md"), /^model: "Tiny"$/m);
  assert.match(read(".github/prompts/new-feature.prompt.md"), /^model: "Strong"$/m);
  for (const p of prompts) assert.equal(read(`skills/agento/commands/${p.replace(".prompt.md", ".md")}`), read(`.github/prompts/${p}`), p);
  assert.equal(git(plugin, "status", "--porcelain"), "");
  assert.deepEqual(sBits(plugin), []);
  assert.deepEqual(apply.json.legacySkipWorktree, []);
  assert.deepEqual(apply.json.skipWorktree, []);
  assert.equal(apply.json.filter.installed, true);
  assert.equal(apply.json.filter.scriptCurrent, true);
  assert.deepEqual(apply.json.filter.unrecorded, []);
  assert.match(filterConfig(plugin), /^filter\.agento-models\.clean node "\$\(git rev-parse --path-format=absolute --git-common-dir\)\/agento\/model-filter\.mjs" clean %f$/m);
  assert.match(filterConfig(plugin), /^filter\.agento-models\.smudge node .*model-filter\.mjs" smudge %f$/m);
  assert.match(filterConfig(plugin), /^filter\.agento-models\.required true$/m);
  assert.ok(attributesBlock(plugin));
  const state = pinState(plugin);
  assert.equal(Object.keys(state.files).length, apply.json.changed.length);
  assert.equal(state.files[".github/agents/delivery-planner.agent.md"].model, "Strong");
  assert.deepEqual(state.files[".github/agents/delivery-reviewer.agent.md"].model, ["A (copilot)", "B"]);
  assert.equal(state.files["skills/agento/commands/doctor.md"].model, "Tiny");
  // The index still holds the pin-free HEAD content.
  assert.equal(git(plugin, "diff", "--cached", "--name-only", "HEAD"), "");

  const again = models("apply", "mixed");
  assert.equal(again.code, 0);
  assert.deepEqual(again.json.changed, []);
  assert.equal(models("list").json.active, "mixed");

  // Switching to a profile without a default unpins everything else; the state records it.
  const partial = models("apply", "partial");
  assert.equal(partial.code, 0, JSON.stringify(partial.json));
  assert.equal(partial.json.active, "partial");
  assert.equal(pinState(plugin).files[".github/agents/delivery-planner.agent.md"].model, "Strong");
  assert.equal(pinState(plugin).files[".github/agents/delivery-builder.agent.md"].model, null);
  assert.deepEqual(partial.json.filter.unrecorded, []);
  assert.equal(git(plugin, "status", "--porcelain"), "");

  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.equal(clear.json.profile, null);
  assert.equal(clear.json.changed.length, 5);
  assert.equal(clear.json.active, null);
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  assertFilterGone(plugin);
  assert.deepEqual(models("clear").json.changed, []);
});

test("models clear removes the filter config, attribute block, state dir, and legacy bits; a linked worktree's clear leaves the shared filter", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap (copilot)" } });
  const attributes = path.join(commonDirOf(plugin), "info", "attributes");
  fs.mkdirSync(path.dirname(attributes), { recursive: true });
  fs.writeFileSync(attributes, "*.png binary\n");
  assert.equal(models("apply", "mixed").code, 0);
  assert.ok(attributesBlock(plugin));

  // A worktree added after apply inherits the pins through the shared filter.
  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  assert.match(fs.readFileSync(path.join(linked, ".github", "agents", "delivery-builder.agent.md"), "utf8"), /^model: "Cheap \(copilot\)"$/m);
  assert.equal(git(linked, "status", "--porcelain"), "");
  const inLinked = runWith({ cwd: linked, env }, "models", "clear", "--plugin-root", linked);
  assert.equal(inLinked.code, 0, JSON.stringify(inLinked.json));
  assert.equal(inLinked.json.primaryCheckout, plugin);
  assert.ok(inLinked.json.changed.length > 0);
  assert.equal(gitQuiet(linked, "diff", "--quiet", "HEAD"), 0);
  assert.equal(git(linked, "status", "--porcelain"), "");
  assert.ok(attributesBlock(plugin), "the shared attribute block stays");
  assert.ok(pinState(plugin), "the shared pin state stays");
  assert.equal(models("list").json.active, "mixed");

  // A legacy bit left behind (an older apply) is cleared too.
  git(plugin, "update-index", "--skip-worktree", "--", "skills/agento/commands/doctor.md");
  const clear = models("clear");
  assert.equal(clear.code, 0, JSON.stringify(clear.json));
  assert.equal(clear.json.primaryCheckout, undefined);
  assert.equal(clear.json.filter.installed, false);
  assert.deepEqual(clear.json.legacySkipWorktree, []);
  assertFilterGone(plugin);
  assert.equal(fs.readFileSync(attributes, "utf8"), "*.png binary\n");
  assert.equal(gitQuiet(plugin, "diff", "--quiet", "HEAD"), 0);
  assert.equal(git(plugin, "status", "--porcelain"), "");
});

const targetBytes = (plugin) => Object.fromEntries([".github/agents", ".github/prompts", "skills/agento/commands"].flatMap((dir) => fs.readdirSync(path.join(plugin, dir)).map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(plugin, dir, f), "utf8")])));

test("models apply migrates legacy skip-worktree pins onto the filter with identical pins", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ tiny: { prompts: { doctor: "Tiny (copilot)" } } });
  legacyPins(plugin, { ".github/prompts/doctor.prompt.md": "Tiny (copilot)", "skills/agento/commands/doctor.md": "Tiny (copilot)" });
  const legacy = models("list").json;
  assert.equal(legacy.active, "tiny");
  assert.deepEqual(legacy.legacySkipWorktree, [".github/prompts/doctor.prompt.md", "skills/agento/commands/doctor.md"]);
  assert.equal(legacy.filter.installed, false);
  const before = targetBytes(plugin);

  const apply = models("apply", "tiny");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.deepEqual(apply.json.changed, []);
  assert.equal(apply.json.active, "tiny");
  assert.deepEqual(apply.json.legacySkipWorktree, []);
  assert.deepEqual(sBits(plugin), []);
  assert.equal(apply.json.filter.installed, true);
  assert.equal(pinState(plugin).files["skills/agento/commands/doctor.md"].model, "Tiny (copilot)");
  assert.deepEqual(targetBytes(plugin), before);
  assert.equal(git(plugin, "status", "--porcelain"), "");
});

test("models adopt records a legacy custom pin set as filter state with byte-identical files", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  writeProfiles({ tiny: { prompts: { doctor: "Tiny (copilot)" } } });
  legacyPins(plugin, { ".github/prompts/doctor.prompt.md": "Hand (copilot)", "skills/agento/commands/doctor.md": "Hand (copilot)", ".github/agents/delivery-builder.agent.md": ["X (copilot)", "Y"] });
  assert.equal(models("list").json.active, "custom");
  const before = targetBytes(plugin);

  const adopt = models("adopt");
  assert.equal(adopt.code, 0, JSON.stringify(adopt.json));
  assert.equal(adopt.json.verb, "adopt");
  assert.equal(adopt.json.profile, null);
  assert.deepEqual(adopt.json.changed, []);
  assert.equal(adopt.json.active, "custom");
  assert.deepEqual(adopt.json.legacySkipWorktree, []);
  assert.equal(adopt.json.filter.installed, true);
  assert.deepEqual(targetBytes(plugin), before);
  assert.equal(git(plugin, "status", "--porcelain"), "");
  const state = pinState(plugin);
  assert.equal(state.files[".github/prompts/doctor.prompt.md"].model, "Hand (copilot)");
  assert.deepEqual(state.files[".github/agents/delivery-builder.agent.md"].model, ["X (copilot)", "Y"]);
  assert.equal(state.files[".github/agents/delivery-planner.agent.md"].model, null);
  assert.deepEqual(models("adopt").json.changed, []);

  // Git's own rewrite of a pinned file brings the adopted pin back.
  fs.rmSync(path.join(plugin, "skills", "agento", "commands", "doctor.md"));
  git(plugin, "checkout", "--", "skills/agento/commands/doctor.md");
  assert.equal(fs.readFileSync(path.join(plugin, "skills", "agento", "commands", "doctor.md"), "utf8"), before["skills/agento/commands/doctor.md"]);

  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  const refused = runWith({ cwd: linked, env }, "models", "adopt", "--plugin-root", linked);
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "worktree");
  assert.match(refused.json.message, new RegExp(`--plugin-root ${plugin}$`));
});

test("models list reports a prompt added after apply in filter.unrecorded until the next apply", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap (copilot)" } });
  assert.equal(models("apply", "mixed").code, 0);
  for (const rel of [".github/prompts/zz-new.prompt.md", "skills/agento/commands/zz-new.md"]) fs.writeFileSync(path.join(plugin, rel), "---\ndescription: \"New\"\nagent: agent\n---\n\nNew.\n");
  git(plugin, "add", "-A");
  git(plugin, "commit", "-q", "-m", "new prompt");
  const list = models("list").json;
  assert.deepEqual(list.filter.unrecorded, [".github/prompts/zz-new.prompt.md", "skills/agento/commands/zz-new.md"]);
  assert.equal(list.active, "custom");
  assert.match(list.hint, /git filter.*survive.*models apply <name>/);
  assert.doesNotMatch(list.hint, /models clear/);
  assert.equal(git(plugin, "status", "--porcelain"), "");

  const reapply = models("apply", "mixed");
  assert.equal(reapply.code, 0, JSON.stringify(reapply.json));
  assert.deepEqual(reapply.json.changed, [".github/prompts/zz-new.prompt.md", "skills/agento/commands/zz-new.md"]);
  assert.deepEqual(reapply.json.filter.unrecorded, []);
  assert.equal(reapply.json.active, "mixed");
});

test("under the filter a body edit and a hand-edited model: value show in git status and make apply refuse", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap (copilot)" } });
  assert.equal(models("apply", "mixed").code, 0);
  const rel = ".github/prompts/doctor.prompt.md";
  const file = path.join(plugin, rel);
  const pinned = fs.readFileSync(file, "utf8");

  fs.writeFileSync(file, pinned.replace('model: "Cheap (copilot)"', 'model: "Edited (copilot)"'));
  assert.equal(git(plugin, "status", "--porcelain"), `M ${rel}`);
  const value = models("apply", "mixed");
  assert.equal(value.code, 3);
  assert.equal(value.json.status, "dirty");
  assert.deepEqual(value.json.dirty, [rel]);
  git(plugin, "restore", "--", rel);
  assert.equal(fs.readFileSync(file, "utf8"), pinned, "restore re-applies the recorded pin");
  assert.equal(git(plugin, "status", "--porcelain"), "");

  fs.appendFileSync(file, "\nlocal edit\n");
  assert.equal(git(plugin, "status", "--porcelain"), `M ${rel}`);
  const body = models("apply", "mixed");
  assert.equal(body.code, 3);
  assert.equal(body.json.status, "dirty");
  assert.deepEqual(body.json.dirty, [rel]);
  const adopt = models("adopt");
  assert.equal(adopt.code, 3);
  assert.equal(adopt.json.status, "dirty");
  assert.deepEqual(adopt.json.dirty, [rel]);
});

test("issue #79 autopilot-subagent-model-pins: models apply pins handoffs[].model to the target agent's model; clear removes it", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({
    mixed: {
      agents: {
        planner: "Planner Model (copilot)",
        builder: "Builder Model (copilot)",
        reviewer: ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"],
        autopilot: "Autopilot Model (copilot)",
      },
    },
  });
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  const read = (rel) => fs.readFileSync(path.join(plugin, rel), "utf8");
  // Each handoff item gains a nested model: line carrying the target agent's pin:
  // planner → builder, builder → reviewer (first entry of its list), reviewer → autopilot.
  assert.match(read(".github/agents/delivery-planner.agent.md"), /^    model: "Builder Model \(copilot\)"$/m);
  assert.match(read(".github/agents/delivery-builder.agent.md"), /^    model: "Reviewer Model \(copilot\)"$/m);
  assert.match(read(".github/agents/delivery-reviewer.agent.md"), /^    model: "Autopilot Model \(copilot\)"$/m);
  assert.equal(models("list").json.active, "mixed");
  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  assert.deepEqual(sBits(plugin), []);
});

test("models apply refuses targets edited beyond their model line", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap" } });
  assert.equal(models("apply", "mixed").code, 0);
  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  fs.appendFileSync(file, "\nlocal edit\n");
  const refused = models("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "dirty");
  assert.deepEqual(refused.json.dirty, [".github/agents/delivery-builder.agent.md"]);
  // clear still works and exposes the edit instead of hiding it.
  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.deepEqual(sBits(plugin), []);
  assert.equal(git(plugin, "status", "--porcelain"), "M .github/agents/delivery-builder.agent.md");
});

test("models apply ignores handoff model: lines in dirty detection and still refuses other edits", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { agents: { planner: "P (copilot)", builder: "B (copilot)", reviewer: "R (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  assert.deepEqual(models("list").json.dirty, []);
  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  assert.match(fs.readFileSync(file, "utf8"), /^    model: "R \(copilot\)"$/m);
  // A real edit beyond both the top-level and handoff model: lines refuses apply.
  fs.appendFileSync(file, "\nlocal edit\n");
  const refused = models("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "dirty");
  assert.deepEqual(refused.json.dirty, [".github/agents/delivery-builder.agent.md"]);
  // Dropping the local edit leaves only the applied pins, so it is clean again.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\nlocal edit\n", ""));
  assert.deepEqual(models("list").json.dirty, []);
});

test("models apply refuses a linked-worktree plugin root; clear still runs there", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap" } });
  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  const inLinked = (...args) => runWith({ cwd: linked, env }, "models", ...args, "--plugin-root", linked);
  const refused = inLinked("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "worktree");
  assert.equal(refused.json.primaryCheckout, plugin);
  assert.match(refused.json.message, new RegExp(`--plugin-root ${plugin}$`));
  assert.equal(gitQuiet(linked, "diff", "--quiet"), 0);
  assert.deepEqual(sBits(linked), []);
  const clear = inLinked("clear");
  assert.equal(clear.code, 0);
  assert.deepEqual(clear.json.changed, []);
  assert.equal(models("apply", "mixed").code, 0);
});

test("models apply on a non-git plugin root rewrites without flags", () => {
  const { plugin, models, writeProfiles } = modelsFixture({ gitInit: false });
  writeProfiles({ mixed: { default: "Cheap" } });
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.skipWorktree, null);
  assert.equal(apply.json.legacySkipWorktree, null);
  assert.equal(apply.json.filter, null);
  assert.deepEqual(apply.json.dirty, []);
  assert.ok(apply.json.changed.length > 0);
  assert.match(fs.readFileSync(path.join(plugin, ".github", "agents", "delivery-builder.agent.md"), "utf8"), /^model: "Cheap"$/m);
  assert.equal(models("clear").json.active, null);
});

test("models apply rejects the shipped template's placeholders and unknown profiles", () => {
  const { plugin, models } = modelsFixture();
  assert.equal(models("init").json.created, true);
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 3);
  assert.equal(apply.json.status, "invalid");
  assert.ok(apply.json.errors.length >= 1 && apply.json.errors.every((e) => /placeholder/.test(e)), JSON.stringify(apply.json.errors));
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  const unknown = models("apply", "nope");
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.status, "not-found");
});

test("models apply reports resolution errors for prompts on custom agents", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ bad: { prompts: { "build-feature": "X", ghost: "Y" } } });
  const apply = models("apply", "bad");
  assert.equal(apply.code, 3);
  assert.equal(apply.json.status, "invalid");
  assert.ok(apply.json.errors.some((e) => /^profiles\.bad\.prompts\.build-feature: runs on 🔨 Agento Builder/.test(e)), JSON.stringify(apply.json.errors));
  assert.ok(apply.json.errors.some((e) => /^profiles\.bad\.prompts\.ghost: no prompt named/.test(e)));
});

test("models show, apply, and pins warn once about model values without a (vendor) suffix; apply still exits 0", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Bare", agents: { planner: "P (copilot)", reviewer: ["R (copilot)", "Bare"] }, prompts: { doctor: "Tiny" } } });
  const show = models("show", "mixed");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  assert.equal(show.json.warnings.length, 1);
  assert.match(show.json.warnings[0], /^model values without a \(vendor\) suffix: "Bare" \(default, reviewer\); "Tiny" \(prompts\.doctor\); /);

  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  assert.deepEqual(apply.json.warnings, show.json.warnings);

  const pins = models("pins");
  assert.equal(pins.code, 0);
  assert.equal(pins.json.warnings.length, 1);
  assert.match(pins.json.warnings[0], /^model values without a \(vendor\) suffix: "Bare" \(builder, reviewer, autopilot, mechanic, architect\); /);

  assert.deepEqual(models("clear").json.warnings, []);
});
