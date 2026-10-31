// Copilot user-directory and router-skill-link helpers shared by the `harness`
// command, the doctor checks, and the models filter. Moved unchanged from
// `scripts/agento.mjs`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git } from "./context.mjs";

export const LOCAL_TAKEOVER = "The router skill is the only /agento path in every session (Copilot and Local) — Builder/Reviewer keep their pins; inline agent modes and prompt model: lines do not switch; harness uninstall removes /agento.";

// The user-level skills directory; AGENTO_COPILOT_SKILLS_DIR overrides the default
// so tests never touch the real ~/.copilot/skills.
export function copilotSkillsDir(env = process.env) {
  return env.AGENTO_COPILOT_SKILLS_DIR ? env.AGENTO_COPILOT_SKILLS_DIR : path.join(os.homedir(), ".copilot", "skills");
}

// The user-level canvas extensions directory, honoring COPILOT_HOME the way the
// Copilot runtime does: AGENTO_COPILOT_EXTENSIONS_DIR (test override), then
// $COPILOT_HOME/extensions when COPILOT_HOME is non-empty, then ~/.copilot/extensions.
export function copilotExtensionsDir(env = process.env) {
  if (env.AGENTO_COPILOT_EXTENSIONS_DIR) return env.AGENTO_COPILOT_EXTENSIONS_DIR;
  const home = env.COPILOT_HOME;
  if (typeof home === "string" && home.length > 0) return path.join(home, "extensions");
  return path.join(os.homedir(), ".copilot", "extensions");
}

// The main checkout when `pluginRoot` is a linked worktree (e.g. an Agento
// development worktree), else null.
export function primaryCheckoutOf(pluginRoot) {
  const [gitDir, commonDir] = git(pluginRoot, "rev-parse", "--git-dir", "--git-common-dir").split("\n");
  if (!gitDir || !commonDir) return null;
  const common = path.resolve(pluginRoot, commonDir);
  if (path.resolve(pluginRoot, gitDir) === common) return null;
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

// The router-skill link, the plugin clone it must point at (the primary checkout of
// a linked worktree), the expected target directory, and the same for the Mission
// Control canvas link — shared by the subcommand and the doctor checks.
export function harnessFacts(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const clone = primaryCheckoutOf(root) ?? root;
  const skillsDir = copilotSkillsDir();
  const extensionsDir = copilotExtensionsDir();
  return {
    pluginRoot: root,
    clone,
    skillsDir,
    link: path.join(skillsDir, "agento"),
    expected: path.join(clone, "skills", "agento"),
    hasSkill: fs.existsSync(path.join(root, "skills", "agento", "SKILL.md")),
    extensionsDir,
    canvasLink: path.join(extensionsDir, "agento-mission-control"),
    canvasExpected: path.join(clone, "canvas", "agento-mission-control"),
    hasCanvas: fs.existsSync(path.join(root, "canvas", "agento-mission-control", "extension.mjs")),
  };
}
