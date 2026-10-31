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

// --- migrate ------------------------------------------------------------------

// An in-repo product with one feature (plan, roadmap, binary evidence), one issue,
// and one initiative, all committed on main so the tree is clean before the move.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x7f]);
function seedInRepoTree(repo, { config } = {}) {
  writeRoadmap(repo, "features/2026/09/x", 'status: in-progress\nbranch: feature/x\ninitiative: "init"\nnext-step: "1.2 todo"');
  fs.writeFileSync(path.join(repo, "features/2026/09/x/plan.md"), "# x\n");
  fs.mkdirSync(path.join(repo, "features/2026/09/x/evidence"), { recursive: true });
  fs.writeFileSync(path.join(repo, "features/2026/09/x/evidence/step-1-1-x.png"), PNG);
  writeRoadmap(repo, "issues/2026/09/bug", "status: planned\nbranch: issue/bug\nnext-step: \"1.1\"");
  writeBreakdown(repo, "initiatives/2026/09/init", null, [{ slug: "x" }, { slug: "y", requires: ["x"] }]);
  if (config) {
    fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify(config));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed artifacts");
}

const porcelain = (dir) => git(dir, "status", "--porcelain");

test("migrate: the dry run lists both roots' files and the records and writes nothing", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  const { code, json } = run(repo, "migrate", docs);
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "dry-run");
  assert.equal(json.source, repo);
  assert.equal(json.destination, docs);
  assert.equal(json.clone, docs);
  assert.equal(json.name, "project-docs");
  assert.equal(json.configSet, false);
  assert.deepEqual(json.roots.map((r) => [r.rel, r.files]), [["features", 3], ["issues", 1], ["initiatives", 1]]);
  assert.ok(json.roots.every((r) => r.bytes > 0));
  assert.deepEqual(json.conflicts, []);
  assert.deepEqual(json.records.roadmaps.map((r) => [r.type, r.slug, r.roadmap]), [
    ["feature", "x", "features/2026/09/x/roadmap.md"],
    ["issue", "bug", "issues/2026/09/bug/roadmap.md"],
  ]);
  assert.deepEqual(json.records.breakdowns, [{ slug: "init", dir: "initiatives/2026/09/init", breakdown: "initiatives/2026/09/init/breakdown.md", features: ["x", "y"] }]);
  assert.equal(porcelain(repo), "");
  assert.equal(porcelain(docs), "");
  assert.ok(!fs.existsSync(path.join(repo, ".github", "agento.json")));
});

test("migrate: a destination conflict exits 3 naming the file and writes nothing", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  writeRoadmap(docs, "features/2026/09/x", "status: planned\nbranch: feature/x\nnext-step: \"1.1\"");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "pre-existing");
  // .gitkeep placeholders (the init scaffold) never count as conflicts.
  fs.mkdirSync(path.join(docs, "issues"), { recursive: true });
  fs.writeFileSync(path.join(docs, "issues", ".gitkeep"), "");
  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 3);
  assert.equal(json.status, "conflict");
  assert.equal(json.mode, "apply");
  assert.deepEqual(json.conflicts, ["features/2026/09/x/roadmap.md"]);
  assert.match(json.message, /nothing was written/);
  assert.equal(porcelain(repo), "");
  assert.ok(fs.existsSync(path.join(repo, "features/2026/09/x/roadmap.md")));
  assert.ok(!fs.existsSync(path.join(docs, "features/2026/09/x/plan.md")));
  assert.ok(!fs.existsSync(path.join(repo, ".github", "agento.json")));
});

test("migrate --apply moves the tree byte-identically, writes the config from the template, and notes the README once", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  fs.writeFileSync(path.join(docs, "README.md"), "# project-docs\n");
  const before = run(repo, "migrate", docs).json.records;

  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "applied");
  assert.equal(json.name, "project-docs");
  assert.equal(json.configSet, true);
  assert.deepEqual(json.moved, ["features", "issues", "initiatives"]);
  assert.equal(json.configWritten, path.join(repo, ".github", "agento.json"));
  assert.equal(json.readmeNoteAdded, true);
  assert.equal(json.records.identical, true);
  assert.deepEqual(json.records.diff, []);
  assert.deepEqual(json.records.roadmaps.map((r) => r.slug), before.roadmaps.map((r) => r.slug));
  assert.deepEqual(json.roots.map((r) => [r.rel, r.files]), [["features", 3], ["issues", 1], ["initiatives", 1]]);

  // Source roots are gone; the binary evidence arrived byte-equal.
  for (const rel of ["features", "issues", "initiatives"]) assert.ok(!fs.existsSync(path.join(repo, rel)), `${rel} still present`);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(docs, "features/2026/09/x/evidence/step-1-1-x.png")), PNG), 0);
  assert.ok(fs.existsSync(path.join(docs, "features/2026/09/x/plan.md")));

  // Config created from the plugin template with only the name set.
  const written = JSON.parse(fs.readFileSync(json.configWritten, "utf8"));
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates", "agento.json"), "utf8"));
  assert.equal(written.artifacts.repo.name, "project-docs");
  assert.deepEqual(written.branches, template.branches);
  assert.equal(fs.readFileSync(json.configWritten, "utf8").endsWith("}\n"), true);

  // README note appended after the existing content, once.
  const readme = fs.readFileSync(path.join(docs, "README.md"), "utf8");
  assert.ok(readme.startsWith("# project-docs\n"));
  assert.equal(readme.match(/^## Migrated history$/gm).length, 1);
  assert.match(readme, /\/agento agento-init --migrate/);
  assert.match(readme, /`\.\.\/\.\.\/\.\.\/\.\.\/<path>`/);

  // After committing both sides the product reads the companion and sees the same slugs.
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "move");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "import");
  const status = run(repo, "status");
  assert.equal(status.code, 0);
  assert.deepEqual(status.json.items.map((i) => i.slug), before.roadmaps.map((r) => r.slug));
  const init = run(repo, "initiative", "init");
  assert.equal(init.code, 0);
  assert.deepEqual(init.json.features.map((f) => [f.slug, f.state]), [["x", "in-progress"], ["y", "unplanned"]]);
  assert.equal(run(repo, "config").json.artifactsRoot, docs);

  // A second --apply has nothing left to move and leaves the README byte-unchanged.
  const again = run(repo, "migrate", docs, "--apply");
  assert.equal(again.code, 0);
  assert.equal(again.json.mode, "nothing-to-migrate");
  assert.equal(again.json.configSet, true);
  assert.equal(fs.readFileSync(path.join(docs, "README.md"), "utf8"), readme);
  assert.equal(porcelain(docs), "");
});

test("migrate --apply preserves an existing config's other keys", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo, { config: { branches: { default: "trunk" }, worktrees: { dir: "../wt" } } });
  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 0);
  assert.equal(json.mode, "applied");
  const written = JSON.parse(fs.readFileSync(path.join(repo, ".github", "agento.json"), "utf8"));
  assert.equal(written.branches.default, "trunk");
  assert.equal(written.worktrees.dir, "../wt");
  assert.deepEqual(written.artifacts.repo, { name: "project-docs" });
});

test("migrate --apply into a registered companion half resolves the name from the clone", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  const half = path.join(path.dirname(repo), "project-docs-worktrees", "plan-1");
  fs.mkdirSync(path.dirname(half), { recursive: true });
  git(docs, "worktree", "add", "-q", "--no-track", "-b", "feature/x", half, "origin/main");

  const dry = run(repo, "migrate", half);
  assert.equal(dry.code, 0);
  assert.equal(dry.json.destination, half);
  assert.equal(dry.json.clone, docs);
  assert.equal(dry.json.name, "project-docs");

  const { code, json } = run(repo, "migrate", half, "--apply");
  assert.equal(code, 0);
  assert.equal(json.mode, "applied");
  assert.equal(json.name, "project-docs");
  assert.ok(fs.existsSync(path.join(half, "features/2026/09/x/roadmap.md")));
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".github", "agento.json"), "utf8")).artifacts.repo.name, "project-docs");
  assert.ok(fs.existsSync(path.join(half, "README.md")));
});

test("migrate rejects a non-sibling destination and a non-checkout, writing nothing", () => {
  const repo = makeRepo();
  seedInRepoTree(repo);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "agento-far-"));
  const far = path.join(elsewhere, "other-docs");
  execFileSync("git", ["init", "-q", "-b", "main", far]);
  const { code, json } = run(repo, "migrate", far, "--apply");
  assert.equal(code, 3);
  assert.equal(json.status, "error");
  assert.equal(json.reason, "not-sibling");
  assert.equal(json.clone, far);
  assert.equal(json.primary, repo);
  assert.equal(porcelain(repo), "");
  assert.ok(fs.existsSync(path.join(repo, "features/2026/09/x/roadmap.md")));

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agento-plain-"));
  const notCheckout = run(repo, "migrate", plain);
  assert.equal(notCheckout.code, 3);
  assert.equal(notCheckout.json.reason, "not-a-checkout");

  const usage = run(repo, "migrate");
  assert.ok(usage.json.usage.some((line) => line.includes("migrate <companion-checkout> [--apply]")), JSON.stringify(usage.json.usage));
});
