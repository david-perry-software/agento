// The doctor machinery and its document builder, moved unchanged from the legacy
// `scripts/agento.mjs`. `doctorDocument` lives here (rather than
// `lib/documents.mjs`) because it is the machinery's own builder; preflight,
// dashboard, start-session, and ship all share it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hasAgentoWorkspaceWiring } from "../agento-config.mjs";
import { linkState } from "../harness.mjs";
import { deriveRole } from "../session-state.mjs";
import { harnessFacts, LOCAL_TAKEOVER } from "./copilot.mjs";
import {
  artifacts,
  companionWorktreesDir,
  config,
  git,
  options,
  PLUGIN_ROOT,
  primaryWorktreesDir,
  productWorktrees,
  roleCwd,
  root,
  source,
} from "./context.mjs";
import { loadProfiles, loadRoles, modelsPins, modelsState, pinWarnings, resolveProfile } from "./models.mjs";
import { ghVersion, probe } from "./probe.mjs";
import { holdsArtifacts } from "./records.mjs";
import { describeWorkspace } from "./session.mjs";

// --- doctor ----------------------------------------------------------------

const lsRemoteArgs = () => ["-C", root, "ls-remote", "--exit-code", "--heads", "origin", config.branches.default];

// The external commands DOCTOR_CHECKS probe, so `dashboard` can run them concurrently first.
const doctorProbes = () => [["gh", ["--version"]], ["gh", ["auth", "status"]], ["git", lsRemoteArgs()], ["code", ["--version"]]];

const DOCTOR_CHECKS = {
  node() {
    const version = process.versions.node;
    const major = Number.parseInt(version.split(".")[0], 10);
    return major >= 20
      ? { status: "ok", detail: `node v${version}`, fallback: null }
      : { status: "fail", detail: `node v${version} is below the required 20`, fallback: "install Node >= 20 (AGENTS.md); the Agento CLI, both hooks (delivery guard and SessionStart context), and the tests need it" };
  },
  "git-remote"() {
    const url = git(root, "remote", "get-url", "origin");
    if (!url) return { status: "fail", detail: "no `origin` remote", fallback: "add the remote (`git remote add origin <url>`) or work in a clone; push and PR steps need origin" };
    const reach = probe("git", lsRemoteArgs());
    return reach.ok
      ? { status: "ok", detail: `origin ${url}, ${config.branches.default} reachable`, fallback: null }
      : { status: "warn", detail: `origin ${url} unreachable: ${reach.detail}`, fallback: "work offline; fetch, push, and PR steps will fail until the network is back — retry them before ending the turn" };
  },
  gh() {
    const version = ghVersion();
    if (!version.ok) return { status: "fail", detail: version.missing ? "gh CLI not found on PATH" : `gh --version failed: ${version.detail}`, fallback: "install GitHub CLI (https://cli.github.com) — the user installs it; the agent does not" };
    const auth = probe("gh", ["auth", "status"]);
    return auth.ok
      ? { status: "ok", detail: `${version.out}; authenticated`, fallback: null }
      : { status: "fail", detail: `gh auth status failed: ${auth.detail}`, fallback: "stop; the user runs `gh auth login` in their own terminal, then re-sends the command (policy §1: never run it on their behalf)" };
  },
  code() {
    const version = probe("code", ["--version"]);
    return version.ok
      ? { status: "ok", detail: `code ${version.out}`, fallback: null }
      : { status: "warn", detail: version.missing ? "code CLI not found on PATH" : `code --version failed: ${version.detail}`, fallback: "keep the worktree and print `code --new-window <worktree-path>` for the user to run" };
  },
  "worktrees-dir"() {
    const dir = primaryWorktreesDir();
    let existing = dir;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    try {
      fs.accessSync(existing, fs.constants.W_OK);
      return { status: "ok", detail: existing === dir ? `${dir} writable` : `${dir} absent; ${existing} writable, it will be created`, fallback: null };
    } catch {
      return { status: "fail", detail: `${dir} not writable (${existing} denies write)`, fallback: "create the directory with write permission or change worktrees.dir in .github/agento.json" };
    }
  },
  "session-workspace"() {
    const worktrees = productWorktrees();
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { worktree } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
    const workspace = describeWorkspace(worktree, sessionWorktreesDir);
    if (!workspace) return { status: "ok", detail: "not a managed pair", fallback: null };
    if (workspace.current) return { status: "ok", detail: `${workspace.path} carries the session auto-approve settings`, fallback: null };
    return {
      status: "warn",
      detail: `${workspace.path} lacks the session auto-approve settings`,
      fallback: `run node ${path.join(PLUGIN_ROOT, "scripts", "agento.mjs")} workspace ${worktree.dirPrefix} ${worktree.id} --write, then Developer: Reload Window`,
    };
  },
  "artifact-repo"() {
    if (!artifacts.external) return { status: "ok", detail: "in-repo layout (artifacts.repo unset)", fallback: null };
    const { name, dir } = artifacts;
    const fallback = `run \`/agento agento-init\` to create and clone the companion repository ${name} at ${dir}, or correct artifacts.repo in .github/agento.json`;
    const fail = (detail) => ({ status: "fail", detail, fallback });
    if (!fs.existsSync(dir)) return fail(`${dir} absent`);
    const toplevel = git(dir, "rev-parse", "--show-toplevel");
    if (!toplevel || fs.realpathSync(toplevel) !== fs.realpathSync(dir)) return fail(`${dir} is not a git checkout toplevel (git rev-parse --show-toplevel → ${toplevel || "nothing"})`);
    const url = git(dir, "remote", "get-url", "origin");
    if (!url) return fail(`${dir} has no \`origin\` remote`);
    const branch = config.branches.default;
    if (!git(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`) && !git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
      return fail(`${dir} has neither origin/${branch} nor ${branch}`);
    }
    const detail = `${dir} (${name}), origin ${url}, ${branch} present`;
    // Pre-migration leftovers in the product repo are ignored by every reader; say so once.
    const primaryRoot = productWorktrees()[0]?.path ?? root;
    const stale = [config.artifacts.features, config.artifacts.issues, config.artifacts.initiatives].filter((rel) => holdsArtifacts(path.join(primaryRoot, rel)));
    if (stale.length) {
      return { status: "warn", detail: `${detail}; stale in-repo roots: ${stale.map((r) => `${r}/`).join(", ")}`, fallback: "the in-repo roots are ignored while artifacts.repo is set; move them into the companion (`/agento agento-init --migrate`) or remove them" };
    }
    // The companion halves of paired sessions go under <dir>-worktrees (derived, no key).
    const pairDir = artifacts.worktreesDir;
    if (fs.existsSync(pairDir)) {
      try {
        fs.accessSync(pairDir, fs.constants.W_OK);
      } catch {
        return { status: "warn", detail: `${detail}; ${pairDir} not writable`, fallback: `give ${pairDir} write permission (it holds the companion half of every paired session) or remove it so it is recreated` };
      }
    }
    return { status: "ok", detail, fallback: null };
  },
  // Not in CAPABILITY_CHECKS: informational, so `doctor --for` never runs it.
  "model-profile"() {
    const pluginRoot = path.resolve(options.pluginRoot ?? PLUGIN_ROOT);
    if (!fs.existsSync(path.join(pluginRoot, ".github", "agents"))) return { status: "ok", detail: `no Agento plugin clone at ${pluginRoot}`, fallback: null };
    const loaded = loadProfiles();
    const loadedRoles = loadRoles();
    const cli = `agento.mjs models --plugin-root ${pluginRoot}`;
    if (loaded.errors.length) {
      return { status: "warn", detail: `${loaded.profilesFile.path} has ${loaded.errors.length} error(s), first: ${loaded.errors[0]}`, fallback: `fix the file (\`${cli}\` lists every error) or delete it; Agento runs fine without profiles` };
    }
    const state = modelsState(pluginRoot, loaded);
    const { active, filter, legacySkipWorktree } = state;
    const apply = `\`agento.mjs models apply <name> --plugin-root ${pluginRoot}\``;
    const adopt = `\`agento.mjs models adopt --plugin-root ${pluginRoot}\``;
    const filterIssues = [];
    if (legacySkipWorktree?.length) {
      filterIssues.push([`${legacySkipWorktree.length} file(s) still carry legacy skip-worktree pins, so a git pull or merge that touches one stops`, `${adopt} keeps the current pins on the git filter, or ${apply} re-pins a profile`]);
    } else if (filter && active !== null && !filter.installed) {
      const missing = [!filter.config && "filter config", !filter.attributes && "attribute block", filter.state !== "ok" && `pin state (${filter.state})`].filter(Boolean).join(", ");
      filterIssues.push([`pins in ${pluginRoot} are not carried by a healthy git filter (missing: ${missing}), so a pull or commit may touch them`, `${apply} or ${adopt} reinstalls it`]);
    } else if (filter?.installed && !filter.scriptCurrent) {
      filterIssues.push([`the git filter's copied script in ${path.dirname(filter.script)} is missing or older than this CLI`, `${apply} or ${adopt} refreshes it`]);
    }
    if (filter?.unrecorded.length) {
      filterIssues.push([`${filter.unrecorded.length} agent/prompt file(s) added since the last apply carry no pin: ${filter.unrecorded.join(", ")}`, `re-run ${apply}`]);
    }
    const rolesDetail = `primary: ${active === null ? "none" : active}; secondary: ${loadedRoles.errors.length ? "invalid" : (loadedRoles.secondary ?? "off")}`;
    const rolesIssue = (() => {
      if (loadedRoles.errors.length) {
        return { detail: `${loadedRoles.rolesFile.path} has ${loadedRoles.errors.length} error(s), first: ${loadedRoles.errors[0]}`, fallback: `fix or delete ${loadedRoles.rolesFile.path}, or run \`agento.mjs models use none --role secondary --plugin-root ${pluginRoot}\` to turn the secondary role off` };
      }
      if (loadedRoles.secondary !== null) {
        const assigned = loadedRoles.secondary;
        if (!Object.hasOwn(loaded.profiles, assigned)) {
          return { detail: `the secondary role names ${JSON.stringify(assigned)}, which is not a profile in ${loaded.profilesFile.path}`, fallback: `run \`agento.mjs models use none --role secondary --plugin-root ${pluginRoot}\` to turn it off, or create ${assigned} and assign it with \`agento.mjs models use ${assigned} --role secondary --plugin-root ${pluginRoot}\`` };
        }
        const resolved = resolveProfile(loaded, assigned, state.layout);
        if (resolved.errors.length) {
          return { detail: `the secondary profile ${assigned} has errors: ${resolved.errors[0]}`, fallback: `fix ${assigned} (\`agento.mjs models show ${assigned} --plugin-root ${pluginRoot}\` lists every error), or run \`agento.mjs models use none --role secondary --plugin-root ${pluginRoot}\` to turn it off` };
        }
      }
      return null;
    })();
    if (filterIssues.length) return { status: "warn", detail: `${filterIssues.map(([d]) => d).join("; ")}; ${rolesDetail}`, fallback: filterIssues.map(([, f]) => f).join("; ") };
    if (rolesIssue) return { status: "warn", detail: `${rolesIssue.detail}; ${rolesDetail}`, fallback: rolesIssue.fallback };
    if (active === null) return { status: "ok", detail: `no profile applied to ${pluginRoot}; ${rolesDetail}`, fallback: null };
    if (active !== "custom") {
      const pins = modelsPins(pluginRoot, loaded.copilotModels);
      const warns = pinWarnings(pins, loaded.copilotModels);
      if (warns.byok || warns.unqualified || warns.missingAlias) {
        const fallbacks = [
          warns.byok && `pin autopilot at least as high as the highest-tier model it delegates to, then \`agento.mjs models apply <name> --plugin-root ${pluginRoot}\``,
          warns.unqualified && `qualify each named value as "<picker name> (<vendor>)" in ${loaded.profilesFile.path}, then \`agento.mjs models apply ${active} --plugin-root ${pluginRoot}\``,
          warns.missingAlias && `add each missing picker name to the top-level copilotModels map in ${loaded.profilesFile.path}, then \`agento.mjs models apply ${active} --plugin-root ${pluginRoot}\``,
        ];
        return { status: "warn", detail: `${[warns.byok, warns.unqualified, warns.missingAlias].filter(Boolean).join("; ")}; ${rolesDetail}`, fallback: fallbacks.filter(Boolean).join("; ") };
      }
      return { status: "ok", detail: `${active} applied to ${pluginRoot}; ${rolesDetail}`, fallback: null };
    }
    return {
      status: "warn",
      detail: `model: lines in ${pluginRoot} match no profile in ${loaded.profilesFile.path} (hand-edited, or the profile changed after it was applied); ${rolesDetail}`,
      fallback: `re-pin with ${apply}, record the current pins with ${adopt}, or unpin with \`agento.mjs models clear --plugin-root ${pluginRoot}\``,
    };
  },
  // Not in CAPABILITY_CHECKS: informational, so `doctor --for` never runs it.
  "hook-wiring"() {
    if (!hasAgentoWorkspaceWiring(root)) return { status: "ok", detail: "no Agento workspace-mode hook wiring in this repository", fallback: null };
    const file = vscodeSettingsPath();
    let settings;
    try {
      settings = parseJsonc(fs.readFileSync(file, "utf8"));
    } catch (error) {
      return { status: "ok", detail: `workspace-mode hook wiring present; ${file} unreadable (${error.code ?? error.message}), plugin registration unknown`, fallback: null };
    }
    const locations = settings?.["chat.pluginLocations"];
    const common = gitCommonDir(root);
    const registered = common && locations && typeof locations === "object" && !Array.isArray(locations)
      ? Object.entries(locations).filter(([dir, on]) => on === true && gitCommonDir(expandHome(dir)) === common).map(([dir]) => dir)
      : [];
    if (!registered.length) return { status: "ok", detail: `workspace-mode hook wiring present; this repository is not registered in chat.pluginLocations (${file})`, fallback: null };
    return {
      status: "warn",
      detail: `${registered.join(", ")} (this repository) is registered in chat.pluginLocations (${file}): plugin-mode and workspace-mode hooks both fire — SessionStart is deduplicated, the delivery guard runs twice; a per-workspace plugin disable is not visible to the CLI`,
      fallback: "disable the Agento plugin for this workspace (Extensions → Agent Plugins – Installed) in each worktree window, or remove the clone from chat.pluginLocations (docs/install.md)",
    };
  },
  // Not in CAPABILITY_CHECKS: informational, so `doctor --for` never runs it.
  "harness"() {
    const facts = harnessFacts(options.pluginRoot ?? PLUGIN_ROOT);
    const install = `agento.mjs harness install --plugin-root ${facts.clone}`;
    if (!facts.hasSkill) return { status: "ok", detail: `no Agento router skill at ${facts.pluginRoot}`, fallback: null };
    const { state, target } = linkState(facts.link, facts.expected);
    if (state === "installed") return { status: "ok", detail: `${facts.link} → ${facts.clone}; ${LOCAL_TAKEOVER}`, fallback: null };
    if (state === "absent") return { status: "fail", detail: `cannot run /agento in any session — ${facts.link} is missing`, fallback: install };
    if (state === "foreign") return { status: "fail", detail: `cannot run /agento in any session — ${facts.link} resolves to ${target}`, fallback: `agento.mjs harness install --force --plugin-root ${facts.clone} (or keep the other clone's link)` };
    if (state === "dangling") return { status: "fail", detail: `cannot run /agento in any session — ${facts.link} is a dangling symlink to ${target}`, fallback: `agento.mjs harness install --force --plugin-root ${facts.clone}` };
    return { status: "fail", detail: `cannot run /agento in any session — ${facts.link} is a real directory or file, not a symlink`, fallback: `move it away, then ${install}` };
  },
  // Not in CAPABILITY_CHECKS: informational, so `doctor --for` never runs it.
  "canvas"() {
    const facts = harnessFacts(options.pluginRoot ?? PLUGIN_ROOT);
    const install = `agento.mjs harness install --plugin-root ${facts.clone}`;
    if (!facts.hasCanvas) return { status: "ok", detail: `no Mission Control canvas at ${facts.canvasExpected} (this clone predates it)`, fallback: null };
    const { state, target } = linkState(facts.canvasLink, facts.canvasExpected);
    if (state === "installed") return { status: "ok", detail: `${facts.canvasLink} → ${facts.clone}; Mission Control canvas installed`, fallback: null };
    if (state === "absent") return { status: "warn", detail: `Mission Control canvas link ${facts.canvasLink} is missing`, fallback: install };
    if (state === "foreign") return { status: "warn", detail: `Mission Control canvas link ${facts.canvasLink} resolves to ${target}`, fallback: `agento.mjs harness install --force --plugin-root ${facts.clone} (or keep the other clone's canvas)` };
    if (state === "dangling") return { status: "warn", detail: `Mission Control canvas link ${facts.canvasLink} is a dangling symlink to ${target}`, fallback: `agento.mjs harness install --force --plugin-root ${facts.clone}` };
    return { status: "warn", detail: `Mission Control canvas link ${facts.canvasLink} is a real directory or file, not a symlink`, fallback: `move it away, then ${install}` };
  },
};

// VS Code's user settings.json; AGENTO_VSCODE_SETTINGS overrides the platform default.
function vscodeSettingsPath(env = process.env) {
  if (env.AGENTO_VSCODE_SETTINGS) return env.AGENTO_VSCODE_SETTINGS;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "settings.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code", "User", "settings.json");
}

const expandHome = (dir) => (dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir);

function gitCommonDir(dir) {
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return "";
  try {
    return fs.realpathSync(common);
  } catch {
    return common;
  }
}

// JSON with // and /* */ comments and trailing commas, as VS Code writes settings.json.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === "," && /^\s*[}\]]/.test(text.slice(i + 1).replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, ""))) {
      continue;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}


const STATUS_RANK = { ok: 0, warn: 1, fail: 2 };

// Capability vocabulary (delivery-policy §10) in canonical order, each mapped to the
// doctor checks that prove it. Chat-tool capabilities have no CLI-side check.
const CAPABILITY_CHECKS = {
  terminal: ["node", "worktrees-dir", "artifact-repo", "session-workspace"],
  "ask-questions": [],
  browser: [],
  gh: ["gh"],
  code: ["code"],
  network: ["git-remote"],
};

// What each slash command declares on its `Needs:` line; the customizations test
// keeps this table and the prompt bodies in agreement.
const COMMAND_NEEDS = {
  "agento-init": ["terminal", "ask-questions", "gh", "network"],
  ap: ["terminal", "browser", "gh", "network"],
  "build-feature": ["terminal", "browser", "gh", "network"],
  "build-issue": ["terminal", "browser", "gh", "network"],
  "close-session": ["terminal"],
  "commit-current-changes": ["terminal", "gh", "network"],
  continue: ["terminal", "ask-questions", "browser", "gh", "code", "network"],
  "delivery-status": ["terminal"],
  doctor: ["terminal"],
  "extend-copilot": ["terminal"],
  "finish-freehand": ["terminal", "gh", "network"],
  "fix-copilot": ["terminal"],
  "install-skills": ["terminal", "ask-questions", "network"],
  "mission-control": ["terminal"],
  models: ["terminal"],
  "new-feature": ["terminal", "ask-questions", "gh", "network"],
  "new-initiative": ["terminal", "ask-questions", "gh", "network"],
  "new-issue": ["terminal", "ask-questions", "gh", "network"],
  "next-feature": ["terminal"],
  "quick-fix": ["terminal", "gh", "network"],
  "review-feature": ["terminal", "browser", "gh", "network"],
  "review-issue": ["terminal", "browser", "gh", "network"],
  ship: ["terminal", "gh", "network"],
  "start-freehand": ["terminal", "code"],
  "start-session": ["terminal", "code"],
  "triage-followups": ["terminal", "gh", "network"],
};

function checksFor(needs) {
  const ids = new Set(needs.flatMap((n) => CAPABILITY_CHECKS[n]));
  return Object.keys(DOCTOR_CHECKS).filter((id) => ids.has(id));
}

// Each check runs at most once per process, so `dashboard` can run the local ones early.
const doctorResults = new Map();

function runDoctor(ids) {
  const checks = ids.map((id) => {
    if (!doctorResults.has(id)) {
      try {
        doctorResults.set(id, { id, ...DOCTOR_CHECKS[id]() });
      } catch (error) {
        doctorResults.set(id, { id, status: "fail", detail: `check threw: ${error?.message ?? error}`, fallback: "report this as an Agento bug; run the probe by hand" });
      }
    }
    return doctorResults.get(id);
  });
  const status = checks.reduce((worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst), "ok");
  return { status, checks };
}

// The checks that run no external probe (doctorProbes) and so need no network.
const LOCAL_DOCTOR_CHECKS = ["node", "worktrees-dir", "session-workspace", "artifact-repo", "model-profile", "hook-wiring", "harness"];
function capabilityOf(checkId) {
  return Object.entries(CAPABILITY_CHECKS).find(([, ids]) => ids.includes(checkId))?.[0] ?? checkId;
}
// What `doctor [--for <command>]` emits; `command` must name a COMMAND_NEEDS entry.
function doctorDocument(command = null) {
  const needs = command ? COMMAND_NEEDS[command] : null;
  const { status, checks } = runDoctor(needs ? checksFor(needs) : Object.keys(DOCTOR_CHECKS));
  return { status, for: needs ? { command, needs } : null, checks, root, configSource: source };
}

export {
  DOCTOR_CHECKS,
  CAPABILITY_CHECKS,
  COMMAND_NEEDS,
  checksFor,
  runDoctor,
  LOCAL_DOCTOR_CHECKS,
  doctorProbes,
  capabilityOf,
  doctorDocument,
};
