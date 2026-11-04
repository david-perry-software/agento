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

test("doctor artifact-repo warns when the companion worktrees dir exists but is not writable", () => {
  const { repo, docsWt } = makePairRepo();
  const { env } = restrictedPath(okStubs);
  const check = () => byId(runWith({ cwd: repo, env }, "doctor").json)["artifact-repo"];
  assert.equal(check().status, "ok");
  fs.chmodSync(docsWt, 0o555);
  try {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const warned = check();
    assert.equal(warned.status, "warn");
    assert.match(warned.detail, new RegExp(`main present; ${docsWt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} not writable$`));
    assert.match(warned.fallback, /companion half of every paired session/);
  } finally {
    fs.chmodSync(docsWt, 0o755);
  }
  assert.equal(check().status, "ok");
  // Absent dir: nothing to check.
  fs.rmdirSync(docsWt);
  assert.equal(check().status, "ok");
});

test("doctor reports fourteen checks and includes session-workspace, model-profile, hook-wiring, harness, canvas, mcp-servers, turn-stalls, and plugin-snapshots", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  // --plugin-root: the model-profile check must not read the (possibly pinned) clone running the suite.
  const { code, json } = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo);
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.for, null);
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "git-remote", "gh", "code", "worktrees-dir", "session-workspace", "artifact-repo", "model-profile", "hook-wiring", "harness", "canvas", "mcp-servers", "turn-stalls", "plugin-snapshots"]);
  for (const check of json.checks) {
    assert.equal(check.status, "ok", JSON.stringify(check));
    assert.equal(typeof check.detail, "string");
    assert.equal(check.fallback, null);
  }
  const checks = byId(json);
  assert.match(checks.gh.detail, /gh version 9\.9\.9; authenticated/);
  assert.match(checks["git-remote"].detail, /main reachable/);
  assert.match(checks["worktrees-dir"].detail, /project-worktrees absent; .* writable, it will be created/);
  assert.equal(checks["artifact-repo"].detail, "in-repo layout (artifacts.repo unset)");
  assert.equal(checks["session-workspace"].detail, "not a managed pair");
  assert.equal(checks["mcp-servers"].detail, "no MCP servers configured");
  assert.equal(checks["turn-stalls"].detail, "no Copilot session data");
  assert.equal(checks["plugin-snapshots"].detail, "plugin snapshots are slim");
});

test("doctor mcp-servers and turn-stalls warn on fixture data and stay ok when absent, never fail", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  env.AGENTO_COPILOT_HOME = home;
  const check = (extraEnv = {}) => byId(runWith({ cwd: repo, env: { ...env, ...extraEnv } }, "doctor", "--plugin-root", repo).json);

  // Empty fixture home: both checks ok.
  const empty = check();
  assert.equal(empty["mcp-servers"].status, "ok");
  assert.equal(empty["turn-stalls"].status, "ok");

  // A wildcard server and a timeout from a still-configured server both warn.
  fs.writeFileSync(path.join(home, "mcp-config.json"), JSON.stringify({ mcpServers: { railway: { type: "local", command: "railway", args: [], tools: ["*"] }, narrow: { type: "local", command: "node", args: [], tools: ["read"] } } }));
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const logFile = path.join(home, "logs", "process-1.log");
  const t = new Date(Date.now() - 60 * 1000);
  fs.writeFileSync(logFile, `${t.toISOString()} [WARNING] Failed to refresh persisted MCP tools for narrow; continuing with cached tools: MCP request timed out after 60000 ms\n`);
  fs.utimesSync(logFile, t, t);
  const warned = check();
  assert.equal(warned["mcp-servers"].status, "warn");
  assert.match(warned["mcp-servers"].detail, /railway \(user mcp-config\.json\): tools \["\*"\] exposes every tool/);
  assert.match(warned["mcp-servers"].detail, /narrow timed out 1× in 24 h/);
  assert.match(warned["mcp-servers"].fallback, /edit the MCP config/);

  // A current session with a 60 s gap and a slow subagent start-up warns.
  const sessionDir = path.join(home, "session-state", "sess-1");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), `id: sess-1\ncwd: ${repo}\ngit_root: ${repo}\nrepository: x/y\n`);
  const line = (type, data, timestamp, extra = {}) => JSON.stringify({ type, data, id: "i", timestamp, parentId: "p", ...extra });
  fs.writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    [
      line("session.start", { sessionId: "sess-1" }, "2026-11-03T10:00:00.000Z"),
      line("tool.execution_complete", { toolCallId: "t", turnId: "0" }, "2026-11-03T10:01:00.000Z"),
      line("assistant.turn_end", { turnId: "0" }, "2026-11-03T10:02:00.000Z"),
      line("subagent.started", { toolCallId: "s", agentName: "explore" }, "2026-11-03T10:03:00.000Z", { agentId: "agent-1" }),
      line("subagent.configured", { multiTurn: true }, "2026-11-03T10:13:00.000Z", { agentId: "agent-1" }),
    ].join("\n") + "\n",
  );
  const eventsFile = path.join(sessionDir, "events.jsonl");
  fs.utimesSync(eventsFile, t, t);
  const stalls = check();
  assert.equal(stalls["turn-stalls"].status, "warn");
  assert.match(stalls["turn-stalls"].detail, /1 stalled turns \(~1 min\) in session sess-1/);
  assert.match(stalls["turn-stalls"].detail, /1 slow subagent start-up\(s\) in session sess-1/);
  assert.match(stalls["turn-stalls"].detail, /24 h: 1 across 1 session/);
  assert.match(stalls["turn-stalls"].fallback, /agento\.mjs stalls/);
});

test("doctor model-profile names both roles and warns on a dangling or invalid secondary", () => {
  const { plugin, home, writeProfiles } = modelsFixture();
  const { env } = restrictedPath(okStubs);
  env.AGENTO_CONFIG_HOME = home;
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];

  // Healthy: a valid secondary assignment is ok and the detail names both roles.
  writeProfiles({ b: { default: "B (copilot)" } });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "b" }));
  const healthy = check();
  assert.equal(healthy.status, "ok", JSON.stringify(healthy));
  assert.match(healthy.detail, /primary: none; secondary: b/);

  // Dangling: the secondary role names a profile that does not exist.
  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "gone" }));
  const dangling = check();
  assert.equal(dangling.status, "warn", JSON.stringify(dangling));
  assert.match(dangling.fallback, /models use none --role secondary/);

  // Invalid roles file.
  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "Bad_Name" }));
  const invalid = check();
  assert.equal(invalid.status, "warn", JSON.stringify(invalid));
  assert.match(invalid.fallback, /models use none --role secondary/);
});

test("doctor model-profile reports secondary invalid when the roles file has errors", () => {
  const { plugin, home, writeProfiles } = modelsFixture();
  const { env } = restrictedPath(okStubs);
  env.AGENTO_CONFIG_HOME = home;
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];

  writeProfiles({ a: { default: "A (copilot)" } });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "model-roles.json"), JSON.stringify({ secondary: "a", extra: 1 }));
  const invalid = check();
  assert.equal(invalid.status, "warn", JSON.stringify(invalid));
  assert.match(invalid.detail, /secondary: invalid/);
});

test("doctor session-workspace is ok for non-pairs, warn for stale/missing, and ok after workspace --write", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const { env } = restrictedPath(okStubs);

  // Non-pair: primary checkout reports ok with a neutral detail.
  const primaryCheck = byId(runWith({ cwd: repo, env }, "doctor").json)["session-workspace"];
  assert.equal(primaryCheck.status, "ok");
  assert.equal(primaryCheck.detail, "not a managed pair");

  // Pair: build worktree with no workspace file warns.
  const product = path.join(wt, "feature-widget");
  const half = path.join(docsWt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  writeRoadmap(half, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");

  const missing = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(missing.status, "warn");
  assert.match(missing.detail, /feature-widget\.code-workspace lacks the session auto-approve settings$/);
  assert.match(missing.fallback, /workspace feature widget --write, then Developer: Reload Window$/);

  // Stale file still warns.
  const workspacePath = path.join(wt, "feature-widget.code-workspace");
  fs.writeFileSync(workspacePath, "{}\n");
  const stale = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(stale.status, "warn");

  // CLI-written canonical file is ok.
  run(repo, "workspace", "feature", "widget", "--write");
  const current = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(current.status, "ok");
  assert.match(current.detail, /feature-widget\.code-workspace carries the session auto-approve settings$/);
});

test("doctor artifact-repo passes a valid companion, fails a missing or broken one naming /agento agento-init, and warns on stale in-repo roots", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  const { env } = restrictedPath(okStubs);
  const check = (...args) => {
    const result = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo, ...args);
    return { code: result.code, status: result.json.status, check: byId(result.json)["artifact-repo"] };
  };

  const valid = check();
  assert.equal(valid.code, 0);
  assert.deepEqual(valid.check, { id: "artifact-repo", status: "ok", detail: `${docs} (project-docs), origin ${path.join(path.dirname(repo), "project-docs.git")}, main present`, fallback: null });

  // Stale pre-migration roots in the product repo: ignored by readers, surfaced once here.
  fs.mkdirSync(path.join(repo, "initiatives"), { recursive: true });
  fs.writeFileSync(path.join(repo, "initiatives", ".gitkeep"), "");
  assert.equal(check().check.status, "ok", "a .gitkeep-only root is not stale");
  writeRoadmap(repo, "features/2026/09/stale", "status: complete\nbranch: feature/stale");
  fs.mkdirSync(path.join(repo, "issues", "2026", "09", "old"), { recursive: true });
  fs.writeFileSync(path.join(repo, "issues", "2026", "09", "old", "plan.md"), "# old\n");
  const stale = check();
  assert.equal(stale.code, 0);
  assert.equal(stale.status, "warn");
  assert.equal(stale.check.status, "warn");
  assert.match(stale.check.detail, /main present; stale in-repo roots: features\/, issues\/$/);
  assert.match(stale.check.fallback, /agento agento-init --migrate/);

  // Default branch missing from the companion.
  git(docs, "branch", "-m", "main", "trunk");
  git(docs, "update-ref", "-d", "refs/remotes/origin/main");
  const noBranch = check("--for", "close-session");
  assert.equal(noBranch.code, 3);
  assert.equal(noBranch.check.status, "fail");
  assert.match(noBranch.check.detail, /neither origin\/main nor main/);
  assert.match(noBranch.check.fallback, /`\/agento agento-init`.*project-docs/);

  // No origin remote.
  git(docs, "remote", "remove", "origin");
  assert.match(check().check.detail, /no `origin` remote/);

  // Not a git checkout toplevel (a plain directory), then absent altogether.
  fs.rmSync(path.join(docs, ".git"), { recursive: true, force: true });
  const notRepo = check();
  assert.equal(notRepo.check.status, "fail");
  assert.match(notRepo.check.detail, /not a git checkout toplevel/);
  fs.rmSync(docs, { recursive: true, force: true });
  const absent = check();
  assert.equal(absent.code, 3);
  assert.equal(absent.check.status, "fail");
  assert.equal(absent.check.detail, `${docs} absent`);
  assert.match(absent.check.fallback, /run `\/agento agento-init` to create and clone the companion repository project-docs at /);
});

test("doctor fails with exit 3 and the install or reauth fallback when gh is missing or unauthenticated", () => {
  const repo = makeRepo();
  const { env, bin } = restrictedPath({ code: okStubs.code });

  const missing = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo);
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "fail");
  const gh = byId(missing.json).gh;
  assert.equal(gh.status, "fail");
  assert.match(gh.detail, /gh CLI not found on PATH/);
  assert.match(gh.fallback, /install GitHub CLI/);
  // Every other check is unaffected by the failing one.
  assert.deepEqual(missing.json.checks.filter((c) => c.id !== "gh").map((c) => c.status), ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);

  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh version 9.9.9'; exit 0; fi\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n", { mode: 0o755 });
  const unauth = runWith({ cwd: repo, env }, "doctor");
  assert.equal(unauth.code, 3);
  const auth = byId(unauth.json).gh;
  assert.equal(auth.status, "fail");
  assert.match(auth.detail, /gh auth status failed: You are not logged into any GitHub hosts/);
  assert.match(auth.fallback, /`gh auth login`/);
});

test("doctor harness check is ok without a router and when installed, fails per state, and never runs in preflight", () => {
  const { plugin, env, runHarness, link } = harnessFixture();
  const { bin: okBin } = restrictedPath(okStubs);
  // The fixture's skills dir, with a stubbed gh/code PATH so the doctor run is deterministic.
  const doctorEnv = { ...env, PATH: okBin };
  const check = () => byId(runWith({ cwd: plugin, env: doctorEnv }, "doctor", "--plugin-root", plugin).json)["harness"];
  const expected = path.join(plugin, "skills", "agento");

  // Installed: ok, names the link, the clone, and the Local takeover.
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 0);
  const installed = check();
  assert.equal(installed.status, "ok", JSON.stringify(installed));
  assert.match(installed.detail, new RegExp(plugin));
  assert.match(installed.detail, /Local/);

  // Absent.
  fs.unlinkSync(link);
  const absent = check();
  assert.equal(absent.status, "fail");
  assert.match(absent.detail, /cannot run \/agento in any session/);
  assert.match(absent.fallback, new RegExp(`harness install --plugin-root ${plugin}`));

  // Foreign.
  const other = path.join(path.dirname(plugin), "other");
  fs.mkdirSync(path.join(other, "skills", "agento"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "agento", "SKILL.md"), "x");
  fs.symlinkSync(path.join(other, "skills", "agento"), link, "dir");
  const foreign = check();
  assert.equal(foreign.status, "fail");
  assert.match(foreign.detail, /cannot run \/agento in any session/);
  assert.match(foreign.detail, new RegExp(path.join(other, "skills", "agento")));
  assert.match(foreign.fallback, /--force/);

  // Dangling.
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(plugin, "gone"), link, "dir");
  const dangling = check();
  assert.equal(dangling.status, "fail");
  assert.match(dangling.detail, /cannot run \/agento in any session/);
  assert.match(dangling.detail, /dangling/);
  assert.match(dangling.fallback, /--force/);

  // Not-a-link.
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  const notALink = check();
  assert.equal(notALink.status, "fail");
  assert.match(notALink.detail, /cannot run \/agento in any session/);
  assert.match(notALink.fallback, /move it away/);

  // Root without a router skill: ok.
  const plain = makeRepo();
  const noSkill = byId(runWith({ cwd: plain, env: doctorEnv }, "doctor", "--plugin-root", plain).json)["harness"];
  assert.equal(noSkill.status, "ok");
  assert.match(noSkill.detail, /no Agento router skill/);

  // Informational: never in doctor --for new-feature or preflight new-feature.
  const forCheck = byId(runWith({ cwd: plugin, env: doctorEnv }, "doctor", "--for", "new-feature").json);
  assert.equal(forCheck["harness"], undefined);
  const preflight = runWith({ cwd: plugin, env: doctorEnv }, "preflight", "new-feature", "--full").json;
  assert.equal(byId(preflight.doctor)["harness"], undefined);
});

test("doctor canvas check is ok when installed, warn per state, ok without a canvas, and never runs in preflight", () => {
  const { plugin, env, runHarness, canvasLink, canvasExpected } = harnessFixture();
  const { bin: okBin } = restrictedPath(okStubs);
  const doctorEnv = { ...env, PATH: okBin };
  const check = () => byId(runWith({ cwd: plugin, env: doctorEnv }, "doctor", "--plugin-root", plugin).json)["canvas"];

  // Absent (canvas present in the clone, link missing): warn with install fallback.
  const absent = check();
  assert.equal(absent.status, "warn");
  assert.match(absent.detail, /is missing/);
  assert.match(absent.fallback, new RegExp(`harness install --plugin-root ${plugin}`));

  // Installed: ok.
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 0);
  const installed = check();
  assert.equal(installed.status, "ok", JSON.stringify(installed));
  assert.match(installed.detail, /Mission Control canvas installed/);

  // Foreign: warn.
  const other = path.join(path.dirname(plugin), "other-canvas");
  fs.mkdirSync(other, { recursive: true });
  fs.unlinkSync(canvasLink);
  fs.symlinkSync(other, canvasLink, "dir");
  const foreign = check();
  assert.equal(foreign.status, "warn");
  assert.match(foreign.detail, new RegExp(other));
  assert.match(foreign.fallback, /--force/);

  // Dangling: warn.
  fs.unlinkSync(canvasLink);
  fs.symlinkSync(path.join(plugin, "gone"), canvasLink, "dir");
  const dangling = check();
  assert.equal(dangling.status, "warn");
  assert.match(dangling.detail, /dangling/);
  assert.match(dangling.fallback, /--force/);

  // Not-a-link: warn.
  fs.unlinkSync(canvasLink);
  fs.mkdirSync(canvasLink);
  const notALink = check();
  assert.equal(notALink.status, "warn");
  assert.match(notALink.fallback, /move it away/);

  // A clone without the canvas: ok (nothing to install yet).
  const plain = makeRepo();
  const noCanvas = byId(runWith({ cwd: plain, env: doctorEnv }, "doctor", "--plugin-root", plain).json)["canvas"];
  assert.equal(noCanvas.status, "ok");
  assert.match(noCanvas.detail, /no Mission Control canvas/);

  // Informational: never in doctor --for new-feature or preflight new-feature.
  const forCheck = byId(runWith({ cwd: plugin, env: doctorEnv }, "doctor", "--for", "new-feature").json);
  assert.equal(forCheck["canvas"], undefined);
  const preflight = runWith({ cwd: plugin, env: doctorEnv }, "preflight", "new-feature", "--full").json;
  assert.equal(byId(preflight.doctor)["canvas"], undefined);
});

test("doctor warns (exit 0) when code is missing and reports its fallback; no Python check remains", () => {
  const repo = makeRepo();
  const { env } = restrictedPath({ gh: okStubs.gh });
  const { code, json } = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo);
  assert.equal(code, 0);
  assert.equal(json.status, "warn");
  const checks = byId(json);
  assert.equal(checks.code.status, "warn");
  assert.match(checks.code.detail, /code CLI not found/);
  assert.match(checks.code.fallback, /code --new-window <worktree-path>/);
  assert.deepEqual(Object.keys(checks).filter((id) => id.startsWith("python")), []);
  assert.equal(checks.gh.status, "ok");
});

test("doctor fails without an origin remote and warns when origin is unreachable", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);

  git(repo, "remote", "set-url", "origin", path.join(path.dirname(repo), "does-not-exist.git"));
  const unreachable = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo);
  assert.equal(unreachable.code, 0);
  assert.equal(unreachable.json.status, "warn");
  const remote = byId(unreachable.json)["git-remote"];
  assert.equal(remote.status, "warn");
  assert.match(remote.detail, /^origin .*does-not-exist\.git unreachable: /);
  assert.match(remote.fallback, /work offline/);

  git(repo, "remote", "remove", "origin");
  const none = runWith({ cwd: repo, env }, "doctor", "--plugin-root", repo);
  assert.equal(none.code, 3);
  assert.equal(none.json.status, "fail");
  const missing = byId(none.json)["git-remote"];
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /no `origin` remote/);
  assert.match(missing.fallback, /git remote add origin/);
});

test("doctor --for runs only the command's declared checks and reports its needs", () => {
  const repo = makeRepo();
  const marker = path.join(path.dirname(repo), "gh-invoked");
  const { env } = restrictedPath({
    ...okStubs,
    gh: `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n${okStubs.gh.replace("#!/bin/sh\n", "")}`,
  });

  const local = runWith({ cwd: repo, env }, "doctor", "--for", "close-session");
  assert.equal(local.code, 0);
  assert.deepEqual(local.json.for, { command: "close-session", needs: ["terminal"] });
  assert.deepEqual(local.json.checks.map((c) => c.id), ["node", "worktrees-dir", "session-workspace", "artifact-repo"]);
  assert.ok(!fs.existsSync(marker), "gh was invoked for a terminal-only command");

  const ship = runWith({ cwd: repo, env }, "doctor", "--for", "ship");
  assert.equal(ship.code, 0);
  assert.deepEqual(ship.json.for, { command: "ship", needs: ["terminal", "gh", "network"] });
  assert.deepEqual(ship.json.checks.map((c) => c.id), ["node", "git-remote", "gh", "worktrees-dir", "session-workspace", "artifact-repo"]);
  assert.match(fs.readFileSync(marker, "utf8"), /auth status/);

  const unknown = runWith({ cwd: repo, env }, "doctor", "--for", "nope");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.json.status, "usage-error");
  assert.match(unknown.json.message, /unknown command nope/);
});

test("preflight returns the named sections, the op-id, and an accepted receipt in one call", () => {
  const { repo } = makeWorktreeRepo();
  const { env } = restrictedPath(okStubs);
  const sha = git(repo, "rev-parse", "--short", "HEAD");
  const { code, json } = runWith({ cwd: repo, env }, "preflight", "delivery-status", "--full");
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(json), ["status", "command", "opId", "subject", "receipt", "preflightLines", "session", "window", "doctor", "resolve", "config", "root", "configSource"]);
  assert.equal(json.status, "ok");
  assert.equal(json.command, "delivery-status");
  assert.equal(json.subject, "main");
  assert.equal(json.opId, `delivery-status:main:${sha}`);
  assert.equal(json.receipt, `Receipt: accepted delivery-status:main:${sha}`);
  assert.deepEqual(json.preflightLines, []);
  // Each section is the standalone subcommand's document.
  const { worktrees, ...session } = json.session;
  const { worktrees: standaloneWorktrees, ...standalone } = run(repo, "session").json;
  assert.deepEqual(session, standalone);
  assert.deepEqual(json.doctor, runWith({ cwd: repo, env }, "doctor", "--for", "delivery-status").json);
  assert.deepEqual(json.config, run(repo, "config").json);
  assert.equal(json.resolve, null);
  assert.deepEqual(json.window, { role: "primary", required: { roles: ["any"], branch: null, clean: false, slugRoles: [] }, match: true, reason: null, allowed: json.session.allowed, elsewhere: json.session.elsewhere });
  assert.match(run(repo).json.usage.join("\n"), /preflight <command> \[<type> <slug> \| <slug>\]/);
});

test("preflight defaults to the brief document; --full keeps the pre-change shape", () => {
  const { repo } = makeWorktreeRepo();
  const { env } = restrictedPath(okStubs);
  const brief = runWith({ cwd: repo, env }, "preflight", "delivery-status").json;
  assert.deepEqual(Object.keys(brief), ["status", "command", "opId", "subject", "receipt", "preflightLines", "window", "session", "doctor"]);
  assert.deepEqual(Object.keys(brief.session), ["role", "hosted", "worktree", "companion", "workspace", "delivery", "pr", "companionPr", "lifecycle", "warnings"]);
  assert.deepEqual(Object.keys(brief.doctor), ["status", "for", "failing"]);
  assert.deepEqual(Object.keys(brief.window), ["role", "required", "match", "reason", "allowed", "elsewhere"]);
  const full = runWith({ cwd: repo, env }, "preflight", "delivery-status", "--full").json;
  assert.ok(Array.isArray(full.session.worktrees), "--full keeps session.worktrees");
  assert.ok(Array.isArray(full.session.allowed) && Array.isArray(full.session.elsewhere), "--full keeps session.allowed/elsewhere");
  assert.ok(Array.isArray(full.doctor.checks), "--full keeps doctor.checks");
  assert.ok(full.config && full.root && full.configSource, "--full keeps config, root, configSource");
});

test("preflight rejects a window mismatch with the §9 receipt and the record's alternatives (exit 3)", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env } = restrictedPath(okStubs);
  const wrong = runWith({ cwd: repo, env }, "preflight", "new-feature", "--full");
  assert.equal(wrong.code, 3);
  assert.equal(wrong.json.status, "rejected");
  assert.equal(wrong.json.window.match, false);
  assert.equal(wrong.json.window.reason, `wrong window: role=primary (${repo}, branch main)`);
  const alternatives = [...wrong.json.session.allowed, ...wrong.json.session.elsewhere.map((e) => `${e.command} (${e.window} window)`)];
  assert.equal(wrong.json.receipt, `Receipt: rejected — wrong window: role=primary (${repo}, branch main); allowed: ${alternatives.join(", ")}`);
  assert.deepEqual(wrong.json.preflightLines, []);

  // §11 step 5 branch conditions: on the default branch; clean; on a work branch.
  assert.equal(runWith({ cwd: repo, env }, "preflight", "start-session").code, 0);
  assert.match(runWith({ cwd: repo, env }, "preflight", "commit-current-changes").json.window.reason, /^primary checkout must be on a work branch, not main/);
  fs.writeFileSync(path.join(repo, "scratch.txt"), "wip\n");
  const dirty = runWith({ cwd: repo, env }, "preflight", "quick-fix");
  assert.equal(dirty.code, 3);
  assert.match(dirty.json.receipt, /^Receipt: rejected — primary checkout is dirty \(/);
  fs.rmSync(path.join(repo, "scratch.txt"));
  git(repo, "switch", "-q", "-c", "changes/tidy");
  assert.match(runWith({ cwd: repo, env }, "preflight", "new-initiative").json.window.reason, /^primary checkout not on main/);
  assert.equal(runWith({ cwd: repo, env }, "preflight", "commit-current-changes").code, 0);
  git(repo, "switch", "-q", "main");

  // A build window: the slug must be this window's delivery.
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  const sha = git(build, "rev-parse", "--short", "HEAD");
  const own = runWith({ cwd: build, env }, "preflight", "build-feature", "feature", "widget");
  assert.equal(own.code, 0);
  assert.equal(own.json.opId, `build-feature:widget:${sha}`);
  assert.equal(own.json.resolve.status, "ok");
  assert.equal(own.json.resolve.branch, "feature/widget");
  const other = runWith({ cwd: build, env }, "preflight", "review-feature", "feature", "gadget");
  assert.equal(other.code, 3);
  assert.equal(other.json.window.reason, `wrong window: this build window holds widget, not gadget (${build}, branch feature/widget)`);
  assert.equal(other.json.resolve.status, "missing");
  // A bare slug resolves type-agnostically (find); no slug means no resolve and the session id as subject.
  const bare = runWith({ cwd: build, env }, "preflight", "ap", "widget").json;
  assert.equal(bare.resolve.type, "feature");
  assert.equal(bare.resolve.status, "ok");
  assert.deepEqual(runWith({ cwd: build, env }, "preflight", "ap", "feature/widget").json.resolve.status, "ok");
  const blank = runWith({ cwd: build, env }, "preflight", "build-feature", "--full").json;
  assert.equal(blank.status, "ok");
  assert.equal(blank.resolve, null);
  assert.equal(blank.subject, "feature-widget");
  assert.equal(blank.opId, `build-feature:feature-widget:${sha}`);
});

test("preflight turns doctor warn into preflight lines (exit 0) and a hard fail into the capability receipt (exit 3)", () => {
  const { repo } = makeWorktreeRepo();
  const sha = git(repo, "rev-parse", "--short", "HEAD");
  const noCode = runWith({ cwd: repo, env: restrictedPath({ gh: okStubs.gh }).env }, "preflight", "start-session");
  assert.equal(noCode.code, 0);
  assert.equal(noCode.json.status, "ok");
  assert.equal(noCode.json.doctor.status, "warn");
  assert.equal(noCode.json.receipt, `Receipt: accepted start-session:main:${sha}`);
  assert.deepEqual(noCode.json.preflightLines, ["Preflight: code warn — keep the worktree and print `code --new-window <worktree-path>` for the user to run"]);

  const noGh = runWith({ cwd: repo, env: restrictedPath({ code: okStubs.code }).env }, "preflight", "ship");
  assert.equal(noGh.code, 3);
  assert.equal(noGh.json.status, "rejected");
  assert.equal(noGh.json.window.match, true);
  assert.equal(noGh.json.receipt, "Receipt: rejected — gh: gh CLI not found on PATH; fallback: install GitHub CLI (https://cli.github.com) — the user installs it; the agent does not");
  assert.deepEqual(noGh.json.preflightLines, []);
  // A terminal-only command never probes gh, so it is unaffected.
  assert.equal(runWith({ cwd: repo, env: restrictedPath({ code: okStubs.code }).env }, "preflight", "close-session").code, 0);
});

test("preflight usage errors exit 1", () => {
  const repo = makeRepo();
  for (const args of [["preflight"], ["preflight", "nope"], ["preflight", "ap", "Bad_Slug"], ["preflight", "ap", "thing", "x"], ["preflight", "ap", "feature", "a", "b"]]) {
    const { code, json } = run(repo, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error");
  }
  assert.match(run(repo, "preflight", "nope").json.message, /unknown command nope/);
});

test("brief preflight output stays ≤ 2,500 bytes in a plan window with ≥ 3 registered worktrees", () => {
  const { repo, wt } = makeWorktreeRepo();
  git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "plan-alpha"), "origin/main");
  git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "plan-beta"), "origin/main");
  git(repo, "worktree", "add", "-q", "-b", "feature/other", path.join(wt, "feature-other"));
  const plan = path.join(wt, "plan-alpha");
  const { env } = restrictedPath(okStubs);
  const result = spawnSync("node", [cli, "preflight", "new-feature"], { cwd: plan, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length <= 2500, `brief preflight output is ${result.stdout.length} bytes (≤ 2,500)`);
});

test("unmanaged-window rejections carry window.primary in the brief output", () => {
  const { repo } = makeWorktreeRepo();
  const stray = path.join(path.dirname(repo), "stray");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", stray);
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: stray, env }, "preflight", "build-feature", "feature", "widget");
  assert.equal(code, 3);
  assert.equal(json.window.role, "unmanaged");
  assert.equal(json.window.primary, repo);
  assert.equal(json.window.match, false);
});

// --- policy -------------------------------------------------------------------

const policyDir = path.join(repoRoot, ".github", "instructions", "policy");

function policySlice(n) {
  const file = fs.readdirSync(policyDir).filter((name) => name.startsWith(`${n.padStart(2, "0")}-`));
  assert.equal(file.length, 1, `expected one policy section file for \u00a7${n}`);
  return fs.readFileSync(path.join(policyDir, file[0]), "utf8");
}

function policyBody() {
  return fs
    .readdirSync(policyDir)
    .filter((name) => /^\d{2}-.+\.md$/.test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(policyDir, name), "utf8"))
    .join("");
}

function runPolicy(repo, ...args) {
  const result = spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8", env: baseEnv });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("policy prints the requested sections as raw Markdown, ascending and deduplicated", () => {
  const repo = makeRepo({});
  const expected = `# delivery-policy.instructions.md — sections 1, 9\n\n${policySlice("1")}${policySlice("9")}`;
  const { code, stdout } = runPolicy(repo, "policy", "1", "9");
  assert.equal(code, 0);
  assert.equal(stdout, expected);
  // Dedupe and ascending order: 9 1 9 1 prints the same as 1 9.
  assert.equal(runPolicy(repo, "policy", "9", "1", "9", "1").stdout, expected);
});

test("policy --list returns all 12 sections whose bytes sum to the body size", () => {
  const repo = makeRepo({});
  const { code, json } = run(repo, "policy", "--list");
  assert.equal(code, 0);
  assert.equal(json.sections.length, 12);
  assert.deepEqual(json.sections.map((s) => s.n), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.equal(json.sections[0].title, "Who does the work");
  const body = policyBody();
  assert.equal(json.sections.reduce((sum, s) => sum + s.bytes, 0), Buffer.byteLength(body, "utf8"));
});

test("policy rejects unknown, malformed, missing, and empty section arguments", () => {
  const repo = makeRepo({});
  for (const args of [["policy"], ["policy", "13"], ["policy", "x"], ["policy", "1", "13"], ["policy", "--list", "1"]]) {
    const result = spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8", env: baseEnv });
    assert.equal(result.status, 1, `${args.join(" ")} should exit 1`);
    assert.match(result.stdout, /"status": "usage-error"/);
  }
});

test("the shrunk §9, §10, §11 stay within the context budget", () => {
  const repo = makeRepo({});
  const { code, json } = run(repo, "policy", "--list");
  assert.equal(code, 0);
  const shrunk = json.sections.filter((s) => ["9", "10", "11"].includes(s.n));
  const bytes = shrunk.reduce((sum, s) => sum + s.bytes, 0);
  assert.ok(bytes <= 5000, `§9+§10+§11 must be ≤ 5,000 bytes, got ${bytes}`);
});

test("doctor model-profile warns for agent pins without a Copilot alias", () => {
  const { plugin, home, env, models } = modelsFixture();
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "model-profiles.json"),
    JSON.stringify({
      copilotModels: { "Claude Opus 5.5 (copilot)": "claude-opus-5.5" },
      profiles: { mixed: { agents: { planner: "Claude Opus 5.5 (copilot)", builder: "DeepSeek V4 Pro (deepseek)" } } },
    }),
  );
  assert.equal(models("apply", "mixed").code, 0);
  const warn = check();
  assert.equal(warn.status, "warn", JSON.stringify(warn));
  assert.match(warn.detail, /agent pins without a Copilot alias: builder "DeepSeek V4 Pro \(deepseek\)"/);
  assert.match(warn.fallback, /copilotModels map/);
});

test("doctor model-profile: ok without a clone, none, or a matching profile; warn on custom pins or an invalid file", () => {
  const { plugin, home, env, models, writeProfiles } = modelsFixture();
  const check = (root = plugin) => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", root).json)["model-profile"];

  const bundle = check(path.dirname(plugin));
  assert.equal(bundle.status, "ok");
  assert.match(bundle.detail, /^no Agento plugin clone at /);

  assert.deepEqual(check(), { id: "model-profile", status: "ok", detail: `no profile applied to ${plugin}; primary: none; secondary: off`, fallback: null });

  writeProfiles({ mixed: { default: "Cheap (copilot)", agents: { planner: "Strong (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  assert.equal(check().detail, `mixed applied to ${plugin}; primary: mixed; secondary: off`);

  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('model: "Cheap (copilot)"', 'model: "Edited"'));
  const custom = check();
  assert.equal(custom.status, "warn");
  assert.match(custom.detail, /match no profile/);
  assert.match(custom.fallback, /models apply <name>.*models adopt.*models clear/);
  assert.doesNotMatch(custom.fallback, /git pull/);

  fs.writeFileSync(path.join(home, "model-profiles.json"), "{ nope");
  const invalid = check();
  assert.equal(invalid.status, "warn");
  assert.match(invalid.detail, /1 error\(s\), first: invalid JSON/);
});

test("doctor model-profile warns on legacy skip-worktree pins, an unhealthy or stale filter, and unrecorded files", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];
  writeProfiles({ tiny: { prompts: { doctor: "Tiny (copilot)" } } });

  legacyPins(plugin, { ".github/prompts/doctor.prompt.md": "Tiny (copilot)", "skills/agento/commands/doctor.md": "Tiny (copilot)" });
  const legacy = check();
  assert.equal(legacy.status, "warn");
  assert.match(legacy.detail, /^2 file\(s\) still carry legacy skip-worktree pins/);
  assert.match(legacy.fallback, /models adopt --plugin-root .* keeps the current pins.*models apply <name>/);

  assert.equal(models("apply", "tiny").code, 0);
  assert.deepEqual(check(), { id: "model-profile", status: "ok", detail: `tiny applied to ${plugin}; primary: tiny; secondary: off`, fallback: null });

  const copy = path.join(commonDirOf(plugin), "agento", "model-filter.mjs");
  fs.appendFileSync(copy, "// stale\n");
  const stale = check();
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /copied script .* is missing or older than this CLI/);
  assert.match(stale.fallback, /models apply <name>.*models adopt.*refreshes it/);
  assert.equal(models("apply", "tiny").code, 0);
  assert.equal(check().status, "ok");

  git(plugin, "config", "--local", "--remove-section", "filter.agento-models");
  const broken = check();
  assert.equal(broken.status, "warn");
  assert.match(broken.detail, /not carried by a healthy git filter \(missing: filter config\)/);
  assert.equal(models("apply", "tiny").code, 0);

  for (const rel of [".github/prompts/zz-new.prompt.md", "skills/agento/commands/zz-new.md"]) fs.writeFileSync(path.join(plugin, rel), "---\ndescription: \"New\"\nagent: agent\n---\n\nNew.\n");
  git(plugin, "add", "-A");
  git(plugin, "commit", "-q", "-m", "new prompt");
  const unrecorded = check();
  assert.equal(unrecorded.status, "warn");
  assert.match(unrecorded.detail, /2 agent\/prompt file\(s\) added since the last apply carry no pin: \.github\/prompts\/zz-new\.prompt\.md, skills\/agento\/commands\/zz-new\.md/);
  assert.match(unrecorded.fallback, /^re-run `agento\.mjs models apply <name>/);
});

test("doctor model-profile warns when autopilot is BYOK and delegates to a Copilot model", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  const check = (root = plugin) => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", root).json)["model-profile"];
  writeProfiles({ mixed: { agents: { autopilot: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  const tier = check();
  assert.equal(tier.status, "warn");
  assert.match(tier.detail, /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)".*reviewer "Claude Fable 5.1 \(copilot\)"/);
  assert.match(tier.fallback, /pin autopilot at least as high as the highest-tier model it delegates to/);
});

test("doctor model-profile warns on an applied profile with unqualified pins and is ok when every pin is qualified", () => {
  const { plugin, home, env, models, writeProfiles } = modelsFixture();
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];
  writeProfiles({ bare: { agents: { planner: "Bare", builder: "B (copilot)" } }, qualified: { agents: { planner: "P (copilot)", builder: "B (copilot)" } } });
  assert.equal(models("apply", "bare").code, 0);
  const bare = check();
  assert.equal(bare.status, "warn");
  assert.match(bare.detail, /^model values without a \(vendor\) suffix: "Bare" \(planner\); /);
  assert.equal(bare.fallback, `qualify each named value as "<picker name> (<vendor>)" in ${path.join(home, "model-profiles.json")}, then \`agento.mjs models apply bare --plugin-root ${plugin}\``);

  assert.equal(models("apply", "qualified").code, 0);
  assert.deepEqual(check(), { id: "model-profile", status: "ok", detail: `qualified applied to ${plugin}; primary: qualified; secondary: off`, fallback: null });
});

test("doctor --for models needs only the terminal checks", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: repo, env }, "doctor", "--for", "models");
  assert.equal(code, 0);
  assert.deepEqual(json.for, { command: "models", needs: ["terminal"] });
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "worktrees-dir", "session-workspace", "artifact-repo"]);
});

test("doctor hook-wiring: ok without wiring, unregistered, false, or unreadable settings; warn when the clone is registered", () => {
  const repo = makeRepo();
  const settings = path.join(path.dirname(repo), "vscode-settings.json");
  const env = { ...restrictedPath(okStubs).env, AGENTO_VSCODE_SETTINGS: settings };
  const check = (cwd = repo) => byId(runWith({ cwd, env }, "doctor").json)["hook-wiring"];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  fs.writeFileSync(settings, JSON.stringify({ "chat.pluginLocations": { [repo]: true } }));
  assert.deepEqual(check(), { id: "hook-wiring", status: "ok", detail: "no Agento workspace-mode hook wiring in this repository", fallback: null });

  fs.mkdirSync(path.join(repo, ".github", "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".github", "hooks", "session-start.json"),
    JSON.stringify({ hooks: { SessionStart: [{ type: "command", command: "./scripts/hooks/session-context.sh", timeout: 10 }] } }),
  );
  fs.mkdirSync(path.join(repo, "scripts", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "hooks", "session-context.sh"), "#!/usr/bin/env bash\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "workspace wiring");

  // JSONC as VS Code writes it: comments and trailing commas.
  fs.writeFileSync(settings, `{\n  // user settings\n  "chat.pluginLocations": {\n    ${JSON.stringify(repo)}: true, /* the clone */\n  },\n  "editor.tabSize": 2,\n}\n`);
  const warn = check();
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, new RegExp(`^${escape(repo)} \\(this repository\\) is registered in chat\\.pluginLocations \\(${escape(settings)}\\): `));
  assert.match(warn.detail, /SessionStart is deduplicated.*not visible to the CLI/);
  assert.match(warn.fallback, /Agent Plugins – Installed.*chat\.pluginLocations/);

  // A linked worktree of the registered clone shares its git common directory.
  const wt = path.join(path.dirname(repo), "wt-hook");
  git(repo, "worktree", "add", "-q", "-b", "feature/hook", wt);
  const fromWorktree = check(wt);
  assert.equal(fromWorktree.status, "warn");
  assert.match(fromWorktree.detail, new RegExp(`^${escape(repo)} \\(this repository\\)`));

  fs.writeFileSync(settings, JSON.stringify({ "chat.pluginLocations": { [repo]: false, "/elsewhere/plugin": true } }));
  const off = check();
  assert.equal(off.status, "ok");
  assert.match(off.detail, /not registered in chat\.pluginLocations/);

  fs.writeFileSync(settings, "{}");
  assert.match(check().detail, /not registered in chat\.pluginLocations/);

  fs.rmSync(settings);
  const unreadable = check();
  assert.equal(unreadable.status, "ok");
  assert.match(unreadable.detail, /unreadable \(ENOENT\), plugin registration unknown$/);
  assert.equal(unreadable.fallback, null);
});

test("doctor plugin-snapshots warns on a missing location, a clone, a >10 MB snapshot, and stale snapshots; ok for a slim export; never run by --for", () => {
  const repo = makeRepo();
  const settings = path.join(path.dirname(repo), "vscode-settings.json");
  const agents = path.join(path.dirname(repo), "agentPlugins");
  const cloneLoc = path.join(path.dirname(repo), "clone-plugin");
  const exportLoc = path.join(path.dirname(repo), "export-plugin");
  const missingLoc = path.join(path.dirname(repo), "missing-plugin");
  fs.mkdirSync(path.join(cloneLoc, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(cloneLoc, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
  execFileSync("git", ["-C", cloneLoc, "init", "-q", "-b", "main"]);
  fs.mkdirSync(exportLoc, { recursive: true });
  fs.writeFileSync(path.join(exportLoc, ".agento-export.json"), "{}");
  const dirOf = (loc) => `file-${loc.replace(/^\//, "").replace(/\//g, "-")}`;
  const locationDir = path.join(agents, dirOf(cloneLoc));
  const exportDir = path.join(agents, dirOf(exportLoc));
  // The clone has two snapshots (one stale); the export has one small snapshot.
  fs.mkdirSync(path.join(locationDir, "aaaaaaaa"), { recursive: true });
  fs.mkdirSync(path.join(locationDir, "bbbbbbbb"), { recursive: true });
  fs.writeFileSync(path.join(locationDir, "aaaaaaaa", "f"), "x".repeat(2048));
  fs.writeFileSync(path.join(locationDir, "bbbbbbbb", "f"), "y".repeat(2048));
  fs.mkdirSync(path.join(exportDir, "cccccccc"), { recursive: true });
  fs.writeFileSync(path.join(exportDir, "cccccccc", "f"), "z".repeat(2048));

  const env = { ...restrictedPath(okStubs).env, AGENTO_VSCODE_SETTINGS: settings, AGENTO_VSCODE_AGENT_PLUGINS: agents };
  const check = () => byId(runWith({ cwd: repo, env }, "doctor").json)["plugin-snapshots"];
  const plugin = (entries) => {
    fs.writeFileSync(settings, JSON.stringify({ "chat.pluginLocations": entries }));
  };

  plugin({ [cloneLoc]: true });
  const clone = check();
  assert.equal(clone.status, "warn");
  assert.match(clone.detail, /is an Agento git clone/);
  assert.match(clone.detail, /1 stale snapshot/);
  assert.match(clone.fallback, /plugin export --dest .* --replace-clone/);

  plugin({ [exportLoc]: true });
  const exportCheck = check();
  assert.equal(exportCheck.status, "ok");
  assert.match(exportCheck.detail, /slim/);

  // A > 10 MB newest snapshot warns even for an export.
  fs.writeFileSync(path.join(exportDir, "cccccccc", "big"), Buffer.alloc(11 * 1024 * 1024));
  const big = check();
  assert.equal(big.status, "warn");
  assert.match(big.detail, /> 10 MB/);
  assert.match(big.fallback, /plugin export --dest/);

  plugin({ [missingLoc]: true });
  const missing = check();
  assert.equal(missing.status, "warn");
  assert.match(missing.detail, /directory does not exist/);
  assert.match(missing.fallback, /remove .* from chat\.pluginLocations/);

  const forModels = runWith({ cwd: repo, env }, "doctor", "--for", "models").json;
  assert.ok(!forModels.checks.some((c) => c.id === "plugin-snapshots"), "--for never runs plugin-snapshots");

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});
