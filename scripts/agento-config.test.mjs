import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadAgentoConfig } from "./agento-config.mjs";

function tmpRoot(prefix = "agento-config-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("defaults derive the worktree dir from the repository directory name", () => {
  const root = tmpRoot();
  const { config, source } = loadAgentoConfig(root);
  assert.equal(source, null);
  assert.equal(config.artifacts.features, "features");
  assert.equal(config.artifacts.issues, "issues");
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
});

test("a root-level agento.json is accepted as a fallback location", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" } }));
  const { config, source } = loadAgentoConfig(root);
  assert.equal(source, path.join(root, "agento.json"));
  assert.equal(config.worktrees.dir, "../wt");
});
