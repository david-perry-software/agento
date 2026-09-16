import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadAgentoConfig, resolveArtifactsRoot } from "./agento-config.mjs";

function tmpRoot(prefix = "agento-config-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("defaults derive the worktree dir from the repository directory name", () => {
  const root = tmpRoot();
  const { config, source } = loadAgentoConfig(root);
  assert.equal(source, null);
  assert.equal(config.artifacts.features, "features");
  assert.equal(config.artifacts.issues, "issues");
  assert.equal(config.artifacts.initiatives, "initiatives");
  assert.deepEqual(config.artifacts.repo, { name: null, dir: null });
  assert.equal(config.branches.default, "main");
  assert.equal(config.branches.feature, "feature/");
  assert.equal(config.branches.freehand, "changes/");
  assert.equal(config.checks.releaseWorkflow, null);
  assert.match(config.worktrees.dir, /\.\.[/\\].+-worktrees$/);
});

test("defaultConfig embeds the repository basename in the worktree dir", () => {
  const config = defaultConfig(path.join("tmp", "my-project"));
  assert.match(config.worktrees.dir.replace(/\\/g, "/"), /^\.\.\/my-project-worktrees$/);
});

test("a .github/agento.json overrides only the keys it sets", () => {
  const root = tmpRoot();
  const configDir = path.join(root, ".github");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "agento.json"),
    JSON.stringify({
      artifacts: { features: "planning/features" },
      branches: { default: "trunk" },
      checks: { releaseWorkflow: "staging-release.yml" },
    }),
  );

  const { config, source } = loadAgentoConfig(root);
  assert.equal(source, path.join(configDir, "agento.json"));
  assert.equal(config.artifacts.features, "planning/features");
  assert.equal(config.artifacts.issues, "issues");
  assert.equal(config.artifacts.initiatives, "initiatives");
  assert.equal(config.branches.default, "trunk");
  assert.equal(config.branches.issue, "issue/");
  assert.equal(config.checks.releaseWorkflow, "staging-release.yml");
});

test("null values in agento.json keep the defaults", () => {
  const root = tmpRoot();
  const configDir = path.join(root, ".github");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "agento.json"),
    JSON.stringify({ worktrees: { dir: null }, branches: { default: null }, checks: null }),
  );

  const { config } = loadAgentoConfig(root);
  assert.match(config.worktrees.dir, /-worktrees$/);
  assert.equal(config.branches.default, "main");
  assert.equal(config.checks.releaseWorkflow, null);
});

test("the shipped templates/agento.json loads without clobbering defaults", () => {
  const root = tmpRoot();
  const configDir = path.join(root, ".github");
  fs.mkdirSync(configDir, { recursive: true });
  const template = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "templates", "agento.json");
  fs.copyFileSync(template, path.join(configDir, "agento.json"));

  const { config } = loadAgentoConfig(root);
  assert.equal(typeof config.worktrees.dir, "string");
  assert.match(config.worktrees.dir, /-worktrees$/);
  assert.equal(config.branches.default, "main");
  assert.equal(config.artifacts.features, "features");
  assert.equal(config.artifacts.initiatives, "initiatives");
  assert.deepEqual(config.artifacts.repo, { name: null, dir: null });
});

test("a root-level agento.json is accepted as a fallback location", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" } }));
  const { config, source } = loadAgentoConfig(root);
  assert.equal(source, path.join(root, "agento.json"));
  assert.equal(config.worktrees.dir, "../wt");
});

// --- resolveArtifactsRoot ----------------------------------------------------

const withRepo = (rootDir, repo) => {
  const config = defaultConfig(rootDir);
  config.artifacts.repo = { ...config.artifacts.repo, ...repo };
  return config;
};

test("resolveArtifactsRoot keeps the in-repo layout when artifacts.repo is unset", () => {
  const rootDir = path.resolve("/srv/project");
  const config = defaultConfig(rootDir);
  assert.deepEqual(resolveArtifactsRoot({ config, rootDir }), { external: false, name: null, dir: null, root: rootDir });
  // A config without the key at all (older agento.json merged by hand) is also in-repo.
  delete config.artifacts.repo;
  assert.deepEqual(resolveArtifactsRoot({ config, rootDir }), { external: false, name: null, dir: null, root: rootDir });
});

test("resolveArtifactsRoot derives ../<name> from the primary checkout when only name is set", () => {
  const rootDir = path.resolve("/srv/project");
  const result = resolveArtifactsRoot({ config: withRepo(rootDir, { name: "project-docs" }), rootDir });
  assert.deepEqual(result, { external: true, name: "project-docs", dir: path.resolve("/srv/project-docs"), root: path.resolve("/srv/project-docs") });
});

test("resolveArtifactsRoot derives name from the resolved dir when only dir is set", () => {
  const rootDir = path.resolve("/srv/project");
  const result = resolveArtifactsRoot({ config: withRepo(rootDir, { dir: "../planning-docs" }), rootDir });
  assert.deepEqual(result, { external: true, name: "planning-docs", dir: path.resolve("/srv/planning-docs"), root: path.resolve("/srv/planning-docs") });
});

test("resolveArtifactsRoot takes both fields as given, resolving dir against the primary checkout", () => {
  const rootDir = path.resolve("/srv/project");
  const result = resolveArtifactsRoot({ config: withRepo(rootDir, { name: "docs", dir: "../elsewhere/docs-checkout" }), rootDir });
  assert.deepEqual(result, { external: true, name: "docs", dir: path.resolve("/srv/elsewhere/docs-checkout"), root: path.resolve("/srv/elsewhere/docs-checkout") });
});

test("resolveArtifactsRoot resolves against primaryRoot, not the worktree that runs the command", () => {
  const primaryRoot = path.resolve("/srv/project");
  const rootDir = path.resolve("/srv/project-worktrees/plan-1");
  const result = resolveArtifactsRoot({ config: withRepo(primaryRoot, { name: "project-docs" }), rootDir, primaryRoot });
  assert.equal(result.root, path.resolve("/srv/project-docs"));
  assert.notEqual(result.root, path.resolve("/srv/project-worktrees/project-docs"));
  // In-repo mode still names the worktree itself as the root.
  assert.equal(resolveArtifactsRoot({ config: defaultConfig(primaryRoot), rootDir, primaryRoot }).root, rootDir);
});
