// The session-path and workspace-file helpers shared by paths/workspace,
// start-session, close-session, and ship, moved unchanged from the legacy
// `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { sessionWorkspaceDocument } from "../session-state.mjs";
import {
  artifacts,
  config,
  git,
  primaryWorktreesDir,
  productWorktrees,
  samePath,
} from "./context.mjs";
import { checkoutLayout, layoutFor } from "./layout.mjs";
import { workspaceDocumentCurrent } from "./session.mjs";

function managedWorktreePath(worktrees, kind, id, worktreesBaseDir) {
  const name = `${kind}-${id}`;
  const direct = worktrees.find((w) => path.basename(w.path) === name && samePath(path.dirname(w.path), worktreesBaseDir));
  if (direct) return direct.path;
  const fallback = worktrees.find((w) => path.basename(w.path) === name);
  return fallback?.path ?? path.join(worktreesBaseDir, name);
}
function resolveSessionPaths(kind, id, layoutOverride = null) {
  const prefixes = { feature: config.branches.feature, issue: config.branches.issue, freehand: config.branches.freehand };
  const artifactRel = kind === "feature" ? config.artifacts.features : kind === "issue" ? config.artifacts.issues : null;
  const branch = kind === "plan" ? null : `${prefixes[kind]}${id}`;
  // Deliveries are branch-aware: an in-repo checkout whose delivery branch flips to
  // a companion reports that companion's roots and pair (plan/freehand unchanged).
  const branchLayout = !layoutOverride && artifactRel !== null && !artifacts.external ? layoutFor(branch) : null;
  const layout = layoutOverride ?? (branchLayout && !branchLayout.absent ? branchLayout : checkoutLayout());
  const productList = productWorktrees();
  const worktree = managedWorktreePath(productList, kind, id, primaryWorktreesDir(productList));
  const companion = layout.artifacts.external
    ? {
        worktreesDir: layout.companionWorktreesDir,
        worktree: managedWorktreePath(layout.companionWorktrees, kind, id, layout.companionWorktreesDir),
        branch,
      }
    : null;
  const workspace = layout.artifacts.external ? path.join(path.dirname(worktree), `${kind}-${id}.code-workspace`) : null;
  return { kind, id, branch, artifactRel, layout, worktree, companion, workspace, productWorktrees: productList };
}
const originOf = (dir) => git(dir, "remote", "get-url", "origin") || null;
// The pair's `.code-workspace` document for a resolved session (companion mode);
// with `write`, written when missing or stale.
function writeSessionWorkspace(resolved, { write = true } = {}) {
  const autoApprove = resolved.layout.config.worktrees?.autoApprove !== false;
  const document = sessionWorkspaceDocument({ product: resolved.worktree, companion: resolved.companion.worktree, autoApprove });
  let exists = fs.existsSync(resolved.workspace);
  let current = exists ? workspaceDocumentCurrent(resolved.workspace, document) : false;
  let written = false;
  if (write && !current) {
    fs.mkdirSync(path.dirname(resolved.workspace), { recursive: true });
    fs.writeFileSync(resolved.workspace, JSON.stringify(document, null, 2) + "\n");
    exists = true;
    current = true;
    written = true;
  }
  return { exists, current, autoApprove, document, written };
}

const registeredAt = (list, p) => list.find((w) => samePath(w.path, p)) ?? null;

export {
  managedWorktreePath,
  resolveSessionPaths,
  originOf,
  writeSessionWorkspace,
  registeredAt,
};
