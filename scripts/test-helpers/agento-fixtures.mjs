import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixtures shared by scripts/commands/*.test.mjs. This module resolves the CLI
// path from its own location (scripts/test-helpers), never from the test file's
// location, per plan.md Approach rule 7.
const fixturesDir = path.dirname(fileURLToPath(import.meta.url)); // scripts/test-helpers
const cli = path.join(path.dirname(fixturesDir), "agento.mjs"); // scripts/agento.mjs
const repoRoot = path.dirname(path.dirname(cli)); // repo root

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// A working clone with a bare origin, so remote fallbacks exercise real git.
// `companion: true` adds a sibling `<base>/project-docs` clone (own bare origin,
// `main` pushed) for artifacts.repo tests; the caller sets the config key.
function makeRepo({ config, companion = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-cli-"));
  const work = cloneWithOrigin(base, "project", config);
  if (companion) cloneWithOrigin(base, "project-docs");
  return work;
}

function cloneWithOrigin(base, name, config) {
  const origin = path.join(base, `${name}.git`);
  const work = path.join(base, name);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  if (config) {
    fs.mkdirSync(path.join(work, ".github"), { recursive: true });
    fs.writeFileSync(path.join(work, ".github", "agento.json"), JSON.stringify(config));
    git(work, "add", "-A");
  }
  git(work, "commit", "-q", "--allow-empty", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  return work;
}

const companionOf = (repo) => path.join(path.dirname(repo), "project-docs");

function writeRoadmap(root, rel, header, steps = "- [x] 1.1 done — verify: x\n- [ ] 1.2 todo — verify: y\n") {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "roadmap.md"), "```yaml\n" + header + "\n```\n\n## Phase 1\n\n" + steps);
}

// features: [{ slug, requires?, recommendedAfter?, wave? }] in listed order; the
// header defaults to the initiative slug derived from the directory name.
function writeBreakdown(root, rel, header, features) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const list = (v) => (v && v.length ? v.join(", ") : "none");
  const blocks = features
    .map((f) => [`### ${f.slug}`, `- Summary: ${f.slug}`, `- Requires: ${list(f.requires)}`, `- Recommended after: ${list(f.recommendedAfter)}`, ...(f.wave ? [`- Wave: ${f.wave}`] : []), "- Size: S"].join("\n"))
    .join("\n\n");
  const yaml = header ?? `initiative: ${path.basename(rel)}\ncreated: 2026-09-01\nlast-updated: 2026-09-02`;
  fs.writeFileSync(
    path.join(dir, "breakdown.md"),
    "```yaml\n" + yaml + "\n```\n\n# Title\n\n## Goal\n\ng\n\n## Features\n\n" + blocks + "\n\n## Recommended order\n\no\n",
  );
}

function run(cwd, ...args) {
  return runWith({ cwd }, ...args);
}

// CI itself runs under GITHUB_ACTIONS=true; strip the hosted markers so the
// path-based role assertions hold everywhere, and inject them only on purpose.
const baseEnv = { ...process.env };
delete baseEnv.CODESPACES;
delete baseEnv.GITHUB_ACTIONS;
// Never read the real ~/.config/agento/model-profiles.json.
baseEnv.AGENTO_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agento-config-home-"));
// Never read the real VS Code user settings (doctor hook-wiring).
baseEnv.AGENTO_VSCODE_SETTINGS = path.join(baseEnv.AGENTO_CONFIG_HOME, "vscode-settings.json");
// Never read the real VS Code window state (windows, handoff).
baseEnv.AGENTO_VSCODE_USER_DIR = path.join(baseEnv.AGENTO_CONFIG_HOME, "vscode-user");
// Never touch the real ~/.copilot/skills (harness install/status/uninstall).
baseEnv.AGENTO_COPILOT_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agento-skills-"));
// Never touch the real ~/.copilot/extensions (harness canvas link).
baseEnv.AGENTO_COPILOT_EXTENSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agento-extensions-"));

function runWith({ cwd, env, input }, ...args) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: env ?? baseEnv, input: input ?? undefined });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(`non-JSON output: ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
}

// A PATH holding only node and git (plus any extra executables), so gh lookups are deterministic.
function restrictedPath(extra = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-bin-"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
  for (const [name, script] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return { bin, env: { ...baseEnv, PATH: bin } };
}

export {
  baseEnv,
  cli,
  cloneWithOrigin,
  companionOf,
  git,
  makeRepo,
  repoRoot,
  restrictedPath,
  run,
  runWith,
  writeBreakdown,
  writeRoadmap,
};
