// The `paths`, `workspace`, `windows`, `artifacts`, and `handoff`
// subcommands and their helpers, moved unchanged from the legacy switch in
// `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isCanonicalAgentoCommand, pendingDispatchDir, removePendingDispatch, writePendingDispatch } from "../pending-dispatch.mjs";
import { halfState } from "../session-state.mjs";
import { openWindows, readStorage, windowFor } from "../vscode-windows.mjs";
import { defaultCodeStatus } from "../worktree-occupants.mjs";
import {
  artifactsRoot,
  config,
  emit,
  options,
  primaryWorktreesDir,
  productWorktrees,
  rest,
  root,
  samePath,
  source,
  usage,
} from "../lib/context.mjs";
import { deliveryBranch, roadmapOnBranch } from "../lib/layout.mjs";
import { originOf, resolveSessionPaths, writeSessionWorkspace } from "../lib/paths.mjs";
import { allRoadmaps, recordBases } from "../lib/records.mjs";
import { requireSlug } from "../lib/resolve.mjs";
import { describeWorkspace, managedHalves, sessionContext } from "../lib/session.mjs";

// --- artifacts -------------------------------------------------------------

const ARTIFACT_FILES = ["plan", "roadmap", "review"];

// One delivery's plan.md, roadmap.md, and review.md, read from the copy `status`
// shows: the delivery's own managed half (its working tree is the truth) or the
// artifacts checkout; else origin/<branch> or the local branch via git. Never fetches.
function artifactsCommand(type, slug) {
  const record = allRoadmaps(type, managedHalves(productWorktrees())).find((r) => r.slug === slug);
  const out = { status: "ok", type, slug, dir: null, source: null, base: null, ref: null, files: {} };
  if (record) {
    const base = recordBases.get(record) ?? artifactsRoot;
    Object.assign(out, { dir: record.dir, source: samePath(base, artifactsRoot) ? "checkout" : "worktree", base });
    for (const name of ARTIFACT_FILES) {
      const file = path.join(base, record.dir, `${name}.md`);
      out.files[name] = fs.existsSync(file) ? { exists: true, path: file, content: fs.readFileSync(file, "utf8") } : { exists: false };
    }
    emit(out);
  }
  const onBranch = roadmapOnBranch(type, slug);
  if (!onBranch) {
    emit({ ...out, status: "missing", message: `No roadmap for ${type}/${slug} in the artifacts checkout, a managed worktree, origin/${deliveryBranch(type, slug)}, or the local branch` }, 3);
  }
  const ref = onBranch.source === "origin" ? `origin/${onBranch.record.branch}` : onBranch.record.branch;
  Object.assign(out, { dir: onBranch.record.dir, source: onBranch.source, ref, base: onBranch.layout.artifactsRoot ?? artifactsRoot });
  for (const name of ARTIFACT_FILES) {
    const content = onBranch.layout.agit("show", `${ref}:${onBranch.record.dir}/${name}.md`);
    out.files[name] = content ? { exists: true, path: null, content: `${content}\n` } : { exists: false };
  }
  emit(out);
}

// --- windows / handoff -----------------------------------------------------

// The registered product checkouts a window target may name, keyed by resolved
// path, with the target to open when no window holds one (its session workspace
// file in companion mode, else the folder).
function windowCheckouts() {
  const { classified, sessionWorktreesDir } = sessionContext();
  const checkouts = new Map();
  for (const entry of classified) {
    if ((entry.repo ?? "product") !== "product" || !entry.path) continue;
    const workspace = describeWorkspace(entry, sessionWorktreesDir);
    checkouts.set(path.resolve(entry.path), { entry, fallback: workspace?.exists ? workspace.path : entry.path });
  }
  return checkouts;
}

function windowsCommand(paths) {
  if (!paths.length) usage("windows takes one or more checkout paths");
  const checkouts = windowCheckouts();
  const open = openWindows({ storageText: readStorage(), statusText: defaultCodeStatus() });
  const windows = paths.map((p) => {
    const known = checkouts.get(path.resolve(p));
    if (!known) return { checkout: p, known: false, open: false, target: null, kind: null };
    return { checkout: known.entry.path, known: true, role: known.entry.role ?? null, ...windowFor(known.entry.path, open, known.fallback) };
  });
  emit({ status: "ok", windows });
}

function handoffCommand(checkout, command) {
  if (!checkout || !command) usage('handoff takes <checkout> "<command>"');
  if (!isCanonicalAgentoCommand(command)) usage(`handoff command must be a canonical /agento command, got ${JSON.stringify(command)}`);
  const known = windowCheckouts().get(path.resolve(checkout));
  if (!known) {
    emit({ status: "rejected", reason: "unknown-checkout", message: `${checkout} is not a registered checkout of this repository`, checkout, command }, 3);
  }
  const window = windowFor(known.entry.path, openWindows({ storageText: readStorage(), statusText: defaultCodeStatus() }), known.fallback);
  const dir = pendingDispatchDir();
  const pendingFile = writePendingDispatch(dir, { target: window.target, command });
  const out = {
    status: "ok",
    checkout: known.entry.path,
    role: known.entry.role ?? null,
    target: window.target,
    kind: window.kind,
    wasOpen: window.open,
    command,
    pendingFile,
    opened: false,
    openCommand: `code ${window.target}`,
  };
  if (!options.noOpen) {
    try {
      execFileSync("code", [window.target], { cwd: root, stdio: "ignore", timeout: 15000 });
      out.opened = true;
    } catch (error) {
      removePendingDispatch(dir, window.target);
      emit({ ...out, status: "failed", pendingFile: null, reason: error?.code === "ENOENT" ? "code CLI not found on PATH" : `code failed: ${error?.message ?? error}` }, 3);
    }
  }
  emit(out);
}

export const commands = {
  paths() {
    const kind = rest[0];
    const id = rest[1];
    if (!["feature", "issue", "plan", "freehand"].includes(kind)) usage("paths kind must be feature, issue, plan, or freehand");
    requireSlug(id);
    const resolved = resolveSessionPaths(kind, id);
    const companionList = resolved.companion ? resolved.layout.companionWorktrees : [];
    const stateOf = (halfPath, own, expectedOrigin) => {
      const onDisk = fs.existsSync(halfPath);
      return halfState({ path: halfPath, own, worktrees: resolved.productWorktrees, companionWorktrees: companionList, origin: onDisk ? originOf(halfPath) : null, expectedOrigin, onDisk });
    };
    emit({
      status: "ok",
      worktreesDir: primaryWorktreesDir(resolved.productWorktrees),
      worktree: resolved.worktree,
      // Post-`git worktree add` check: on disk, registered in the right clone, right origin.
      worktreeState: stateOf(resolved.worktree, "product", originOf(root)),
      branch: resolved.branch,
      artifactsRoot: resolved.layout.artifactsRoot,
      artifactRoot: resolved.artifactRel === null ? null : path.join(resolved.layout.artifactsRoot, resolved.artifactRel),
      layout: resolved.layout.layout,
      defaultBranch: config.branches.default,
      postShipBranch: kind === "plan" || kind === "freehand" ? null : `${config.branches.postShip}${id}`,
      // Companion mode: the paired companion half (same <kind>-<id>, same branch) and the
      // two-folder workspace file the session opens; both null in the in-repo layout.
      companion: resolved.companion && { ...resolved.companion, state: stateOf(resolved.companion.worktree, "companion", originOf(resolved.layout.artifactsRoot)) },
      workspace: resolved.workspace,
    });
  },
  workspace() {
    const kind = rest[0];
    const id = rest[1];
    if (!["feature", "issue", "plan", "freehand"].includes(kind)) usage("workspace kind must be feature, issue, plan, or freehand");
    requireSlug(id);
    const resolved = resolveSessionPaths(kind, id);
    if (!resolved.layout.artifacts.external || !resolved.workspace || !resolved.companion) {
      emit({ status: "not-applicable", message: "workspace is only available in companion mode (artifacts.repo set)", root, configSource: source });
    }
    const folders = [
      { path: resolved.worktree, exists: fs.existsSync(resolved.worktree) },
      { path: resolved.companion.worktree, exists: fs.existsSync(resolved.companion.worktree) },
    ];
    const { exists, current, autoApprove, document, written } = writeSessionWorkspace(resolved, { write: Boolean(options.write) });
    emit({
      status: "ok",
      path: resolved.workspace,
      exists,
      current,
      autoApprove,
      folders,
      settings: document.settings,
      written,
      root,
      configSource: source,
    });
  },
  windows() {
    windowsCommand(rest);
  },
  artifacts() {
    const [typeArg, slugArg, ...extra] = rest;
    if (!["feature", "issue"].includes(typeArg) || !slugArg || extra.length) usage("artifacts takes <feature|issue> <slug>");
    artifactsCommand(typeArg, requireSlug(slugArg));
  },
  handoff() {
    if (rest.length !== 2) usage(`handoff takes <checkout> "<command>" (quote the command), got ${rest.length} arguments`);
    handoffCommand(rest[0], rest[1]);
  },
};
