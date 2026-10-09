// Shared helpers for the Node hooks (delivery-guard.mjs, session-context.mjs). The
// config loader and the companion resolver build on the CLI's agento-config.mjs so the
// hooks and the CLI read `.github/agento.json` the same way.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, parseConfigText, resolveArtifactsRoot } from "../agento-config.mjs";

const GIT_TIMEOUT_MS = 5000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The hook payload from stdin; `{}` for empty, malformed, or non-object input.
export function readPayload(fd = 0) {
  let text = "";
  try {
    text = fs.readFileSync(fd, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text || "{}");
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// `git -C <dir> <args>` stdout, trimmed; "" on spawn failure or timeout. A nonzero
// exit still yields whatever was printed on stdout.
export function runGit(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) return "";
  return (result.stdout ?? "").trim();
}

// `.github/agento.json`, else `agento.json`, merged over the defaults. An unreadable or
// invalid candidate falls through to the next one; a valid non-object keeps the defaults.
export function loadHookConfig(root) {
  for (const rel of [".github/agento.json", "agento.json"]) {
    const file = path.join(root, rel);
    let text;
    let parsed;
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, "utf8");
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) return defaultConfig(root);
    const config = parseConfigText(text, root);
    const defaults = defaultConfig(root);
    for (const section of ["artifacts", "branches"]) {
      if (!isPlainObject(config[section])) config[section] = defaults[section];
    }
    if (!isPlainObject(config.artifacts.repo)) config.artifacts.repo = defaults.artifacts.repo;
    return config;
  }
  return defaultConfig(root);
}

const hasRepo = (repo) => repo.name != null || repo.dir != null;

// The checkout decides, the primary anchors: `artifacts.repo` unset in the checkout's
// own config keeps the in-repo layout with no git call; else the companion resolves
// against the primary checkout (first `git worktree list` entry), using the primary's
// `repo` when it sets one. Session halves live under `<companionPath>-worktrees/`.
export function resolveArtifacts(productRoot) {
  const config = loadHookConfig(productRoot);
  if (!hasRepo(config.artifacts.repo)) {
    return { external: false, companionPath: null, name: null, companionWorktreesDir: null, primaryRoot: productRoot };
  }
  let primaryRoot = productRoot;
  for (const line of runGit(productRoot, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) {
      primaryRoot = line.slice("worktree ".length).trim();
      break;
    }
  }
  let anchor = config;
  if (realpath(primaryRoot) !== realpath(productRoot)) {
    const primaryConfig = loadHookConfig(primaryRoot);
    if (hasRepo(primaryConfig.artifacts.repo)) anchor = primaryConfig;
  }
  const resolved = resolveArtifactsRoot({ config: anchor, rootDir: productRoot, primaryRoot });
  return {
    external: true,
    companionPath: resolved.dir,
    name: resolved.name,
    companionWorktreesDir: resolved.worktreesDir,
    primaryRoot,
  };
}

// Like Python's os.path.realpath: resolves what exists, keeps the rest lexically.
export function realpath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realpath(parent), path.basename(abs));
  }
}

const SHELL_WHITESPACE = " \t\r\n";

// POSIX shlex.split: single quotes are literal, double quotes honour `\"` and `\\`,
// a bare backslash escapes the next character, adjacent quoted parts join one word.
// Unbalanced quotes or a trailing backslash fall back to a whitespace split.
export function shellSplit(text) {
  const tokens = [];
  let token = "";
  let inToken = false;
  let i = 0;
  try {
    while (i < text.length) {
      const c = text[i];
      if (SHELL_WHITESPACE.includes(c)) {
        if (inToken) tokens.push(token);
        token = "";
        inToken = false;
        i += 1;
        continue;
      }
      inToken = true;
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) throw new Error("No closing quotation");
        token += text.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i += 1;
        for (;;) {
          if (i >= text.length) throw new Error("No closing quotation");
          const d = text[i];
          if (d === '"') {
            i += 1;
            break;
          }
          if (d === "\\") {
            if (i + 1 >= text.length) throw new Error("No escaped character");
            const next = text[i + 1];
            token += next === '"' || next === "\\" ? next : `\\${next}`;
            i += 2;
            continue;
          }
          token += d;
          i += 1;
        }
      } else if (c === "\\") {
        if (i + 1 >= text.length) throw new Error("No escaped character");
        token += text[i + 1];
        i += 2;
      } else {
        token += c;
        i += 1;
      }
    }
  } catch {
    return text.split(/\s+/).filter(Boolean);
  }
  if (inToken) tokens.push(token);
  return tokens;
}

// JSON in Python's json.dumps spelling (`", "`, `": "`, non-ASCII as \uXXXX) so the
// hook output stays byte-identical to the pre-port release.
export function toJson(value) {
  if (Array.isArray(value)) return `[${value.map(toJson).join(", ")}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value).map(([k, v]) => `${toJson(k)}: ${toJson(v)}`).join(", ")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  return JSON.stringify(value);
}

export function emit(obj, out = process.stdout) {
  out.write(`${toJson(obj)}\n`);
}
