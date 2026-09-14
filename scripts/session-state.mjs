// Pure helpers behind `agento.mjs session`: where am I (role/worktree), what is
// active (delivery/lifecycle), and what may I run next (allowed/elsewhere). No git
// or filesystem walking happens here beyond realpath, so every rule is unit-testable.

import fs from "node:fs";
import path from "node:path";

const MANAGED_DIR = /^(plan|feature|issue|freehand)-(.+)$/;

// `git worktree list --porcelain`: blank-line separated blocks of
// `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>` | `detached`.
export function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of (porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, detached: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "") {
      current = null;
    }
  }
  return entries;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(dir, target) {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function deriveRole({ cwd, worktrees, worktreesDir, config }) {
  const real = realpath(cwd);
  const entries = (worktrees ?? []).map((w) => ({ ...w, realPath: realpath(w.path) }));
  const primary = entries[0] ?? null;
  // Deepest containing entry wins, so a worktree nested under another resolves to itself.
  const owner = entries.filter((w) => isWithin(w.realPath, real)).sort((a, b) => b.realPath.length - a.realPath.length)[0] ?? null;

  const worktree = {
    path: owner ? owner.path : cwd,
    branch: owner?.branch ?? null,
    detached: owner ? owner.detached : false,
    isPrimary: false,
    isManaged: false,
    dirPrefix: null,
    id: null,
  };

  if (owner && primary && owner.realPath === primary.realPath) {
    return { role: "primary", worktree: { ...worktree, isPrimary: true } };
  }

  const managedRoot = realpath(worktreesDir);
  if (isWithin(managedRoot, real) && real !== managedRoot) {
    const top = path.relative(managedRoot, real).split(path.sep)[0];
    const match = top.match(MANAGED_DIR);
    if (match) {
      worktree.isManaged = true;
      worktree.dirPrefix = match[1];
      worktree.id = match[2];
      if (!owner) worktree.path = path.join(worktreesDir, top);
      if (match[1] === "freehand") return { role: "freehand", worktree };
      const { branch } = worktree;
      if (branch && (branch.startsWith(config.branches.feature) || branch.startsWith(config.branches.issue))) {
        return { role: "build", worktree };
      }
      return { role: "plan", worktree };
    }
  }

  return { role: "unmanaged", worktree };
}
