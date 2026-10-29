// PreToolUse guard: protects the default branch, forbids force-push and hook bypasses,
// nudges roadmap updates, checks worktree occupants, and gates hook-file edits behind
// approval. Branch names and artifact roots come from the target repo's
// .github/agento.json. When that config sets `artifacts.repo`, the sibling companion
// checkout — and every worktree of it, i.e. the companion halves of managed sessions —
// is governed by the product config too (its default branch is protected the same
// way) and the roadmap nudge on a product delivery-branch commit inspects the paired
// companion half's index and HEAD instead of the product commit.
//
// This is a slip guard for an LLM operator, not an enforcement boundary: it pattern
// matches shell text and can be worked around. GitHub rulesets on the default branch
// are the real enforcement layer; keep both.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOccupants as defaultFindOccupants } from "../worktree-occupants.mjs";
import { emit, loadHookConfig, readPayload, realpath, resolveArtifacts, runGit, shellSplit } from "./hook-lib.mjs";

// Opt-in diagnostic: when the marker file /tmp/agento-guard-debug exists (or
// AGENTO_GUARD_DEBUG_LOG names a log file), main() records the raw PreToolUse
// payload, the cwd, the plugin env markers, and the resulting decision to that log.
// Off by default; Local behavior is unchanged without the marker. The log is
// machine-local and must be removed after the diagnosis.
const DEBUG_LOG = process.env.AGENTO_GUARD_DEBUG_LOG || "/tmp/agento-guard-debug.log";
const DEBUG_MARKER = "/tmp/agento-guard-debug";

export function debugEnabled() {
  if (process.env.AGENTO_GUARD_DEBUG_LOG) return true;
  try {
    return fs.existsSync(DEBUG_MARKER);
  } catch {
    return false;
  }
}

export function debugWrite(entry) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // Diagnostics must never affect the guard verdict.
  }
}

const PROTECTED_PATHS = String.raw`\.github\/hooks\/|scripts\/hooks\/|(?<![\w.-])hooks\/hooks\.json|\.claude-plugin(?![\w.-])`;
const PROTECTED = new RegExp(`(${PROTECTED_PATHS})`);
const PROTECTED_REDIRECT = new RegExp(String.raw`(?<![<])>{1,2}\s*\S*(` + PROTECTED_PATHS + ")");
const WRITE_TOOL = /edit|create|write|replace|patch|apply|insert|notebook/;

// Explicit Copilot ↔ Local tool-name map for `decide()`. The guard derives shell text
// by key (`command`/`commandLine`/`text`), so the `shell` and `neither` classes are
// documentation of the harness names; only the `write` class changes a verdict (the
// protected-file ask below).
const TOOL_CLASS = new Map([
  ...["bash", "run_in_terminal"].map((t) => [t, "shell"]),
  ...["write", "edit", "create_file", "replace_string_in_file"].map((t) => [t, "write"]),
  ...["read", "agent", "tool_search_tool"].map((t) => [t, "neither"]),
]);
const isWriteTool = (tool) => TOOL_CLASS.get(tool) === "write" || WRITE_TOOL.test(tool);

// Tool input is the first of `tool_input` / `toolInput` / `toolArgs` that is a plain
// object, or a string that `JSON.parse`s to one; anything else (arrays, malformed
// JSON, other scalars) is `{}` so `decide()` allows instead of throwing.
function readToolInput(payload) {
  for (const key of ["tool_input", "toolInput", "toolArgs"]) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // Malformed JSON: fall through to the next key, then `{}`.
      }
    }
  }
  return {};
}

// Shell segments: split on control operators so branch state and command words are
// evaluated per command rather than across the whole line.
const SEGMENT_SPLIT = /\|\||&&|[;|&\n]|\bthen\b|\bdo\b|\belse\b/;

// Commands that only read a hook file. Anything else naming a hook path is treated as
// a write however it is spelled (rm, mv, cp, install, truncate, tee, perl -pi, ...).
const READ_ONLY = new Set([
  "cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "diff",
  "shellcheck", "ls", "stat", "file", "wc", "md5sum", "sha256sum", "shasum", "bat",
  "bash", "sh", "zsh", "source", ".", "node", "python3", "python", "echo", "printf",
  "test", "[", "which", "type", "realpath", "readlink", "basename", "dirname", "find",
  "awk", "sed", "perl", "cut", "sort", "uniq", "tr", "od", "hexdump", "strings", "cd",
  "pushd", "code",
]);
const GIT_SAFE_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "grep", "cat-file",
  "add", "commit", "push", "stash", "rev-parse", "mv",
]);
const PREFIXES = new Set(["env", "sudo", "nohup", "setsid", "exec", "time", "command", "builtin", "nice", "timeout"]);
const HOOK_WRITE_DENY = "Destructive shell changes to hook files are forbidden; use an edit tool so the change can be approved.";

// Open-ended watchers never return in an automation shell and idle the session.
const WATCHER = new RegExp(
  String.raw`^(?:(?:env|sudo|nohup|setsid|exec|time|command|nice)\s+|timeout\s+\S+\s+)*(?:(?:-u\s+\S+|\S+=\S*)\s+)*` +
    String.raw`(?:gh\s+(?:pr\s+checks\b.*--watch|run\s+watch\b)|vercel\b.*\s--wait\b)`,
);

const GIT = String.raw`\bgit\b(?:\s+-[Cc]\s+\S+)*`;
// Shell redirections are never pathspecs: `2>&1`, `2>/dev/null`, `>out`, `> out`
// (the segment splitter also leaves a bare `2>` behind from `2>&1`).
const REDIRECT = /^\d*(?:&>>?|>&|<&|>>?|<<?)(.*)$/;
const COMMIT_VALUE_OPTIONS = new Set([
  "--message", "--file", "--author", "--date", "--fixup", "--squash",
  "--reuse-message", "--reedit-message", "--trailer", "--template",
]);
const MANAGED_HALF = /^(plan|feature|issue|freehand)-/;
// `git push` options whose value is the next token.
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

// What a `git push` segment sends: `{ all, tags, refspecs: [{ src, dst }] }`. `src` is
// "" for a deletion, a bare ref is its own destination, and `refs/heads/` is stripped.
export function pushRefspecs(tokens) {
  let at = tokens.indexOf("push");
  if (at < 0) {
    tokens = tokens.flatMap((t) => (/\s/.test(t) ? shellSplit(t) : [t])); // `bash -c 'git push …'`
    at = tokens.indexOf("push");
  }
  const result = { all: false, tags: false, refspecs: [] };
  if (at < 0) return result;
  const positional = [];
  let del = false;
  let skip = false;
  for (const tok of tokens.slice(at + 1)) {
    if (skip) {
      skip = false;
      continue;
    }
    const redirect = tok.match(REDIRECT);
    if (redirect) {
      skip = redirect[1] === "";
      continue;
    }
    if (tok.startsWith("--") && tok.length > 2) {
      const name = tok.split("=")[0];
      skip = PUSH_VALUE_OPTIONS.has(name) && !tok.includes("=");
      result.all ||= name === "--all" || name === "--branches" || name === "--mirror";
      result.tags ||= name === "--tags";
      del ||= name === "--delete";
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      del ||= tok.includes("d");
      skip = tok.endsWith("o");
      continue;
    }
    positional.push(tok);
  }
  // `@` is git's shorthand for `HEAD`.
  const branchOf = (ref) => (ref === "@" ? "HEAD" : ref.replace(/^refs\/heads\//, ""));
  for (const spec of positional.slice(1)) {
    const plain = spec.replace(/^\+/, "");
    const colon = plain.indexOf(":");
    const src = del ? "" : colon < 0 ? plain : plain.slice(0, colon);
    const dst = colon < 0 ? plain : plain.slice(colon + 1);
    result.refspecs.push({ src: branchOf(src), dst: branchOf(dst) });
  }
  return result;
}

const stripQuotes = (s) => s.replace(/^['"]+|['"]+$/g, "");
// os.path.basename: everything after the last slash ("" for a trailing slash).
const baseName = (s) => s.slice(s.lastIndexOf("/") + 1);

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function expandUser(p) {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return (process.env.HOME || os.homedir()) + p.slice(1);
}

function commandWord(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i += 1;
      continue;
    }
    if (PREFIXES.has(tok)) {
      i += 1;
      if (tok === "timeout" && i < tokens.length) i += 1; // skip the duration
      continue;
    }
    return [tok, tokens.slice(i + 1)];
  }
  return ["", []];
}

const verdict = (decision, reason = "") => ({ decision, reason });

function worktreeRemoveTarget(command, hookCwd) {
  const match = command.match(
    /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+worktree\s+remove(?:\s+--[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/,
  );
  if (!match) return "";
  const target = stripQuotes(match[1]);
  if (!target || target.startsWith("$")) return "";
  return path.resolve(hookCwd, target);
}

function hookFileVerdict(segments) {
  for (const segment of segments) {
    if (!PROTECTED.test(segment)) continue;
    if (PROTECTED_REDIRECT.test(segment)) return verdict("deny", HOOK_WRITE_DENY);
    const [word, rest] = commandWord(shellSplit(segment));
    const base = baseName(word);
    if (PROTECTED.test(word)) continue; // running the hook script itself
    if (base === "git") {
      const sub = rest.find((t) => !t.startsWith("-")) ?? "";
      if (GIT_SAFE_SUBCOMMANDS.has(sub)) continue;
      return verdict("deny", `\`git ${sub}\` against a hook file rewrites it from history; use an edit tool so the change can be approved.`);
    }
    if ((base === "sed" || base === "perl") && rest.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t))) {
      return verdict("deny", HOOK_WRITE_DENY);
    }
    if (READ_ONLY.has(base)) continue;
    if (["cp", "install", "rsync", "scp"].includes(base)) {
      // Copying a hook file elsewhere is a read; only a hook destination is a write.
      const positional = rest.filter((t) => !t.startsWith("-"));
      if (positional.length && !PROTECTED.test(positional.at(-1))) continue;
    }
    if (["chmod", "chown", "touch"].includes(base)) {
      return verdict("ask", `\`${base}\` on a protected hook file; approve this specific change?`);
    }
    return verdict("deny", HOOK_WRITE_DENY);
  }
  return null;
}

// A `git config` segment that writes core.hooksPath (case-insensitive key): a value
// positional after the key, the --unset/--unset-all/--replace-all/--add flags, or the
// git >= 2.46 `set`/`unset` subcommands. Reads (--get, --get-all, the key alone) and
// other keys are not writes.
function gitConfigHooksPathWrite(segment) {
  const match = segment.match(/\bgit\b(?:\s+-[Cc]\s+\S+)*\s+config\b/);
  if (!match) return false;
  const toks = shellSplit(segment.slice(match.index + match[0].length));
  const keyIdx = toks.findIndex((t) => t.toLowerCase() === "core.hookspath");
  if (keyIdx < 0) return false;
  if (toks.some((t) => /^--(unset|unset-all|replace-all|add)$/.test(t))) return true;
  if (toks.slice(0, keyIdx).some((t) => t === "set" || t === "unset")) return true;
  return toks.slice(keyIdx + 1).some((t) => !t.startsWith("-"));
}

// HUSKY=0 and a non-empty HUSKY_SKIP_HOOKS skip the project's hooks; HUSKY=1 (or any
// other HUSKY value) and other variables do not.
const hookSkipEnv = (tok) => /^HUSKY=0$/.test(tok) || /^HUSKY_SKIP_HOOKS=.+/.test(tok);

// Leading assignments (including after env/sudo/... prefixes) that precede a git word.
function hookSkipAssignments(segment) {
  const toks = shellSplit(segment);
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      if (hookSkipEnv(tok)) return true;
      i += 1;
      continue;
    }
    if (PREFIXES.has(tok)) {
      i += 1;
      if (tok === "timeout" && i < toks.length) i += 1;
      continue;
    }
    break;
  }
  return false;
}

// `export HUSKY=0` / `export HUSKY_SKIP_HOOKS=<non-empty>` in any segment.
function hookSkipExport(segment) {
  const toks = shellSplit(segment);
  const at = toks.indexOf("export");
  if (at < 0) return false;
  return toks.slice(at + 1).some(hookSkipEnv);
}

// `gh api` writes. `-f`/`-F`/`--field`/`--raw-field`/`--input` imply POST when no
// explicit method is given (gh's real behaviour); `-X`/`-XVAL`/`--method`/`--method=`
// name the method in any case.
function ghApiMethodAndEndpoint(toks, start) {
  let method = "";
  let endpoint = "";
  let fieldFlag = false;
  for (let i = start; i < toks.length; i += 1) {
    const t = toks[i];
    if (t === "-X" || t === "-x" || t === "--method") {
      method = toks[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (/^-[xX][A-Za-z]+$/.test(t)) {
      method = t.slice(2);
      continue;
    }
    if (/^--method=/i.test(t)) {
      method = t.slice("--method=".length);
      continue;
    }
    if (t === "-f" || t === "-F" || t === "--field" || t === "--raw-field" || t === "--input") {
      fieldFlag = true;
      i += 1;
      continue;
    }
    if (!endpoint && !t.startsWith("-")) {
      endpoint = t;
      continue;
    }
  }
  return { method: method.toUpperCase(), endpoint, fieldFlag };
}

function normalizeGhEndpoint(raw) {
  let ep = raw.replace(/^https:\/\/api\.github\.com/i, "").replace(/^\//, "");
  const q = ep.indexOf("?");
  if (q >= 0) ep = ep.slice(0, q);
  return ep;
}

function isGhApiGraphql(segment) {
  const toks = shellSplit(segment);
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i += 1;
      continue;
    }
    if (PREFIXES.has(tok)) {
      i += 1;
      if (tok === "timeout" && i < toks.length) i += 1;
      continue;
    }
    break;
  }
  return toks[i] === "gh" && toks[i + 1] === "api" && toks[i + 2] === "graphql";
}

// GraphQL mutation names are matched whole-word against the entire command text,
// because a multi-line query is split into several segments.
function graphqlMutationVerdict(command) {
  const has = (name) => new RegExp(`\\b${name}\\b`).test(command);
  if (has("mergePullRequest")) {
    return verdict("deny", "The `mergePullRequest` GraphQL mutation bypasses the `/agento ship` audit gate; run `/agento ship <slug>` from the primary window.");
  }
  for (const name of ["updateRepositoryRuleset", "deleteRepositoryRuleset"]) {
    if (has(name)) {
      return verdict("deny", `The \`${name}\` GraphQL mutation removes the enforcement layer the guard relies on; edit rulesets in the GitHub UI yourself.`);
    }
  }
  for (const name of ["createBranchProtectionRule", "updateBranchProtectionRule", "deleteBranchProtectionRule"]) {
    if (has(name)) {
      return verdict("deny", `The \`${name}\` GraphQL mutation removes the enforcement layer the guard relies on; edit branch protection in the GitHub UI yourself.`);
    }
  }
  if (has("createRepositoryRuleset")) {
    return verdict("ask", "Creating a ruleset adds protection; approve this ruleset creation?");
  }
  return null;
}

export function ghApiVerdict(segments, command) {
  // GraphQL: any `gh api graphql` segment scans the whole command for mutations.
  if (segments.some(isGhApiGraphql)) {
    return graphqlMutationVerdict(command);
  }
  for (const segment of segments) {
    const toks = shellSplit(segment);
    let i = 0;
    while (i < toks.length) {
      const tok = toks[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        i += 1;
        continue;
      }
      if (PREFIXES.has(tok)) {
        i += 1;
        if (tok === "timeout" && i < toks.length) i += 1;
        continue;
      }
      break;
    }
    if (toks[i] !== "gh" || toks[i + 1] !== "api") continue;
    const { method, endpoint, fieldFlag } = ghApiMethodAndEndpoint(toks, i + 2);
    if (!endpoint) continue;
    const ep = normalizeGhEndpoint(endpoint);
    const effectiveMethod = method || (fieldFlag ? "POST" : "GET");
    const write = effectiveMethod === "POST" || effectiveMethod === "PUT" || effectiveMethod === "PATCH" || effectiveMethod === "DELETE";
    if (!write) continue;
    if (/^(repos\/[^/]+\/[^/]+|orgs\/[^/]+)\/rulesets$/.test(ep)) {
      if (effectiveMethod === "POST") return verdict("ask", "Creating a ruleset adds protection; approve this ruleset creation?");
      continue;
    }
    if (/^(repos\/[^/]+\/[^/]+|orgs\/[^/]+)\/rulesets\//.test(ep)) {
      return verdict("deny", "Changing or deleting a ruleset removes the enforcement layer the guard relies on; edit rulesets in the GitHub UI yourself.");
    }
    if (/^repos\/[^/]+\/[^/]+\/branches\/.+\/protection(?:\/|$)/.test(ep)) {
      return verdict("deny", "Changing or deleting branch protection removes the enforcement layer the guard relies on; edit branch protection in the GitHub UI yourself.");
    }
    if (/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(ep)) {
      return verdict("deny", "Merging through the API bypasses the `/agento ship` audit gate; run `/agento ship <slug>` from the primary window.");
    }
  }
  return null;
}

export function decide(payload, { cwd = process.cwd(), findOccupants = defaultFindOccupants } = {}) {
  const tool = String(payload.tool_name || payload.toolName || "").toLowerCase();
  const toolInput = readToolInput(payload);
  const first = (...keys) => {
    for (const key of keys) {
      const value = toolInput[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  const command = first("command", "commandLine", "text");
  const filePath = first("filePath", "file_path", "path", "uri");
  const hookCwd = payload.cwd || payload.workingDirectory || cwd;
  const cwdUsable = typeof hookCwd === "string" && hookCwd !== "";

  const target = cwdUsable ? worktreeRemoveTarget(command, hookCwd) : "";
  if (target) {
    const { details } = findOccupants(target);
    if (details.length) {
      return verdict(
        "ask",
        `Active worktree occupants detected - ${details.join(", ")}. Close their terminals or VS Code window before removal. Proceed anyway?`,
      );
    }
  }

  // Hook self-protection: edits need per-change approval; shell writes are denied.
  if (filePath && PROTECTED.test(filePath) && isWriteTool(tool)) {
    return verdict("ask", "Modifying a protected hook file; approve this specific change?");
  }

  const segments = command.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  const hookFile = hookFileVerdict(segments);
  if (hookFile) return hookFile;

  for (const segment of segments) {
    if (WATCHER.test(segment)) {
      return verdict("deny", "Open-ended watchers idle the session; use scripts/wait-for-checks.sh pr <n> or run <id> (bounded, exit 2 = rerun).");
    }
  }

  // GitHub merges that bypass the ruleset or rewrite history.
  for (const segment of segments) {
    if (/\bgh\s+pr\s+merge\b/.test(segment)) {
      if (/\s--admin\b/.test(segment)) {
        return verdict("deny", "Merging with --admin bypasses the repository ruleset; wait for required checks instead.");
      }
      if (/\s(--squash|--rebase)\b/.test(segment)) {
        return verdict("ask", "Repository policy merges with a normal merge commit; squash/rebase rewrites the branch history. Proceed anyway?");
      }
    }
  }

  // `gh api` writes against rulesets, branch protection, and the pull-request merge
  // endpoint bypass the enforcement layer and the ship gate.
  const ghApi = ghApiVerdict(segments, command);
  if (ghApi) return ghApi;

  // Hook-skipping exports carry no git word, so they must be denied before the early
  // "no git word → allow" return.
  for (const segment of segments) {
    if (hookSkipExport(segment)) {
      return verdict("deny", "HUSKY=0 / HUSKY_SKIP_HOOKS skip the project's hooks, like `--no-verify`.");
    }
  }

  if (!command || !/\bgit\b/.test(command)) return verdict("allow");

  // Git policy: no force-push, no hook bypass, no history rewriting, nothing on main.
  // Honour an explicit `git -C <path>` or a leading `cd <path> &&`; hooks do not
  // necessarily run inside the target repo.
  const dirMatch = command.match(/\bgit\s+-C\s+(\S+)/) ?? command.match(/^\s*cd\s+(\S+)\s*&&/);
  const workdir = dirMatch ? expandUser(stripQuotes(dirMatch[1])) : cwdUsable ? hookCwd : ".";
  const git = (...args) => runGit(workdir, ...args);

  const targetRoot = git("rev-parse", "--show-toplevel") || workdir;
  let config = loadHookConfig(targetRoot);

  // Companion mode: the repository the hook runs in (hookCwd) is the product checkout;
  // when its config names a companion and the command targets that companion (the clone
  // or any of its worktrees), the product's branches.* govern it — a companion never
  // carries its own agento.json.
  const commonDir = (dir) => {
    const out = runGit(dir, "rev-parse", "--git-common-dir");
    return out ? realpath(path.resolve(dir, out)) : "";
  };
  const productRoot = cwdUsable ? runGit(hookCwd, "rev-parse", "--show-toplevel") : "";
  let companionExternal = false;
  let companionPath = null;
  let targetIsCompanion = false;
  if (productRoot) {
    const resolved = resolveArtifacts(productRoot);
    companionExternal = resolved.external;
    companionPath = resolved.companionPath;
    if (companionExternal) {
      const targetCommon = commonDir(targetRoot);
      const sameClone = targetCommon && targetCommon === commonDir(companionPath);
      if (sameClone || realpath(targetRoot) === realpath(companionPath)) {
        targetIsCompanion = true;
        if (realpath(productRoot) !== realpath(targetRoot)) config = loadHookConfig(productRoot);
      }
      // A managed product worktree pairs with `<companion>-worktrees/<same basename>`;
      // the nudge on a product commit inspects that half when it exists.
      const paired = path.join(resolved.companionWorktreesDir, path.basename(realpath(productRoot)));
      if (MANAGED_HALF.test(path.basename(paired)) && isDir(paired)) companionPath = paired;
    }
  }

  const defaultBranch = config.branches.default || "main";
  const featurePrefix = config.branches.feature || "feature/";
  const issuePrefix = config.branches.issue || "issue/";
  const re = (source) => new RegExp(source);

  const commitFiles = (segment) => {
    // Files a `git commit` segment would record: explicit pathspecs, else the index,
    // plus tracked modifications when -a/--all is present.
    const toks = shellSplit(segment);
    const at = toks.indexOf("commit");
    const after = at < 0 ? [] : toks.slice(at + 1);
    const pathspecs = [];
    let allTracked = false;
    let skip = false;
    for (const tok of after) {
      if (skip) {
        skip = false;
        continue;
      }
      const redirect = tok.match(REDIRECT);
      if (redirect) {
        skip = redirect[1] === ""; // a bare operator's target is the next token
        continue;
      }
      if (tok.startsWith("--")) {
        if (COMMIT_VALUE_OPTIONS.has(tok)) skip = true;
        allTracked = allTracked || tok === "--all";
        continue;
      }
      if (tok.startsWith("-") && tok.length > 1) {
        if ("mFcCt".includes(tok.at(-1))) skip = true; // -m <msg>, -am <msg>, -F <file>, -c/-C <commit>, -t <file>
        allTracked = allTracked || tok.slice(1).includes("a");
        continue;
      }
      pathspecs.push(tok);
    }
    if (pathspecs.length) return pathspecs;
    const files = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
    if (allTracked) files.push(...git("diff", "--name-only").split("\n").filter(Boolean));
    return files;
  };

  let branch = git("branch", "--show-current");

  for (const segment of segments) {
    if (!/\bgit\b/.test(segment)) continue;
    // Inline hooks-path overrides bypass hooks the same way --no-verify does.
    if (/(?:^|\s)-c\s+core\.hookspath=/i.test(segment) || /--config-env=core\.hookspath=/i.test(segment)) {
      return verdict("deny", "Overriding core.hooksPath bypasses hooks like `--no-verify`.");
    }
    if (gitConfigHooksPathWrite(segment)) {
      return verdict("ask", "Changing core.hooksPath changes which hooks run; is this a tool install such as husky?");
    }
    const isPush = re(GIT + String.raw`\s+push\b`).test(segment);
    const isCommit = re(GIT + String.raw`\s+commit\b`).test(segment);
    const push = isPush ? pushRefspecs(shellSplit(segment)) : null;
    const isHookSkipTarget = isPush || isCommit || re(GIT + String.raw`\s+merge\b`).test(segment);
    if (isHookSkipTarget && hookSkipAssignments(segment)) {
      return verdict("deny", "HUSKY=0 / HUSKY_SKIP_HOOKS skip the project's hooks, like `--no-verify`.");
    }

    if (isPush) {
      if (/\s--mirror\b/.test(segment)) {
        return verdict("deny", `\`git push --mirror\` force-updates and deletes remote refs, including ${defaultBranch}; push the work branch by name.`);
      }
      if (/\s(--force(?:-with-lease|-if-includes)?(?:=\S*)?|-f)\b/.test(segment) || /\spush\b.*\s\+\S/.test(segment)) {
        return verdict("deny", "Force-push is forbidden by repository policy.");
      }
      if (/\s--no-verify\b/.test(segment)) {
        return verdict("deny", "Bypassing pre-push hooks is forbidden by repository policy.");
      }
      if (push.refspecs.some((r) => r.src === "" && r.dst === defaultBranch)) {
        return verdict("deny", `Deleting ${defaultBranch} on the remote is forbidden.`);
      }
    }
    if (isCommit) {
      if (/\s(--no-verify|-n)\b/.test(segment)) {
        return verdict("deny", "Bypassing commit hooks is forbidden by repository policy.");
      }
      if (/\s--amend\b/.test(segment)) {
        return verdict("ask", "Amending rewrites the last commit, which is forbidden once pushed. Is this commit still local-only?");
      }
    }
    if (re(GIT + String.raw`\s+rebase\b`).test(segment)) {
      return verdict("ask", `Repository policy never rebases; merge origin/${defaultBranch} instead. Proceed anyway?`);
    }
    if (re(GIT + String.raw`\s+reset\b.*\s--hard\b`).test(segment)) {
      return verdict("ask", "`git reset --hard` discards working-tree changes that may be in-progress work. Proceed anyway?");
    }
    if (re(GIT + String.raw`\s+branch\b.*\s(-D|--delete\s+--force|--force\s+--delete)\b`).test(segment)) {
      return verdict("ask", "Force-deleting a branch discards unmerged commits. Proceed anyway?");
    }

    // Chain-aware branch tracking: a switch/checkout earlier in the same command line
    // is the effective branch for everything after it.
    const created = segment.match(re(GIT + String.raw`\s+(?:switch\s+(?:-c|--create)\s+|checkout\s+-b\s+)([\w./-]+)`));
    if (created) {
      branch = created[1];
    } else {
      const switched = segment.match(re(GIT + String.raw`\s+(?:switch|checkout)\s+((?!-)[\w./-]+)\s*$`));
      if (switched && !segment.includes(" -- ")) branch = switched[1];
    }

    const isMerge = re(GIT + String.raw`\s+(merge|cherry-pick|revert)\b`).test(segment)
      && !segment.includes("--ff-only") && !segment.includes("--abort");
    // A push is judged by its destinations: any of them the default branch, or — from the
    // default branch — an implicit (no refspec), HEAD, or all-branches push.
    const pushToDefault = isPush && push.refspecs.some((r) => r.src !== "" && r.dst === defaultBranch);
    const pushFromDefault = isPush && branch === defaultBranch
      && (push.all || (!push.refspecs.length && !push.tags) || push.refspecs.some((r) => r.dst === "HEAD"));
    if ((branch === defaultBranch && (isCommit || isMerge)) || pushToDefault || pushFromDefault) {
      return verdict("deny", `Direct commits/pushes to ${defaultBranch} are forbidden; use a work branch and a pull request.`);
    }

    if (isCommit && (branch.startsWith(featurePrefix) || branch.startsWith(issuePrefix))) {
      if (companionExternal && !targetIsCompanion) {
        // The roadmap can only live in the companion. The two-commit rule commits the
        // product first, so an edited-but-uncommitted roadmap.md in the companion's
        // working tree (staged, unstaged, or untracked) counts, as does one in HEAD.
        const recorded = [
          runGit(companionPath, "diff", "--cached", "--name-only"),
          runGit(companionPath, "diff", "--name-only"),
          runGit(companionPath, "ls-files", "--others", "--exclude-standard"),
          runGit(companionPath, "show", "--name-only", "--format=", "HEAD"),
        ].join("\n").split("\n");
        if (!recorded.some((f) => f && f.endsWith("roadmap.md"))) {
          const companionBranch = runGit(companionPath, "branch", "--show-current") || "detached";
          return verdict(
            "ask",
            `Committing delivery work while the companion ${companionPath} (branch ${companionBranch}) ` +
              "has no pending or last-committed roadmap.md change; progress may be lost on resume. Proceed?",
          );
        }
      } else {
        const files = commitFiles(segment);
        if (files.length && !files.some((f) => f.endsWith("roadmap.md"))) {
          return verdict("ask", "Committing delivery work without a roadmap.md update; progress may be lost on resume. Proceed?");
        }
      }
    }
  }

  return verdict("allow");
}

export function main() {
  const debug = debugEnabled();
  let payload = {};
  try {
    payload = readPayload();
  } catch {
    payload = {};
  }
  if (debug) {
    debugWrite({
      event: "entry",
      ts: new Date().toISOString(),
      pid: process.pid,
      cwd: process.cwd(),
      claudePluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null,
      pluginRoot: process.env.PLUGIN_ROOT ?? null,
      copilotPluginRoot: process.env.COPILOT_PLUGIN_ROOT ?? null,
      copilotCli: process.env.COPILOT_CLI ?? null,
      payload,
    });
  }
  try {
    const { decision, reason } = decide(payload);
    if (debug) debugWrite({ event: "decision", ts: new Date().toISOString(), decision, reason });
    if (decision === "allow") return;
    // Dual-shape output: the top-level slots are what the Copilot harness reads,
    // `hookSpecificOutput` is what the Local harness reads. Each harness ignores
    // the other's keys, so one object serves both.
    emit({
      permissionDecision: decision,
      permissionDecisionReason: reason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    });
  } catch (error) {
    // A crashing guard must not block the tool call: report it and allow.
    if (debug) debugWrite({ event: "error", ts: new Date().toISOString(), error: `${error?.stack ?? error}` });
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
}

if (process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url))) main();
