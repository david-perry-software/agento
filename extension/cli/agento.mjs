#!/usr/bin/env node
// Agento CLI: the deterministic half of the delivery workflow. Prompts call this
// instead of re-deriving slug resolution, status listings, and config lookups in
// prose. Always prints one JSON document; exit 0 when the result is usable, 1 on a
// usage error, 3 when the resolution itself failed (conflict, mismatch, missing).
//
//   node scripts/agento.mjs config
//   node scripts/agento.mjs resolve <feature|issue> <slug>
//   node scripts/agento.mjs find <slug>                 (type-agnostic)
//   node scripts/agento.mjs status [feature|issue] [slug] [--pr]   (--pr adds pr + companionPr per non-complete item)
//   node scripts/agento.mjs close-decision <feature|issue> <slug>
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug> [--pr]   (+ ownerTree { tracked, untracked, ahead } and companionTree { tracked, untracked }, null when absent; --pr adds pr + companionPr + warnings; companion PR gaps join companionGaps)
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>   (+ worktreeState { onDisk, registeredIn, origin, expectedOrigin, ok }; + companion half and .code-workspace in companion mode, with companion.state likewise)
//   node scripts/agento.mjs workspace <feature|issue|plan|freehand> <slug|session-id> [--write]   (pair workspace file status; write the canonical document with --write)
//   node scripts/agento.mjs start-session [<feature|issue>/<slug> | <session-id>] [--resume] [--no-open]   (window check, doctor, fetch, worktree pair, post-add check, workspace file, code --new-window)
//   node scripts/agento.mjs close-session <feature|issue>/<slug> | changes/<slug> | <session-id> [--dry-run] [--ignore-occupants]   (window check, fetch --prune, close decision, clean/pushed checks, occupant gate, remove pair + workspace file, delete merged local branches)
//   node scripts/agento.mjs ship <feature|issue> <slug> [--confirm <token>] [--wait N]   (audit → --confirm → ready, checks, merge, companion merge, sync, release wait, teardown, epilogue; resumes from git + GitHub state; exit 0 ok, 2 pending, 3 rejected/blocked/failed)
//   node scripts/agento.mjs sync <feature|issue> <slug>   (build window: fetch both halves, merge origin/<branch> then origin/<default> where not ancestors — never rebase; a conflict aborts with its files, nothing pushed; push halves left ahead, product first; merged: true → re-verify; exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs step-commit <feature|issue> <slug> [--step N.M] --message-file <file|->   (build window: product commit, then the companion tick scoped to the slug dir; roadmap rule; integrate both defaults — exit 2 reverify when one merged; push product then companion; open missing draft PRs; end clean with ahead 0)
//   node scripts/agento.mjs plan-publish <feature|issue> <slug>   (planning window on the roadmap branch: commit the slug dir (docs(delivery|<type>): plan, or revise plan); companion mode opens the product branch with one empty commit; integrate, push product then companion, open the draft PRs, cross-link, artifact-pr:; never readies or merges; exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs review-publish <feature|issue> <slug> [--body-file <file|->]   (build window: review.md with one Verdict: line; commit docs(<type>): review <slug> — <verdict> in the artifact half; merge origin/<branch> everywhere and origin/<default> in the companion half only; push; upsert one marked verdict comment on the code PR (REST list + PATCH/POST); exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs publish-pr [--dir <path>] [--branch <name>] [--title <text>] [--body-file <file|->] [--merge] [--wait N]   (a changes branch of the product or companion checkout at --dir: refuses the default branch, a detached HEAD, and the feature/issue/post-ship prefixes; push → non-draft PR → (--merge) bounded check wait, merge origin/<default> when BEHIND, gh pr merge --merge, delete the remote branch, sync the default (a linked worktree stays on its branch); resumes from git + GitHub state; exit 0 ok, 2 pending, 3 rejected/blocked/failed)
//   node scripts/agento.mjs initiative [<slug>]
//   node scripts/agento.mjs metrics [<slug>]           (phase durations, review rounds, pauses, merge date, post-ship latency from git history; + aggregate medians)
//   node scripts/agento.mjs session [--pr]             (role, worktree, worktrees, companion, workspace, delivery, lifecycle, allowed; hosted flag; --pr adds pr + companionPr)
//   node scripts/agento.mjs windows <checkout>...      (per registered checkout: the VS Code window holding it — storage.json + code --status — open flag, and the workspace file or folder to open)
//   node scripts/agento.mjs artifacts <feature|issue> <slug>   (plan.md, roadmap.md, review.md contents from the copy status shows — the delivery's managed half or the artifacts checkout — else origin/<branch> or the local branch; exit 3 missing)
//   node scripts/agento.mjs handoff <checkout> "<command>" [--no-open]   (queue one /agento command in <agento-config>/pending-dispatch for that checkout's window, then code <target> to focus or open it; the extension there runs it)
//   node scripts/agento.mjs next [<slug>]              (the one legal transition: command, args, window, target { path, workspace }, dispatch paths)
//   node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)
//   node scripts/agento.mjs policy <N> [<N>…] | --list   (print the named ## N. sections of delivery-policy.instructions.md as raw Markdown after one header line, ascending and deduplicated; --list prints JSON { sections: [{ n, title, bytes }] }; unknown/missing sections and no args exit 1)
//   node scripts/agento.mjs preflight <command> [<type> <slug> | <slug>]   (session, window verdict, doctor --for, resolve, config, opId, receipt, preflightLines in one call; exit 0 accepted, 3 rejected)
//   node scripts/agento.mjs dashboard [--pr] [--plugin-root <dir>]   (session, doctor, deliveries (= status), initiatives { list, details }, metrics and timings in one document; a failing section is { status: "error", message })
//   node scripts/agento.mjs migrate <companion-checkout> [--apply]   (move in-repo artifact roots into the companion; dry run without --apply)
//   node scripts/agento.mjs models <verb> [--plugin-root <dir>]   (model profiles in ~/.config/agento/model-profiles.json; read: list | pins [--role primary|secondary] | resolve <command> [--role primary|secondary] | show <name>; write: create <name> [--from <src>] [--description <text>] | update <name> [--dry-run] | rename <old> <new> | delete <name> [--force] | alias set <picker> <id> | alias remove <picker> | apply <name> | adopt | clear | use <name|none> --role primary|secondary | init; write verbs accept --expect <sha256> and report profilesFile.hash)
//   node scripts/agento.mjs harness <status|install|uninstall> [--plugin-root <dir>] [--force]   (create/report/remove the ~/.copilot/skills/agento link to the router skill; --force replaces a foreign or dangling link on install only)
//   node scripts/agento.mjs release <merge-sha> [--wait N] [--interval N]   (deploy-wait verdict for checks.releaseWorkflow; exit 0 done, 2 pending/dispatch-required, 3 gh/auth, 4 failed/no-run)
//
// Options: --root <dir> (default: the git toplevel of the cwd; a companion clone or
// companion half re-anchors on its product checkout).

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyMergeRefusal, missingRequired, requiredContexts } from "./merge-state.mjs";
import {
  closeBuildSessionDecision,
  completeRoadmap,
  evaluateShipPreflight,
  reopenRoadmap,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";
import { isCanonicalAgentoCommand, pendingDispatchDir, removePendingDispatch, writePendingDispatch } from "./pending-dispatch.mjs";
import { openWindows, readStorage, windowFor } from "./vscode-windows.mjs";
import { classifyFetchFailure, classifyWorktrees, deriveAllowed, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, halfState, nextSessionId, parseWorktreeList, resolveNextTarget, sessionWorkspaceDocument, splitPorcelain, WINDOW_ROLES, windowVerdict } from "./session-state.mjs";
import { defaultCodeStatus, findOccupants } from "./worktree-occupants.mjs";

import {
  usage,
  emit,
  emitRaw,
  withExit,
  git,
  samePath,
  MANAGED_HALF,
  anchor,
  root,
  roleCwd,
  config,
  source,
  repoName,
  currentBranch,
  artifacts,
  artifactsRoot,
  artifactsGit,
  agit,
  companionWorktreesDir,
  companionWorktrees,
  productWorktreeText,
  productWorktrees,
  primaryWorktreesDir,
  CLI_DIR,
  PLUGIN_ROOT,
  options,
  command,
  rest,
  startDir,
} from "./lib/context.mjs";
import { ghRequiredContexts, once, releaseVerdict } from "./lib/release.mjs";
import { allRoadmaps, describeFromRef, header, recordBases } from "./lib/records.mjs";
import { checkoutLayout, decideWithLayout, deliveryBranch, layoutFor, resolveWithLayout, withLayout } from "./lib/layout.mjs";
import { configDocument, requireSlug, requireType, resolveDocument } from "./lib/resolve.mjs";
import { gitRun } from "./lib/git.mjs";
import { lookupCompanionPullRequest, lookupPullRequest } from "./lib/github.mjs";
import {
  canonicalizeJson,
  companionHalfOf,
  companionOfOwner,
  describeCompanion,
  describeWorkspace,
  managedHalves,
  sessionContext,
  sessionRecord,
  workspaceDocumentCurrent,
} from "./lib/session.mjs";
import { capabilityOf, checksFor, COMMAND_NEEDS, doctorDocument, runDoctor } from "./lib/doctor.mjs";
import { allBreakdowns, deriveInitiative, refFor } from "./lib/documents.mjs";

// Parses `<root>/.github/instructions/delivery-policy.instructions.md` into its
// `## N.` sections. Each entry carries the section number (the heading's digits),
// the heading title, the section's byte length, and its raw Markdown (heading line
// through the line before the next heading, or EOF for the last section).
function policySections(root) {
  const file = path.join(root, ".github", "instructions", "delivery-policy.instructions.md");
  const text = fs.readFileSync(file, "utf8");
  const heading = /^## (\d+)\. (.+)$/gm;
  const starts = [];
  let match;
  while ((match = heading.exec(text)) !== null) {
    starts.push({ n: match[1], title: match[2].trim(), offset: match.index });
  }
  return starts.map((section, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].offset : text.length;
    const raw = text.slice(section.offset, end);
    return { n: section.n, title: section.title, bytes: Buffer.byteLength(raw, "utf8"), raw };
  });
}



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


// close-decision / ship-preflight: the companion half owned alongside the product
// half, or null when no managed worktree owns the branch (or in-repo mode).

function companionGaps(companion) {
  if (!companion?.registered) return [];
  return [...(companion.dirty ? ["dirty"] : []), ...(companion.ahead > 0 ? ["unpushed"] : []), ...(companion.behind > 0 ? ["behind"] : [])];
}

function companionGapMessage(companion, gaps, type, slug) {
  const behindOnly = gaps.length === 1 && gaps[0] === "behind";
  const fix = behindOnly
    ? `run git -C ${companion.path} merge origin/${companion.branch} (a fast-forward) before closing ${type}/${slug}`
    : `commit and push it (or discard the changes) before closing ${type}/${slug}, or its artifact work is lost`;
  const state = gaps.map((g) => (g === "behind" ? "behind its upstream" : g)).join(" and ");
  return `The companion half at ${companion.path} is ${state}; ${fix}.`;
}

// ship-preflight: a checkout's dirt split into tracked and untracked (non-ignored)
// files, plus `ahead` counted like describeCompanion; null when the directory is missing.
function treeState(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let porcelain = "";
  try {
    // Not git(): its trim() would eat the leading space of a ` M` status.
    porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const upstream = git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const count = upstream ? git(dir, "rev-list", "--count", "@{upstream}..HEAD") : git(dir, "rev-list", "--count", "HEAD", "--not", "--remotes");
  return { ...splitPorcelain(porcelain), ahead: Number.parseInt(count, 10) || 0 };
}

function ownerTreeOf(owner) {
  if (!owner || owner.role === "primary") return null;
  return treeState(owner.path);
}

function companionTreeOf(companion) {
  if (!companion?.registered) return null;
  const tree = treeState(companion.path);
  return tree && { tracked: tree.tracked, untracked: tree.untracked };
}

// the primary: in companion mode every registered companion half that is a managed






// --- next ------------------------------------------------------------------


// review.md is fresh when its last commit is not older than the last commit that
// touched anything else on the branch; null when the branch has no review.md.
function reviewFreshness(branch, dir, g = agit) {
  const { ref, warning } = refFor(branch, g);
  const reviewTs = g("log", "-1", "--format=%ct", ref, "--", `${dir}/review.md`);
  if (!reviewTs) return { reviewFresh: null, ref, warning };
  const otherTs = g("log", "-1", "--format=%ct", ref, "--", ".", `:(exclude)${dir}/review.md`);
  return { reviewFresh: Number(reviewTs) >= Number(otherTs || 0), ref, warning };
}

// A roadmap that lives only on its delivery branch: origin/<branch> first (via the
// shared resolver, branch-aware), then the unpushed local branch. Never fetches.
// The record carries the layout it was read from.
function roadmapOnBranch(type, slug) {
  const { result: resolved, layout } = resolveWithLayout(type, slug);
  const tag = (record) => ({ ...record, layout: layout.layout, artifactsRoot: layout.artifactsRoot });
  if (resolved.status === "ok" && resolved.source === "remote") {
    const record = describeFromRef(`origin/${resolved.branch}`, resolved.path, type, layout.agit);
    if (record) return { record: tag(record), source: "origin", layout };
  }
  const branch = deliveryBranch(type, slug);
  if (!layout.agit("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) return null;
  const top = type === "feature" ? layout.config.artifacts.features : layout.config.artifacts.issues;
  const roadmap = layout.agit("ls-tree", "-r", "--name-only", branch)
    .split("\n")
    .find((p) => p.startsWith(`${top}/`) && p.endsWith(`/${slug}/roadmap.md`));
  if (!roadmap) return null;
  const record = describeFromRef(branch, roadmap, type, layout.agit);
  return record ? { record: tag(record), source: "local-branch", layout } : null;
}

// Where `/agento continue` finds the files to follow for the emitted command: the
// plugin command file and, for custom-agent prompts, the agent file whose `name:`
// matches the prompt's `agent:` frontmatter.
function dispatchFor(command) {
  if (!command) return null;
  const prompt = path.join(PLUGIN_ROOT, "skills", "agento", "commands", `${command}.md`);
  if (!fs.existsSync(prompt)) return { prompt, agent: null };
  const agentName = fs.readFileSync(prompt, "utf8").match(/^agent:\s*"([^"\n]+)"/m)?.[1] ?? null;
  if (!agentName || agentName === "agent") return { prompt, agent: null };
  const agentsDir = path.join(PLUGIN_ROOT, ".github", "agents");
  const agent = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".agent.md"))
    .map((f) => path.join(agentsDir, f))
    .find((f) => fs.readFileSync(f, "utf8").match(/^name:\s*"([^"\n]+)"/m)?.[1] === agentName);
  return { prompt, agent: agent ?? null };
}

// --- start-session ---------------------------------------------------------

const SESSION_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

function startSessionArgs() {
  if (rest.length > 1) usage(`start-session takes at most one argument (<feature|issue>/<slug> or a session id), got ${JSON.stringify(rest.join(" "))}`);
  const arg = rest[0] ?? null;
  const build = arg?.match(/^(feature|issue)\/(.*)$/);
  if (build) return { mode: "build", type: build[1], slug: requireSlug(build[2]), subject: `${build[1]}/${build[2]}` };
  if (arg === null) {
    if (options.resume) usage("start-session --resume needs a session id or <feature|issue>/<slug>");
    return { mode: "plan", id: null };
  }
  if (!SESSION_ID.test(arg)) usage(`start-session takes <feature|issue>/<slug> or a session id matching [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(arg)}`);
  return { mode: "plan", id: arg };
}

// The same shape for gh: stdin closed, stderr captured, never a prompt.
function ghRun(cwd, args, timeout = 30000) {
  try {
    const stdout = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
    return { ok: true, stdout: stdout.trim(), stderr: "", timedOut: false, missing: false };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    const timedOut = error?.code === "ETIMEDOUT" || Boolean(error?.signal && !error?.status);
    const stderr = (error?.stderr ?? "").toString().trim();
    const message = missing ? "gh CLI not found on PATH" : timedOut ? `gh ${args[0]} timed out after ${timeout / 1000} s` : stderr || error?.message || "unknown error";
    return { ok: false, stdout: (error?.stdout ?? "").toString().trim(), stderr: message, timedOut, missing };
  }
}

function reauthFor(url) {
  if (/^https:\/\/github\.com\//.test(url ?? "")) return "gh auth login";
  return `re-authenticate the credentials for ${url ?? "origin"} (credential helper or SSH key)`;
}


// Ids already used by a managed plan session in either clone (path on disk,
// registered worktree, or workspace file), so a generated id never collides.
function takenPlanIds(dirs, lists) {
  const ids = new Set();
  const add = (name) => {
    const match = name.match(/^plan-(.+?)(\.code-workspace)?$/);
    if (match) ids.add(match[1]);
  };
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) add(name);
  }
  for (const list of lists) for (const w of list) add(path.basename(w.path));
  return ids;
}

const registeredAt = (list, p) => list.find((w) => samePath(w.path, p)) ?? null;

function startSession() {
  const args = startSessionArgs();
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const out = {
    status: "ok",
    mode: args.mode,
    subject: args.mode === "build" ? args.subject : args.id,
    outcome: null,
    product: null,
    companion: null,
    workspace: null,
    target: null,
    opened: false,
    openCommand: null,
    next: [],
    preflight: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, result.status === "ok" ? 0 : 3);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });

  // Window check (§11): the primary checkout, on the default branch, clean.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);
  if (worktree.branch !== config.branches.default) reject(`primary checkout not on ${config.branches.default} (${where})`);
  if (git(primary, "status", "--porcelain") !== "") reject(`primary checkout is dirty (${worktree.path}); commit, stash, or discard its changes first`);

  // Capability preflight (§10): fail rejects, warn proceeds with the fallback.
  const doctor = runDoctor(checksFor(COMMAND_NEEDS["start-session"]));
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) reject(failed.detail, { capability: capabilityOf(failed.id), check: failed.id, fallback: failed.fallback });
  out.preflight = doctor.checks.filter((c) => c.status === "warn").map(({ id, status, detail, fallback }) => ({ id, capability: capabilityOf(id), status, detail, fallback }));

  const fetch = (dir, label) => {
    const result = gitRun(dir, ["fetch", "origin"]);
    if (result.ok) return;
    const url = originOf(dir);
    if (!result.timedOut && classifyFetchFailure(result.stderr) === "auth") {
      fail("fetch-auth", `git -C ${dir} fetch origin: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(url) });
    }
    out.warnings.push(`fetch: ${label} ${url ?? "origin"} not fetched (${result.stderr.split("\n")[0]}); continuing from local refs`);
  };
  fetch(primary, "product");

  // Which halves this session uses, before anything is written.
  let resolved;
  let productBranch = null;
  if (args.mode === "plan") {
    const productList = productWorktrees();
    const id = args.id ?? nextSessionId({ now: new Date(), taken: takenPlanIds([primaryWorktreesDir(productList), companionWorktreesDir], [productList, companionWorktrees()]) });
    out.subject = id;
    resolved = resolveSessionPaths("plan", id, checkoutLayout());
    out.next = ["/agento new-feature <description>", "/agento new-issue <description>"];
  } else {
    const { type, slug } = args;
    const { result, layout } = resolveWithLayout(type, slug);
    if (result.status !== "ok") reject(result.message, { resolution: result.status });
    const content = result.source === "local" ? fs.readFileSync(result.path, "utf8") : layout.agit("show", `origin/${result.branch}:${result.path}`);
    if (header(content, "status") === "complete") reject(`${type}/${slug} is complete (status: complete); no build session is needed`);
    productBranch = result.branch;
    const productList = productWorktrees();
    // The window check already keeps the primary on the default branch, so an owner here is managed.
    const owner = findOwner({ worktrees: productList, worktreesDir: primaryWorktreesDir(productList), branch: productBranch, config });
    resolved = owner ? resolveSessionPaths(owner.dirPrefix, owner.id, layout) : resolveSessionPaths(type, slug, layout);
    if (!owner && !registeredAt(productList, resolved.worktree)) {
      const local = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${productBranch}`);
      const remote = git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${productBranch}`);
      if (!local && !remote) reject(`${productBranch} exists neither locally nor on origin; the delivery planner must publish it`);
    }
    out.next = [`/agento build-${type} ${slug}`];
  }

  const companionClone = resolved.companion ? resolved.layout.artifactsRoot : null;
  if (companionClone) fetch(companionClone, "companion");
  const defaultRef = `origin/${config.branches.default}`;
  const companionDefault = `origin/${resolved.layout.config.branches.default}`;

  // Product half: reuse when registered, never touch an unregistered path on disk.
  const productList = productWorktrees();
  if (registeredAt(productList, resolved.worktree)) out.outcome = "resumed";
  else if (!fs.existsSync(resolved.worktree)) {
    let addArgs;
    if (args.mode === "plan") addArgs = ["worktree", "add", "--detach", resolved.worktree, defaultRef];
    else if (git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${productBranch}`)) addArgs = ["worktree", "add", resolved.worktree, productBranch];
    else addArgs = ["worktree", "add", "--track", "-b", productBranch, resolved.worktree, `origin/${productBranch}`];
    const add = gitRun(primary, addArgs, 120000);
    if (!add.ok) fail("worktree-add", `git -C ${primary} ${addArgs.join(" ")}: ${add.stderr}`, { half: "product" });
    if (args.mode === "plan" && git(resolved.worktree, "rev-parse", "HEAD") !== git(root, "rev-parse", defaultRef)) {
      fail("worktree-add", `${resolved.worktree} is not detached at ${defaultRef}`, { half: "product" });
    }
    out.outcome = "created";
  } else out.outcome = "resumed";

  // Companion half: same name, same branch (build) or detached at its default (plan).
  if (resolved.companion) {
    const half = resolved.companion.worktree;
    const list = parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain"));
    if (!registeredAt(list, half) && !fs.existsSync(half)) {
      const branch = args.mode === "build" ? productBranch : null;
      let addArgs;
      if (!branch) addArgs = ["worktree", "add", "--detach", half, companionDefault];
      else if (git(companionClone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) addArgs = ["worktree", "add", half, branch];
      else if (git(companionClone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) addArgs = ["worktree", "add", "--track", "-b", branch, half, `origin/${branch}`];
      else {
        addArgs = ["worktree", "add", "--no-track", "-b", branch, half, companionDefault];
        out.warnings.push(`companion-branch: ${branch} did not exist in ${companionClone}; created from ${companionDefault} without upstream — publish it with git -C ${half} push -u origin ${branch}`);
      }
      const add = gitRun(companionClone, addArgs, 120000);
      if (!add.ok) fail("worktree-add", `git -C ${companionClone} ${addArgs.join(" ")}: ${add.stderr}`, { half: "companion" });
    }
  }

  // Post-add check on both halves, created or reused: right clone, right origin.
  const freshProduct = productWorktrees({ fresh: true });
  const freshCompanion = companionClone ? parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain")) : [];
  const describeHalf = (halfPath, own, clone) => {
    const onDisk = fs.existsSync(halfPath);
    const state = halfState({ path: halfPath, own, worktrees: freshProduct, companionWorktrees: freshCompanion, origin: onDisk ? originOf(halfPath) : null, expectedOrigin: originOf(clone), onDisk });
    const entry = registeredAt(own === "product" ? freshProduct : freshCompanion, halfPath);
    return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, state };
  };
  out.product = describeHalf(resolved.worktree, "product", root);
  out.companion = resolved.companion ? describeHalf(resolved.companion.worktree, "companion", companionClone) : null;
  for (const [half, described] of [["product", out.product], ["companion", out.companion]]) {
    if (!described || described.state.ok) continue;
    const { registeredIn, origin, expectedOrigin } = described.state;
    const clone = registeredIn === "product" ? primary : registeredIn === "companion" ? companionClone : null;
    const message = registeredIn
      ? `${half} half ${described.path} is registered in the ${registeredIn} clone with origin ${origin ?? "none"} (expected ${expectedOrigin}); nothing was removed`
      : `${half} half ${described.path} exists but is not a registered worktree of either clone; nothing was removed`;
    fail("post-add-check", message, { half, registeredIn, origin, expectedOrigin, fix: clone ? `git -C ${clone} worktree remove ${described.path}` : null });
  }

  if (resolved.companion && resolved.workspace) {
    const { written } = writeSessionWorkspace(resolved);
    out.workspace = { path: resolved.workspace, written };
    out.target = { kind: "workspace", path: resolved.workspace };
  } else out.target = { kind: "folder", path: out.product.path };

  out.openCommand = `code --new-window ${out.target.path}`;
  if (!options.noOpen) {
    try {
      execFileSync("code", ["--new-window", out.target.path], { cwd: root, stdio: "ignore", timeout: 15000 });
      out.opened = true;
    } catch (error) {
      out.warnings.push(`open: ${error?.code === "ENOENT" ? "code CLI not found on PATH" : `code --new-window failed: ${error?.message ?? error}`}; run ${out.openCommand}`);
    }
  }
  finish();
}

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

// --- close-session ---------------------------------------------------------

function closeSessionArgs() {
  const freehand = config.branches.freehand;
  if (rest.length !== 1) usage(`close-session takes exactly one argument (<feature|issue>/<slug>, ${freehand}<slug>, or a session id), got ${JSON.stringify(rest.join(" "))}`);
  const arg = rest[0];
  const build = arg.match(/^(feature|issue)\/(.*)$/);
  if (build) return { mode: "build", type: build[1], slug: requireSlug(build[2]), subject: arg };
  if (arg.startsWith(freehand)) return { mode: "freehand", slug: requireSlug(arg.slice(freehand.length)), subject: arg };
  if (!SESSION_ID.test(arg)) usage(`close-session takes <feature|issue>/<slug>, ${freehand}<slug>, or a session id matching [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(arg)}`);
  return { mode: "plan", id: arg, subject: arg };
}

const isAncestor = (dir, a, b) => gitRun(dir, ["merge-base", "--is-ancestor", a, b]).ok;
const logLines = (dir, ...range) => git(dir, "log", "--format=%h %s", ...range).split("\n").filter(Boolean);

// Commits in a half that exist nowhere safe. Plan halves must sit inside the
// default branch. Otherwise none when HEAD is in the default branch; else those past
// a live upstream; else (upstream gone, never set, or detached) those on no remote
// ref — except a freehand branch that never had an upstream, whose commits survive
// on the retained local branch.
function unpushedCommits(dir, defaultRef, mode) {
  if (isAncestor(dir, "HEAD", defaultRef)) return [];
  if (mode === "plan") return logLines(dir, `${defaultRef}..HEAD`);
  if (git(dir, "rev-parse", "--verify", "--quiet", "@{upstream}")) return logLines(dir, "@{upstream}..HEAD");
  const current = git(dir, "branch", "--show-current");
  if (mode === "freehand" && current && !git(dir, "for-each-ref", "--format=%(upstream)", `refs/heads/${current}`)) return [];
  return logLines(dir, "HEAD", "--not", "--remotes");
}

function closeSession() {
  let args = closeSessionArgs();
  const dryRun = Boolean(options.dryRun);
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const out = {
    status: "ok",
    mode: args.mode,
    subject: args.subject,
    outcome: null,
    applied: false,
    product: null,
    companion: null,
    workspace: null,
    branches: { product: null, companion: null },
    occupants: { product: [], companion: [] },
    dirty: { product: [], companion: [] },
    next: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, result.status === "ok" ? 0 : 3);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });

  // Window check (§11): the primary checkout; its branch and cleanliness do not matter here.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);

  // --prune, so a remote branch deleted after its merge reads as gone.
  const fetched = new Set();
  const fetch = (dir, label) => {
    if (fetched.has(path.resolve(dir))) return;
    fetched.add(path.resolve(dir));
    const result = gitRun(dir, ["fetch", "--prune", "origin"]);
    if (result.ok) return;
    const url = originOf(dir);
    if (!result.timedOut && classifyFetchFailure(result.stderr) === "auth") {
      fail("fetch-auth", `git -C ${dir} fetch --prune origin: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(url) });
    }
    out.warnings.push(`fetch: ${label} ${url ?? "origin"} not fetched (${result.stderr.split("\n")[0]}); continuing from local refs`);
  };
  fetch(primary, "product");
  if (artifacts.external) fetch(artifactsRoot, "companion");

  // A plan-<id> worktree on a delivery branch was promoted: close it as that build.
  if (args.mode === "plan") {
    const entry = registeredAt(productWorktrees(), resolveSessionPaths("plan", args.id, checkoutLayout()).worktree);
    const type = !entry || entry.detached ? null : ["feature", "issue"].find((t) => entry.branch?.startsWith(config.branches[t]));
    const slug = type ? entry.branch.slice(config.branches[type].length) : null;
    if (type && SESSION_ID.test(slug)) {
      args = { mode: "build", type, slug, subject: `${type}/${slug}` };
      out.mode = "build";
      out.subject = args.subject;
    }
  }

  // Which halves, which branch, which clones — every check below precedes the first write.
  let layout = checkoutLayout();
  let paths;
  let branch = null;
  let outcome = null;
  if (args.mode === "build") {
    const { type, slug } = args;
    const decided = decideWithLayout(type, slug, (l) =>
      closeBuildSessionDecision({ type, slug, currentBranch, worktreeList: productWorktreeText(), git: l.artifactsGit, rootDir: root, artifactsRoot: l.artifactsRoot, config: l.config }),
    );
    const { decision } = decided;
    layout = decided.layout;
    if (decision.status !== "ok") reject(decision.reason, { message: decision.message });
    if (decision.reason === "primary-owns-branch") reject("primary-owns-branch", { message: decision.message, fix: `git switch ${config.branches.default}` });
    if (layout.artifacts.external) fetch(layout.artifactsRoot, "companion");
    branch = deliveryBranch(type, slug);
    if (decision.reason === "managed-worktree-present") {
      const { owner } = decision;
      const companion = companionOfOwner(owner, layout);
      const gaps = companionGaps(companion);
      if (gaps.length) reject("companion-unpushed", { message: companionGapMessage(companion, gaps, type, slug) });
      const resolved = resolveSessionPaths(owner.dirPrefix, owner.id, layout);
      paths = { product: owner.path, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
      outcome = "closed";
    } else {
      const resolved = resolveSessionPaths(type, slug, layout);
      paths = { product: resolved.worktree, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
      outcome = "already-closed";
    }
    let roadmapStatus = null;
    try {
      const { result, layout: found } = resolveWithLayout(type, slug);
      if (result.status === "ok") roadmapStatus = header(result.source === "local" ? fs.readFileSync(result.path, "utf8") : found.agit("show", `origin/${result.branch}:${result.path}`), "status");
    } catch {
      roadmapStatus = null;
    }
    if (roadmapStatus !== "complete") out.next = [`/agento ship ${slug}`];
  } else {
    const kind = args.mode;
    const id = kind === "plan" ? args.id : args.slug;
    if (kind === "freehand") branch = `${config.branches.freehand}${args.slug}`;
    const resolved = resolveSessionPaths(kind, id, layout);
    paths = { product: resolved.worktree, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
  }

  const companionClone = layout.artifacts.external ? layout.artifactsRoot : null;
  const productList = productWorktrees({ fresh: true });
  const companionList = companionClone ? parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain")) : [];
  const inspect = (halfPath, list) => {
    const entry = registeredAt(list, halfPath);
    return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, registered: Boolean(entry), onDisk: fs.existsSync(halfPath), removed: false };
  };
  out.product = inspect(paths.product, productList);
  out.companion = paths.companion ? inspect(paths.companion, companionList) : null;
  out.workspace = paths.workspace ? { path: paths.workspace, existed: fs.existsSync(paths.workspace), removed: false } : null;
  const halves = [
    ["product", out.product, primary, productList, `origin/${config.branches.default}`],
    ...(out.companion ? [["companion", out.companion, companionClone, companionList, `origin/${layout.config.branches.default}`]] : []),
  ];

  for (const [label, half, clone] of halves) {
    if ([primary, companionClone].some((protectedPath) => protectedPath && samePath(half.path, protectedPath))) {
      reject("protected-path", { message: `${label} half ${half.path} is the clone itself (${clone}); close-session never removes a primary checkout` });
    }
    if (half.onDisk && !half.registered) {
      reject("unregistered", { message: `${label} half ${half.path} exists but is not a registered worktree of ${clone}; nothing was removed` });
    }
    if (!half.registered) continue;
    const expected = args.mode === "plan" ? half.detached : half.branch === branch || (label === "companion" && half.detached);
    if (!expected) {
      const want = args.mode === "plan" ? "detached (a planning session)" : `on ${branch}`;
      reject("branch-mismatch", { message: `${label} half ${half.path} is ${half.detached ? "detached" : `on ${half.branch}`}, expected ${want}; nothing was removed` });
    }
  }

  for (const [label, half] of halves) {
    if (!half.registered || !half.onDisk) continue;
    const tree = treeState(half.path);
    out.dirty[label] = tree ? [...tree.tracked, ...tree.untracked] : [];
  }
  const dirtyHalves = halves.filter(([label]) => out.dirty[label].length);
  if (dirtyHalves.length) {
    reject("dirty", { message: dirtyHalves.map(([label, half]) => `${label} half ${half.path} has uncommitted changes: ${out.dirty[label].join(", ")}`).join("; ") });
  }

  const commits = { product: [], companion: [] };
  for (const [label, half, , , defaultRef] of halves) {
    if (half.registered && half.onDisk) commits[label] = unpushedCommits(half.path, defaultRef, args.mode);
  }
  const unpushed = halves.filter(([label]) => commits[label].length);
  if (unpushed.length) {
    const message = unpushed.map(([label, half, , , defaultRef]) => `${label} half ${half.path} has ${commits[label].length} commit(s) on neither its upstream nor ${defaultRef}: ${commits[label].join("; ")}`).join("; ");
    reject("unpushed", { message, commits, next: args.mode === "freehand" ? ["/agento finish-freehand"] : out.next });
  }

  const anyHalf = halves.some(([, half]) => half.registered);
  out.outcome = outcome ?? (anyHalf || out.workspace?.existed ? "closed" : "nothing-to-close");

  // A local branch goes only when it is gone from origin, merged into that clone's
  // origin/<default>, checked out nowhere else, and `git branch -d` would accept it.
  if (branch) {
    for (const [label, clone, list, defaultRef] of [
      ["product", primary, productList, `origin/${config.branches.default}`],
      ...(companionClone ? [["companion", companionClone, companionList, `origin/${layout.config.branches.default}`]] : []),
    ]) {
      const ownHalf = out[label];
      out.branches[label] = branchVerdict(clone, list, branch, defaultRef, ownHalf?.registered ? ownHalf.path : null);
    }
    const unmerged = Object.values(out.branches).some((v) => v?.action === "retained" && !v.mergedIntoDefault);
    if (args.mode === "freehand" && unmerged) out.next = [`/agento start-freehand ${args.slug} --resume`];
  }

  // Occupant gate and apply block, shared with the ship teardown.
  const removal = removeSessionPair({
    halves: halves.map(([label, half, clone]) => ({ label, half, clone })),
    workspace: out.workspace,
    branches: out.branches,
    ignoreOccupants: Boolean(options.ignoreOccupants),
    dryRun,
  });
  out.occupants = removal.occupants;
  out.warnings.push(...removal.warnings);
  out.applied = removal.applied;
  if (removal.status === "blocked") finish({ status: "blocked", reason: removal.reason, message: removal.message });
  if (removal.status === "failed") fail(removal.reason, removal.message, { half: removal.half });
  finish();
}

// Whether `git branch -d <branch>` in `clone` is safe and wanted: the local branch
// exists, is gone from origin, is merged into `defaultRef`, is checked out nowhere
// but `ownHalfPath` (which is about to be removed), and is reachable from HEAD.
function branchVerdict(clone, list, branch, defaultRef, ownHalfPath = null) {
  const local = git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  const verdict = {
    name: branch,
    upstream: local ? git(clone, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`) || null : null,
    remoteExists: Boolean(git(clone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)),
    mergedIntoDefault: Boolean(local) && isAncestor(clone, `refs/heads/${branch}`, defaultRef),
    action: "retained",
    reason: null,
  };
  const holder = list.find((w) => w.branch === branch && !(ownHalfPath && samePath(w.path, ownHalfPath)));
  const head = git(clone, "symbolic-ref", "--short", "-q", "HEAD") || "HEAD";
  if (!local) Object.assign(verdict, { action: "absent", reason: `no local ${branch} in ${clone}` });
  else if (verdict.remoteExists) verdict.reason = `origin/${branch} still exists`;
  else if (!verdict.mergedIntoDefault) verdict.reason = `not merged into ${defaultRef}`;
  else if (holder) verdict.reason = `checked out at ${holder.path}`;
  else if (!isAncestor(clone, `refs/heads/${branch}`, "HEAD")) verdict.reason = `merged into ${defaultRef} but not into ${head} at ${clone}, so git branch -d would refuse; run git -C ${clone} pull --ff-only, then re-send`;
  else Object.assign(verdict, { action: "deleted", reason: `merged into ${defaultRef} and gone from origin` });
  return verdict;
}

// The occupant gate and the removal of a managed pair (companion half, prune,
// product half, prune, workspace file, merged local branches), as a result instead
// of an emission so close-session and the ship teardown share one implementation.
// `halves` are `{ label, half: { path, registered, onDisk, removed }, clone }` in
// product-first order; `branches.<label>` verdicts with `action: "deleted"` are
// deleted after the halves. The half, workspace, and branch objects are updated in
// place. The guard cannot see removals made from inside this process, so the gate
// runs here on every call.
function removeSessionPair({ halves, workspace = null, branches = { product: null, companion: null }, ignoreOccupants = false, dryRun = false, codeStatus = once(defaultCodeStatus) }) {
  const out = {
    status: "ok",
    reason: null,
    message: null,
    half: null,
    applied: false,
    occupants: { product: [], companion: [] },
    product: halves.find((h) => h.label === "product")?.half ?? null,
    companion: halves.find((h) => h.label === "companion")?.half ?? null,
    workspace,
    branches,
    warnings: [],
  };
  for (const { label, half } of halves) {
    if (half.registered && half.onDisk) out.occupants[label] = findOccupants(half.path, { codeStatus }).details;
  }
  const occupied = halves.filter(({ label }) => out.occupants[label].length);
  if (occupied.length) {
    const summary = occupied.map(({ label, half }) => `${label} half ${half.path}: ${out.occupants[label].join(", ")}`).join("; ");
    if (!ignoreOccupants) {
      return { ...out, status: "blocked", reason: "occupied", half: occupied[0].label, message: `Active worktree occupants detected - ${summary}. Close their terminals or VS Code window before removal, or re-send with --ignore-occupants.` };
    }
    out.warnings.push(`occupants: ignored (--ignore-occupants) - ${summary}`);
  }

  for (const { half } of halves) half.removed = half.registered;
  if (workspace) workspace.removed = workspace.existed;
  if (dryRun) return out;

  // Apply: companion half, prune, product half, prune, workspace file, merged branches.
  out.applied = true;
  for (const { label, half, clone } of [...halves].reverse()) {
    if (half.registered) {
      const removal = gitRun(clone, ["worktree", "remove", half.path], 120000);
      if (!removal.ok) {
        half.removed = false;
        if (label === "companion" && out.product) out.product.removed = false;
        if (workspace) workspace.removed = false;
        for (const verdict of Object.values(branches)) if (verdict?.action === "deleted") Object.assign(verdict, { action: "retained", reason: "not attempted: a worktree removal failed" });
        return { ...out, status: "failed", reason: "worktree-remove", half: label, message: `git -C ${clone} worktree remove ${half.path}: ${removal.stderr}` };
      }
    }
    gitRun(clone, ["worktree", "prune"]);
  }
  if (workspace?.existed) fs.rmSync(workspace.path, { force: true });
  for (const { label, clone } of halves) {
    const verdict = branches[label];
    if (verdict?.action !== "deleted") continue;
    const deletion = gitRun(clone, ["branch", "-d", verdict.name]);
    if (!deletion.ok) {
      Object.assign(verdict, { action: "retained", reason: `git branch -d failed: ${deletion.stderr.split("\n")[0]}` });
      return { ...out, status: "failed", reason: "branch-delete", half: label, message: `git -C ${clone} branch -d ${verdict.name}: ${deletion.stderr}` };
    }
  }
  return out;
}

// --- shared integration helpers (ship, sync, step-commit) -------------------

// Result-returning, never emitting: each caller reports a failure in its own contract.
function fetchOrigin(dir) {
  const result = gitRun(dir, ["fetch", "--prune", "origin"]);
  if (result.ok) return { ok: true };
  const url = originOf(dir);
  const auth = !result.timedOut && classifyFetchFailure(result.stderr) === "auth";
  const stderr = result.stderr.split("\n")[0];
  return { ok: false, auth, url, stderr, reauth: auth ? reauthFor(url) : null, message: `git -C ${dir} fetch --prune origin: ${stderr}` };
}

// `merge --no-edit`, never a rebase; a conflict is aborted and reported with its files.
function mergeRef(dir, ref) {
  const merge = gitRun(dir, ["merge", "--no-edit", ref], 120000);
  if (merge.ok) return { ok: true, merged: !/Already up to date/.test(merge.stdout) };
  const conflicts = git(dir, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  gitRun(dir, ["merge", "--abort"]);
  return { ok: false, conflicts, clean: git(dir, "status", "--porcelain") === "", stderr: merge.stderr.split("\n")[0] };
}

// A plain push, never forced; `-u` only when the caller asks for it.
function pushRef(dir, refspec, { setUpstream = false } = {}) {
  const args = ["push", ...(setUpstream ? ["-u"] : []), "origin", refspec];
  const result = gitRun(dir, args, 120000);
  if (result.ok) return { ok: true };
  const auth = classifyFetchFailure(result.stderr) === "auth";
  return { ok: false, reason: auth ? "push-auth" : "push-failed", reauth: auth ? reauthFor(originOf(dir)) : null, message: `git -C ${dir} ${args.join(" ")}: ${result.stderr.split("\n")[0]}` };
}

// --- sync and step-commit: the Builder's integration and commit choreography --

const STEP_EXIT = { ok: 0, reverify: 2, rejected: 3, failed: 3 };
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: \S/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The slug's build window (§11) on the roadmap's branch in every half; never the
// default branch, never detached — the guard cannot see the git this CLI runs.
function buildWindow(type, slug, command = `build-${type}`) {
  const record = sessionRecord();
  const verdict = windowVerdict({ command, record, slug, defaultBranch: config.branches.default });
  const base = { record, allowed: verdict.allowed, elsewhere: verdict.elsewhere, warnings: [...record.warnings] };
  const reject = (reason, message = reason) => ({ ok: false, reason, message, ...base });
  if (!verdict.match) return reject(verdict.reason);
  const { worktree, delivery, companion } = record;
  if (delivery?.type !== type || !delivery.roadmap) return reject(`wrong window: this ${record.role} window holds no roadmap for ${type}/${slug} (${worktree.path})`);
  const { branch } = delivery;
  const defaultBranch = config.branches.default;
  const halves = [{ label: "product", path: worktree.path, branch: worktree.branch, detached: worktree.detached }];
  if (artifacts.external) {
    if (!companion?.registered || !fs.existsSync(companion.path)) return reject("companion-missing", `the companion half for ${type}/${slug} is not a registered worktree on disk (${companion?.path ?? "none"})`);
    halves.push({ label: "companion", path: companion.path, branch: companion.branch, detached: companion.detached });
  }
  for (const half of halves) {
    if (half.detached || !half.branch) return reject("detached-head", `the ${half.label} half ${half.path} is on a detached HEAD; switch it to ${branch} first`);
    if (half.branch === defaultBranch) return reject("default-branch", `the ${half.label} half ${half.path} is on ${defaultBranch}; never commit or push to the default branch`);
    if (half.branch !== branch) return reject("branch-mismatch", `the ${half.label} half ${half.path} is on ${half.branch}, but the roadmap names ${branch}`);
  }
  return { ok: true, ...base, branch, defaultBranch, delivery, halves: halves.map(({ label, path: p }) => ({ label, path: p })), artifactHalf: halves.at(-1).path, slugDir: delivery.dir, roadmapRel: delivery.roadmap };
}

// One JSON document per call; every stop emits it with the exit code of its status.
function deliveryRun(command, type, slug, fields) {
  const out = { status: "ok", command, phase: "window", outcome: null, type, slug, branch: deliveryBranch(type, slug), mode: artifacts.external ? "companion" : "in-repo", ...fields, halves: { product: null, companion: null }, conflicts: [], actions: [], reason: null, message: null, fix: null, reauth: null, next: [], allowed: [], elsewhere: [], warnings: [], root, configSource: source };
  const finish = (extra = {}) => {
    for (const half of Object.values(out.halves)) if (half) half.head = git(half.path, "rev-parse", "HEAD") || null;
    const result = { ...out, ...extra };
    emit(result, STEP_EXIT[result.status]);
  };
  return {
    out,
    finish,
    reject: (reason, extra = {}) => finish({ status: "rejected", reason, ...extra }),
    fail: (reason, message, extra = {}) => finish({ status: "failed", reason, message, ...extra }),
    act: (step, detail) => out.actions.push({ step, detail }),
  };
}

// The window check shared by the delivery subcommands; returns the halves as live result entries.
function openDeliveryRun(run, type, slug, command = `build-${type}`) {
  const win = buildWindow(type, slug, command);
  Object.assign(run.out, { allowed: win.allowed, elsewhere: win.elsewhere, warnings: win.warnings });
  if (!win.ok) run.reject(win.reason, { message: win.message });
  run.out.branch = win.branch;
  const halves = win.halves.map((h) => (run.out.halves[h.label] = { label: h.label, path: h.path, head: null, merged: [], pushed: false }));
  return { win, halves };
}

// Fetch every half, then merge origin/<branch> and origin/<default> where they are not
// ancestors of HEAD (never a rebase); a conflict is aborted and stops the run unpushed.
// `defaultHalves` limits the origin/<default> merge to those half labels (null: every half).
function integrateHalves(run, win, halves, { defaultHalves = null } = {}) {
  run.out.phase = "integrate";
  for (const half of halves) {
    const fetched = fetchOrigin(half.path);
    if (fetched.ok) continue;
    if (fetched.auth) run.fail("fetch-auth", `${fetched.message}; nothing was pushed`, { reauth: fetched.reauth });
    run.fail("fetch-failed", `${fetched.message}; nothing was pushed — re-send once origin is reachable`);
  }
  const merged = [];
  for (const half of halves) {
    for (const [ref, kind] of [[`origin/${win.branch}`, "branch"], [`origin/${win.defaultBranch}`, "default"]]) {
      if (kind === "default" && defaultHalves && !defaultHalves.includes(half.label)) continue;
      if (!git(half.path, "rev-parse", "--verify", "--quiet", ref) || isAncestor(half.path, ref, "HEAD")) continue;
      const result = mergeRef(half.path, ref);
      if (!result.ok) {
        const files = result.conflicts.length ? result.conflicts.join(", ") : "(no paths reported)";
        run.reject("integration-conflict", { half: half.label, ref, conflicts: result.conflicts, message: `merging ${ref} into ${win.branch} at ${half.path} conflicts in ${files} (${result.stderr || "merge failed"}); the merge was aborted${result.clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; nothing was pushed — resolve it by hand per the concurrent-delivery hotspot recipes, then re-send`, fix: `git -C ${half.path} merge ${ref}` });
      }
      half.merged.push(ref);
      merged.push({ half: half.label, ref, kind });
      run.act("integrate", `${half.label}: merged ${ref} into ${win.branch} at ${half.path}`);
    }
  }
  return merged;
}

// Push every half whose HEAD is not on origin/<branch> yet (or has no upstream), product first.
function pushHalves(run, win, halves) {
  run.out.phase = "push";
  for (const half of halves) {
    const upstream = git(half.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    const remote = git(half.path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${win.branch}`);
    if (upstream && remote && remote === git(half.path, "rev-parse", "HEAD")) continue;
    // A full refspec, so a branch named `+x` can never become a forced push.
    const result = pushRef(half.path, `refs/heads/${win.branch}:refs/heads/${win.branch}`, { setUpstream: !upstream });
    if (!result.ok) run.fail(result.reason, `${result.message}; pushed so far: ${halves.filter((h) => h.pushed).map((h) => h.label).join(", ") || "nothing"} — re-send to resume`, result.reauth ? { reauth: result.reauth } : {});
    half.pushed = true;
    run.out.pushed?.push(half.label);
    run.act("push", `${half.label}: pushed ${win.branch} from ${half.path}`);
  }
}

function deliveryArgs(command, extra = "") {
  const type = requireType(rest[0]);
  const slug = requireSlug(rest[1]);
  if (rest.length > 2) usage(`${command} takes <feature|issue> <slug>${extra}, got extra ${JSON.stringify(rest.slice(2).join(" "))}`);
  return { type, slug };
}

function sync() {
  const { type, slug } = deliveryArgs("sync");
  const run = deliveryRun("sync", type, slug, { merged: false, pushed: [] });
  const { win, halves } = openDeliveryRun(run, type, slug);
  for (const half of halves) {
    const tree = treeState(half.path);
    if (tree?.tracked.length) run.reject("dirty", { half: half.label, paths: tree.tracked, message: `the ${half.label} half ${half.path} has uncommitted tracked changes (${tree.tracked.join(", ")}); commit them with step-commit, or discard them, then re-send` });
  }
  const merged = integrateHalves(run, win, halves);
  run.out.merged = merged.length > 0;
  pushHalves(run, win, halves);
  run.out.phase = "done";
  run.finish({ outcome: merged.length ? "merged" : run.out.pushed.length ? "pushed" : "up-to-date", message: merged.length ? `merged ${merged.map((m) => `${m.ref} (${m.half})`).join(", ")}; re-verify before the next commit` : null });
}

// The message file must sit outside both halves, or `add -A` would commit it.
function insideDir(file, dir) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(dir), path.join(real(path.dirname(file)), path.basename(file)));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// `artifact-pr: "#<n>"` into the roadmap's YAML header, after github-issue when present.
function withArtifactPr(content, number) {
  const lines = content.split("\n");
  const open = lines.findIndex((l) => /^```ya?ml\s*$/.test(l));
  const close = open === -1 ? -1 : lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  if (close === -1) return null;
  const issue = lines.findIndex((l, i) => i > open && i < close && /^github-issue:/.test(l));
  lines.splice(issue === -1 ? close : issue + 1, 0, `artifact-pr: "#${number}"`);
  return lines.join("\n");
}

function stepCommit() {
  const { type, slug } = deliveryArgs("step-commit", " [--step N.M] --message-file <file|->");
  if (!options.messageFile) usage("step-commit needs --message-file <file|-> (- reads the message from stdin)");
  const step = options.step ?? null;
  const run = deliveryRun("step-commit", type, slug, { step, commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, companionPr: null });
  const { win, halves } = openDeliveryRun(run, type, slug);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  // The message: a Conventional Commit naming the step, from outside both halves.
  run.out.phase = "message";
  let message;
  if (options.messageFile === "-") message = fs.readFileSync(0, "utf8");
  else {
    const file = path.resolve(startDir, options.messageFile);
    const holder = halves.find((h) => insideDir(file, h.path));
    if (holder) run.reject("message-file-inside-half", { message: `${file} is inside the ${holder.label} half ${holder.path}, so it would be committed; write it outside both halves or pass --message-file - on stdin` });
    if (!fs.existsSync(file)) usage(`--message-file ${file} does not exist`);
    message = fs.readFileSync(file, "utf8");
  }
  message = message.replace(/\s+$/, "");
  const subject = message.split("\n")[0];
  if (!CONVENTIONAL.test(subject)) run.reject("message-not-conventional", { message: `the first message line ${JSON.stringify(subject)} is not a Conventional Commit (<type>[(<scope>)][!]: <description>)` });
  if (step && !new RegExp(`(^|[^0-9.])${escapeRe(step)}(?![0-9])`).test(message)) run.reject("message-missing-step", { message: `--step ${step} is set but the commit message does not name ${step}` });

  // Staging (Q1): everything in the product half; in companion mode only the slug directory.
  run.out.phase = "stage";
  const productTree = treeState(product.path);
  const companionTree = companion ? treeState(companion.path) : null;
  // `--no-renames` lists a staged rename's origin as a deletion, which status -z hides.
  const staged = (half) => git(half.path, "diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
  const outsideSlug = (paths) => [...new Set(paths)].filter((p) => !p.startsWith(`${win.slugDir}/`)).sort();
  if (companionTree) {
    const outside = outsideSlug([...companionTree.tracked, ...companionTree.untracked, ...staged(companion)]);
    if (outside.length) run.reject("companion-outside-slug", { paths: outside, message: `the companion half ${companion.path} has changes outside ${win.slugDir}/: ${outside.join(", ")}; delete byproducts or move them out, then re-send` });
  }
  const changed = (tree) => Boolean(tree && tree.tracked.length + tree.untracked.length);
  const productChanged = changed(productTree);
  const companionChanged = changed(companionTree);

  // The roadmap rule (Q2): a step's tick lands in this commit; otherwise roadmap.md changed.
  if (productChanged || companionChanged) {
    const roadmapFile = path.join(artifactHalf.path, win.roadmapRel);
    const working = fs.existsSync(roadmapFile) ? fs.readFileSync(roadmapFile, "utf8") : "";
    const committed = git(artifactHalf.path, "show", `HEAD:${win.roadmapRel}`);
    if (step) {
      const tick = new RegExp(`^\\s*- \\[[xX]\\] ${escapeRe(step)}(?=\\s)`, "m");
      if (!tick.test(working) || tick.test(committed)) run.reject("step-not-ticked", { message: `${win.roadmapRel} must tick - [x] ${step} in this commit (${tick.test(committed) ? "it is already ticked at HEAD" : "it is not ticked"}); tick it after its verify: passes, or send without --step for a roadmap-only update` });
    } else if (gitRun(artifactHalf.path, ["diff", "--quiet", "HEAD", "--", win.roadmapRel]).ok) {
      run.reject("roadmap-not-updated", { message: `${win.roadmapRel} is unchanged; every delivery commit carries its roadmap.md update (next-step, status, or last-updated)` });
    }
  }

  // Commits: product first, then the companion's tick; plain commits, hooks run.
  run.out.phase = "commit";
  const messageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-step-commit-"));
  process.on("exit", () => fs.rmSync(messageDir, { recursive: true, force: true }));
  const messageFile = path.join(messageDir, "message");
  fs.writeFileSync(messageFile, `${message}\n`);
  const commit = (half, pathspec, file = messageFile) => {
    const add = gitRun(half.path, ["add", "-A", "--", pathspec]);
    if (!add.ok) run.fail("stage-failed", `git -C ${half.path} add -A -- ${pathspec}: ${add.stderr}`);
    if (half === companion) {
      const escaped = outsideSlug(staged(half));
      if (escaped.length) run.fail("companion-outside-slug", `the companion index at ${half.path} holds paths outside ${win.slugDir}/ (${escaped.join(", ")}); nothing was committed there — unstage them, then re-send`, { half: half.label, paths: escaped });
    }
    const result = gitRun(half.path, ["commit", "-q", "-F", file, "--", pathspec], 300000);
    if (!result.ok) run.fail("commit-failed", `git -C ${half.path} commit: ${result.stderr || result.stdout}; nothing was pushed — fix it and re-send`, { half: half.label });
    const sha = git(half.path, "rev-parse", "HEAD");
    const files = git(half.path, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    run.act("commit", `${half.label}: ${sha.slice(0, 7)} ${git(half.path, "log", "-1", "--format=%s")} (${files.join(", ")})`);
    return sha;
  };
  if (productChanged) run.out.commits.product = commit(product, ".");
  if (companionChanged) run.out.commits.companion = commit(companion, win.slugDir);
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);

  // Integrate both defaults; a default merge means the step's verify: runs again first.
  const merged = integrateHalves(run, win, halves);
  run.out.integrated = merged;
  const defaults = merged.filter((m) => m.kind === "default");
  if (defaults.length) {
    run.finish({ status: "reverify", outcome: "merged-default", message: `merged ${defaults.map((m) => `${m.ref} (${m.half})`).join(", ")}; nothing was pushed — rerun the step's verify:, then re-send the same step-commit to push` });
  }
  pushHalves(run, win, halves);
  ensureDeliveryPrs(run, win, { type, slug, commit, messageDir });
  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-pushed" });
}

// Clean handoff: nothing uncommitted, nothing unpushed, in every half.
function cleanHandoff(run, halves) {
  run.out.phase = "check";
  const dirty = halves.map((h) => ({ half: h, tree: treeState(h.path) })).filter(({ tree }) => !tree || tree.tracked.length || tree.untracked.length || tree.ahead);
  if (dirty.length) {
    run.fail("not-clean", dirty.map(({ half, tree }) => `${half.label} half ${half.path}: ${tree ? `tracked ${tree.tracked.join(", ") || "none"}; untracked ${tree.untracked.join(", ") || "none"}; ahead ${tree.ahead}` : "unreadable"}`).join("; "), { paths: dirty.flatMap(({ tree }) => (tree ? [...tree.tracked, ...tree.untracked] : [])) });
  }
}

// A temporary directory for commit messages, removed on exit.
function messageScratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every changed path in a half: tracked, untracked, and staged (a rename's origin too).
function changedPaths(half) {
  const tree = treeState(half.path);
  const staged = git(half.path, "diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
  return [...new Set([...(tree ? [...tree.tracked, ...tree.untracked] : []), ...staged])].sort();
}

// Reject changes outside the slug directory (artifact half) and any change in the other half.
function rejectOutsideSlug(run, win, halves, artifactHalf) {
  for (const half of halves) {
    const paths = changedPaths(half);
    const outside = half === artifactHalf ? paths.filter((p) => !p.startsWith(`${win.slugDir}/`)) : paths;
    if (outside.length) run.reject("outside-slug", { half: half.label, paths: outside, message: `the ${half.label} half ${half.path} has changes outside ${half === artifactHalf ? `${win.slugDir}/` : "the delivery artifacts (it must be clean)"}: ${outside.join(", ")}; commit, move, or delete them, then re-send` });
  }
}

// `add -A` and a plain commit (hooks run) limited to `pathspec`; null pathspec with `allowEmpty` makes an empty commit.
function commitHalf(run, half, pathspec, file, { allowEmpty = false } = {}) {
  if (pathspec) {
    const add = gitRun(half.path, ["add", "-A", "--", pathspec]);
    if (!add.ok) run.fail("stage-failed", `git -C ${half.path} add -A -- ${pathspec}: ${add.stderr}`);
  }
  const result = gitRun(half.path, ["commit", "-q", "-F", file, ...(allowEmpty ? ["--allow-empty"] : []), ...(pathspec ? ["--", pathspec] : [])], 300000);
  if (!result.ok) run.fail("commit-failed", `git -C ${half.path} commit: ${result.stderr || result.stdout}; nothing was pushed — fix it and re-send`, { half: half.label });
  const sha = git(half.path, "rev-parse", "HEAD");
  const files = git(half.path, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
  run.act("commit", `${half.label}: ${sha.slice(0, 7)} ${git(half.path, "log", "-1", "--format=%s")}${files.length ? ` (${files.join(", ")})` : ""}`);
  return sha;
}

function writeMessage(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

// The Planner's publish: commit the plan, publish both halves, open the draft PRs.
function planPublish() {
  const { type, slug } = deliveryArgs("plan-publish");
  const run = deliveryRun("plan-publish", type, slug, { commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, companionPr: null });
  const { win, halves } = openDeliveryRun(run, type, slug, `new-${type}`);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  run.out.phase = "validate";
  for (const name of ["plan.md", "roadmap.md"]) {
    if (!fs.existsSync(path.join(artifactHalf.path, win.slugDir, name))) run.reject("artifact-missing", { message: `${win.slugDir}/${name} is missing in the ${artifactHalf.label} half ${artifactHalf.path}; write plan.md and roadmap.md before publishing` });
  }
  const roadmapBranch = header(fs.readFileSync(path.join(artifactHalf.path, win.roadmapRel), "utf8"), "branch");
  if (roadmapBranch !== win.branch) run.reject("branch-mismatch", { message: `${win.roadmapRel} names branch ${JSON.stringify(roadmapBranch)}, but the halves are on ${win.branch}` });
  rejectOutsideSlug(run, win, halves, artifactHalf);

  // Commits: the slug directory in the artifact half; companion mode opens the product branch empty.
  run.out.phase = "commit";
  const messageDir = messageScratch("agento-plan-publish-");
  if (changedPaths(artifactHalf).length) {
    const published = Boolean(git(artifactHalf.path, "ls-tree", "--name-only", "HEAD", "--", `${win.slugDir}/plan.md`));
    const message = published ? `docs(${type}): revise plan ${slug}` : companion ? `docs(${type}): plan ${slug}` : `docs(delivery): plan ${slug}`;
    run.out.commits[artifactHalf.label] = commitHalf(run, artifactHalf, win.slugDir, writeMessage(messageDir, "plan", message));
  }
  if (companion && (Number.parseInt(git(product.path, "rev-list", "--count", `origin/${win.defaultBranch}..HEAD`), 10) || 0) === 0) {
    run.out.commits.product = commitHalf(run, product, null, writeMessage(messageDir, "open", `chore(${type}): open ${slug}`), { allowEmpty: true });
  }
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);

  run.out.integrated = integrateHalves(run, win, halves);
  pushHalves(run, win, halves);
  ensureDeliveryPrs(run, win, { type, slug, commit: (half, pathspec, file) => commitHalf(run, half, pathspec, file), messageDir });
  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-published" });
}

// `--body-file <file|->`: stdin, or a file outside every one of `dirs` (a later `add -A` would commit it).
function readBodyFile(dirs) {
  if (!options.bodyFile) return { text: null, inside: null };
  if (options.bodyFile === "-") return { text: fs.readFileSync(0, "utf8"), inside: null };
  const file = path.resolve(startDir, options.bodyFile);
  const inside = dirs.find((d) => insideDir(file, d)) ?? null;
  if (inside) return { text: null, inside, file };
  if (!fs.existsSync(file)) usage(`--body-file ${file} does not exist`);
  return { text: fs.readFileSync(file, "utf8"), inside: null, file };
}

function ghJson(run, cwd, args, what) {
  const result = ghRun(cwd, args, 30000);
  if (!result.ok) ghFailOf(run)(result, what);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return run.fail("gh-error", `${what} returned non-JSON output`);
  }
}

// The Reviewer's publish: commit review.md, integrate, push, and upsert one verdict comment on the code PR.
function reviewPublish() {
  const { type, slug } = deliveryArgs("review-publish", " [--body-file <file|->]");
  const run = deliveryRun("review-publish", type, slug, { verdict: null, commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, comment: null });
  const { win, halves } = openDeliveryRun(run, type, slug);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  run.out.phase = "validate";
  const body = readBodyFile(halves.map((h) => h.path));
  if (body.inside) run.reject("body-file-inside-half", { message: `${body.file} is inside ${body.inside}, so it would be committed; write it outside both halves or pass --body-file - on stdin` });
  const reviewRel = `${win.slugDir}/review.md`;
  const reviewFile = path.join(artifactHalf.path, reviewRel);
  if (!fs.existsSync(reviewFile)) run.reject("review-missing", { message: `${reviewRel} is missing in the ${artifactHalf.label} half ${artifactHalf.path}; write the review first` });
  const review = fs.readFileSync(reviewFile, "utf8");
  if (!new RegExp(`^# Review: ${escapeRe(slug)}\\s*$`, "m").test(review)) run.reject("review-heading", { message: `${reviewRel} must open with "# Review: ${slug}"` });
  const verdicts = [...review.matchAll(/^Verdict:\s*(.*?)\s*$/gm)].map((m) => m[1]);
  if (verdicts.length !== 1 || !["approve", "request-changes"].includes(verdicts[0])) {
    run.reject("verdict-invalid", { verdicts, message: `${reviewRel} must carry exactly one "Verdict: approve" or "Verdict: request-changes" line; found ${verdicts.length ? verdicts.map((v) => JSON.stringify(v)).join(", ") : "none"}` });
  }
  const verdict = verdicts[0];
  run.out.verdict = verdict;
  rejectOutsideSlug(run, win, halves, artifactHalf);

  // The code PR must exist before anything is written.
  const prResult = ghRun(product.path, ["pr", "view", win.branch, "--json", "number,state,url,isDraft"], 20000);
  if (!prResult.ok && !/no pull requests found/i.test(prResult.stderr)) ghFailOf(run)(prResult, `gh pr view ${win.branch}`);
  const pr = prResult.ok ? JSON.parse(prResult.stdout) : null;
  if (!pr) run.reject("pr-missing", { message: `no pull request for ${win.branch} in the product repository; the Builder opens the draft PR on its first step-commit` });
  if (pr.state !== "OPEN") run.reject("pr-not-open", { message: `PR #${pr.number} for ${win.branch} is ${pr.state.toLowerCase()} (${pr.url}); a review is posted on an open PR only` });
  run.out.pr = { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft), url: pr.url ?? null };

  run.out.phase = "commit";
  const messageDir = messageScratch("agento-review-publish-");
  if (changedPaths(artifactHalf).length) {
    run.out.commits[artifactHalf.label] = commitHalf(run, artifactHalf, win.slugDir, writeMessage(messageDir, "review", `docs(${type}): review ${slug} — ${verdict}`));
  }
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);
  // The reviewed code never changes under the verdict: only the companion half takes its default.
  run.out.integrated = integrateHalves(run, win, halves, { defaultHalves: ["companion"] });
  pushHalves(run, win, halves);

  // One verdict comment per delivery, found by its marker and author; a re-review edits it.
  run.out.phase = "comment";
  const repoField = (cwd, field) => {
    const result = ghRun(cwd, ["repo", "view", "--json", field, "-q", `.${field}`], 15000);
    if (!result.ok) ghFailOf(run)(result, `gh repo view --json ${field} in ${cwd}`);
    return result.stdout;
  };
  const nwo = repoField(product.path, "nameWithOwner");
  const marker = `<!-- agento:review ${type}/${slug} -->`;
  const text = [`Verdict: ${verdict}`, `Review: ${repoField(artifactHalf.path, "url")}/blob/${win.branch}/${reviewRel}`, ...(body.text?.trim() ? [body.text.trim()] : []), marker].join("\n\n");
  const login = ghJson(run, product.path, ["api", "user"], "gh api user").login;
  let existing = null;
  for (let page = 1; !existing; page += 1) {
    const list = ghJson(run, product.path, ["api", `repos/${nwo}/issues/${pr.number}/comments?per_page=100&page=${page}`], `gh api repos/${nwo}/issues/${pr.number}/comments`);
    existing = list.find((c) => c.user?.login === login && (c.body ?? "").includes(marker)) ?? null;
    if (list.length < 100) break;
  }
  if (!existing) {
    const posted = ghJson(run, product.path, ["api", `repos/${nwo}/issues/${pr.number}/comments`, "-X", "POST", "-f", `body=${text}`], `gh api repos/${nwo}/issues/${pr.number}/comments -X POST`);
    run.out.comment = { id: posted.id, url: posted.html_url ?? null, action: "posted" };
    run.act("comment-post", `verdict comment posted on PR #${pr.number} (${verdict})`);
  } else if (existing.body !== text) {
    const edited = ghJson(run, product.path, ["api", `repos/${nwo}/issues/comments/${existing.id}`, "-X", "PATCH", "-f", `body=${text}`], `gh api repos/${nwo}/issues/comments/${existing.id} -X PATCH`);
    run.out.comment = { id: existing.id, url: edited.html_url ?? existing.html_url ?? null, action: "updated" };
    run.act("comment-update", `verdict comment ${existing.id} on PR #${pr.number} updated (${verdict})`);
  } else run.out.comment = { id: existing.id, url: existing.html_url ?? null, action: "unchanged" };

  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-published" });
}


function ghFailOf(run) {
  return (result, what) => {
    if (result.missing || /HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(result.stderr)) run.fail("gh-auth", `${what}: ${result.stderr.split("\n")[0]}`, { reauth: "gh auth login" });
    run.fail("gh-error", `${what}: ${result.stderr.split("\n")[0]}`);
  };
}

// Draft PRs when missing: the code PR, the companion PR, their cross-link, and artifact-pr:.
// `commit(half, pathspec, messageFile)` makes the companion header commit.
function ensureDeliveryPrs(run, win, { type, slug, commit, messageDir }) {
  run.out.phase = "pr";
  const [product, companion = null] = win.halves;
  const artifactHalf = companion ?? product;
  const ghFail = ghFailOf(run);
  const prView = (cwd) => {
    const result = ghRun(cwd, ["pr", "view", win.branch, "--json", "number,state,url,body,isDraft"], 20000);
    if (!result.ok) {
      if (/no pull requests found/i.test(result.stderr)) return null;
      ghFail(result, `gh pr view ${win.branch} in ${cwd}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return run.fail("gh-error", `gh pr view ${win.branch} in ${cwd} returned non-JSON output`);
    }
  };
  const prCreate = (cwd, base, title, body, label) => {
    const result = ghRun(cwd, ["pr", "create", "--draft", "--base", base, "--head", win.branch, "--title", title, "--body", body], 60000);
    if (!result.ok) ghFail(result, `gh pr create --draft --head ${win.branch} in ${cwd}`);
    const created = prView(cwd);
    if (!created) run.fail("gh-error", `gh pr create for ${win.branch} in ${cwd} returned but the PR cannot be looked up`);
    run.act(label, `opened draft PR #${created.number} for ${win.branch} (${created.url})`);
    return created;
  };
  const repoView = (cwd, field) => {
    const result = ghRun(cwd, ["repo", "view", "--json", field, "-q", `.${field}`], 15000);
    if (!result.ok) ghFail(result, `gh repo view --json ${field} in ${cwd}`);
    return result.stdout;
  };
  const roadmapFile = path.join(artifactHalf.path, win.roadmapRel);
  const issueNumber = type === "issue" ? header(fs.readFileSync(roadmapFile, "utf8"), "github-issue").match(/\d+/)?.[0] ?? null : null;
  let pr = prView(product.path);
  if (!pr) {
    const plan = `${win.slugDir}/plan.md`;
    const planLink = companion ? `${repoView(companion.path, "url")}/blob/${win.branch}/${plan}` : plan;
    pr = prCreate(product.path, win.defaultBranch, slug, `${issueNumber ? `Fixes #${issueNumber}\n\n` : ""}Plan: ${planLink}`, "pr-create");
  }
  let companionPr = null;
  if (companion) {
    companionPr = prView(companion.path) ?? prCreate(companion.path, win.defaultBranch, `docs(${type}): ${slug}`, `Delivery artifacts for ${slug}. Code PR: ${pr.url}`, "companion-pr-create");
    if (!(pr.body ?? "").includes(companionPr.url)) {
      const body = `${(pr.body ?? "").replace(/\s+$/, "")}\n\nCompanion PR: ${companionPr.url}`.replace(/^\n+/, "");
      const nwo = repoView(product.path, "nameWithOwner");
      const patch = ghRun(product.path, ["api", `repos/${nwo}/pulls/${pr.number}`, "-X", "PATCH", "-f", `body=${body}`], 20000);
      if (!patch.ok) ghFail(patch, `gh api repos/${nwo}/pulls/${pr.number} -X PATCH`);
      pr.body = body;
      run.act("pr-cross-link", `Companion PR: ${companionPr.url} appended to the body of PR #${pr.number}`);
    }
    const content = fs.readFileSync(roadmapFile, "utf8");
    if (!header(content, "artifact-pr")) {
      const updated = withArtifactPr(content, companionPr.number);
      if (updated === null) run.fail("roadmap-header", `${win.roadmapRel} has no YAML header block to record artifact-pr: in`);
      fs.writeFileSync(roadmapFile, updated);
      const headerMessage = path.join(messageDir, "artifact-pr");
      fs.writeFileSync(headerMessage, `docs(${type}): record artifact PR for ${slug}\n`);
      run.out.commits.companion = commit(run.out.halves.companion, win.roadmapRel, headerMessage);
      pushHalves(run, win, [run.out.halves.companion]);
    }
  }
  const summary = (p) => (p ? { number: p.number, state: p.state, isDraft: Boolean(p.isDraft), url: p.url ?? null } : null);
  run.out.pr = summary(pr);
  run.out.companionPr = summary(companionPr);
  return { pr, companionPr };
}


// --- publish-pr: a changes branch's push → PR → wait → merge → sync --------------

const normalizeRemote = (url) => (url ?? "").trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

function publishPr() {
  if (rest.length) usage(`publish-pr takes no positional arguments, got ${JSON.stringify(rest.join(" "))}`);
  const requested = path.resolve(options.dir ?? startDir);
  const checkout = git(requested, "rev-parse", "--show-toplevel") || null;
  const out = { status: "ok", command: "publish-pr", phase: "checkout", outcome: null, checkout: { path: checkout ?? requested, repo: null, linked: false, defaultBranch: null }, branch: null, merge: Boolean(options.merge), pr: null, mergeSha: null, sync: null, conflicts: [], actions: [], reason: null, message: null, fix: null, reauth: null, next: [], warnings: [], root, configSource: source };
  const finish = (extra = {}) => {
    const result = { ...out, ...extra };
    emit(result, SHIP_EXIT[result.status]);
  };
  const run = {
    out,
    finish,
    reject: (reason, extra = {}) => finish({ status: "rejected", reason, ...extra }),
    fail: (reason, message, extra = {}) => finish({ status: "failed", reason, message, ...extra }),
    act: (step, detail) => out.actions.push({ step, detail }),
  };
  const ghFail = ghFailOf(run);

  // The checkout: the product repository or the configured companion, by origin URL.
  if (!checkout) run.reject("unknown-repo", { message: `${requested} is not a git checkout` });
  const origin = normalizeRemote(originOf(checkout));
  let repo = null;
  if (origin && origin === normalizeRemote(originOf(root))) repo = "product";
  else if (artifacts.external && origin && origin === normalizeRemote(originOf(artifactsRoot))) repo = "companion";
  if (!repo) run.reject("unknown-repo", { message: `${checkout} (origin ${originOf(checkout) ?? "none"}) is a checkout of neither the product repository nor the configured companion` });
  const defaultBranch = config.branches.default;
  const absolute = (p) => path.resolve(checkout, p);
  const linked = absolute(git(checkout, "rev-parse", "--git-dir")) !== absolute(git(checkout, "rev-parse", "--git-common-dir"));
  out.checkout = { path: checkout, repo, linked, defaultBranch };

  // The branch: the current one, or --branch once the checkout is back on the default.
  out.phase = "branch";
  const current = git(checkout, "branch", "--show-current");
  if (!current) run.reject("detached-head", { message: `${checkout} is on a detached HEAD; switch to the branch to publish` });
  let branch = current;
  if (options.branch && options.branch !== current) {
    if (current !== defaultBranch) run.reject("branch-mismatch", { message: `--branch ${options.branch} is not the checked-out ${current}; --branch only resumes from ${defaultBranch} after the merge` });
    if (!gitRun(checkout, ["check-ref-format", "--branch", options.branch]).ok) usage(`--branch ${JSON.stringify(options.branch)} is not a valid branch name`);
    branch = options.branch;
  }
  out.branch = branch;
  if (branch === defaultBranch) run.reject("default-branch", { message: `${checkout} is on ${defaultBranch}; publish-pr never pushes or merges the default branch` });
  const prefix = [config.branches.feature, config.branches.issue, config.branches.postShip].find((p) => p && branch.startsWith(p));
  if (prefix) run.reject("delivery-branch", { message: `${branch} is a delivery branch (${prefix}…); its PR is merged only by /agento ship` });
  const body = readBodyFile([checkout]);
  if (body.inside) run.reject("body-file-inside-checkout", { message: `${body.file} is inside ${checkout}, so a later commit could pick it up; write it outside the checkout or pass --body-file -` });

  // State: fetch, then the branch's PR decides where this send resumes.
  out.phase = "fetch";
  const fetched = fetchOrigin(checkout);
  if (!fetched.ok) {
    if (fetched.auth) run.fail("fetch-auth", fetched.message, { reauth: fetched.reauth });
    run.fail("fetch-failed", `${fetched.message}; nothing was pushed — re-send once origin is reachable`);
  }
  const prLookup = () => {
    const result = ghRun(checkout, ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,mergeable,url,mergeCommit,baseRefName"], 20000);
    if (!result.ok) {
      if (/no pull requests found/i.test(result.stderr)) return null;
      ghFail(result, `gh pr view ${branch} in ${checkout}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return run.fail("gh-error", `gh pr view ${branch} in ${checkout} returned non-JSON output`);
    }
  };
  const defaultRef = `origin/${defaultBranch}`;
  const aheadOfDefault = () => Number.parseInt(git(checkout, "rev-list", "--count", `${defaultRef}..HEAD`), 10) || 0;
  let pr = prLookup();
  if (pr?.state === "CLOSED") run.reject("pr-closed", { pr: prSummary(pr), message: `PR #${pr.number} for ${branch} was closed without a merge (${pr.url}); reopen it or publish from a new branch` });
  if (pr?.state === "MERGED" && current === branch && aheadOfDefault()) run.reject("pr-merged", { pr: prSummary(pr), message: `PR #${pr.number} for ${branch} is already merged, yet ${branch} carries new commits; publish them from a new branch` });
  if (pr?.state !== "MERGED" && current !== branch) run.reject("default-branch", { message: `${checkout} is on ${defaultBranch} and ${branch} has no merged PR to resume; switch to ${branch} first` });

  if (pr?.state !== "MERGED") {
    out.phase = "check";
    const tree = treeState(checkout);
    if (tree?.tracked.length) run.reject("dirty", { paths: tree.tracked, message: `${checkout} has uncommitted tracked changes (${tree.tracked.join(", ")}); commit them first` });
    if (!aheadOfDefault()) run.reject("nothing-to-publish", { message: `${branch} has no commits beyond ${defaultRef}; commit first — publish-pr never opens an empty PR` });

    // push: a full refspec, never forced; -u on the first push.
    out.phase = "push";
    const push = () => {
      const upstream = git(checkout, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
      const remote = git(checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`);
      if (upstream && remote === git(checkout, "rev-parse", "HEAD")) return;
      const result = pushRef(checkout, `refs/heads/${branch}:refs/heads/${branch}`, { setUpstream: !upstream });
      if (!result.ok) run.fail(result.reason, result.message, result.reauth ? { reauth: result.reauth } : {});
      run.act("push", `pushed ${branch} from ${checkout}`);
    };
    push();

    // pr: reuse the open PR, or open one (never a draft).
    out.phase = "pr";
    if (!pr) {
      const title = options.title ?? git(checkout, "log", "--reverse", "--format=%s", `${defaultRef}..HEAD`).split("\n")[0];
      const create = ghRun(checkout, ["pr", "create", "--base", defaultBranch, "--head", branch, "--title", title, "--body", body.text ?? ""], 60000);
      if (!create.ok) ghFail(create, `gh pr create --head ${branch} in ${checkout}`);
      pr = prLookup();
      if (!pr) run.fail("gh-error", `gh pr create for ${branch} in ${checkout} returned but the PR cannot be looked up`);
      run.act("pr-create", `opened PR #${pr.number} for ${branch} (${pr.url})`);
    }
    out.pr = prSummary(pr);
    if (!options.merge) {
      out.phase = "done";
      finish({ outcome: "opened" });
    }

    // checks: a BEHIND PR takes the default by merge (never a rebase), then the bounded wait.
    out.phase = "checks";
    if (pr.mergeStateStatus === "BEHIND" && !isAncestor(checkout, defaultRef, "HEAD")) {
      const merged = mergeRef(checkout, defaultRef);
      if (!merged.ok) {
        const files = merged.conflicts.length ? merged.conflicts.join(", ") : "(no paths reported)";
        run.reject("integration-conflict", { conflicts: merged.conflicts, message: `merging ${defaultRef} into ${branch} at ${checkout} conflicts in ${files} (${merged.stderr || "merge failed"}); the merge was aborted${merged.clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; nothing was merged — resolve it by hand, push, and re-send`, fix: `git -C ${checkout} merge ${defaultRef}` });
      }
      run.act("integrate", `merged ${defaultRef} into ${branch} at ${checkout}`);
      push();
    }
    let repoArg = null;
    if (repo === "companion") {
      const nwo = ghRun(checkout, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
      if (!nwo.ok) ghFail(nwo, `gh repo view --json nameWithOwner in ${checkout}`);
      repoArg = nwo.stdout;
    }
    const checks = waitForChecks("pr", pr.number, checkout, { repo: repoArg, maxSeconds: options.wait ?? 50 });
    const resend = `node <agento-root>/scripts/agento.mjs publish-pr ${process.argv.slice(3).map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`.trim();
    if (checks.code === 2) finish({ status: "pending", message: `PR #${pr.number}: ${checks.last}`, next: [resend] });
    if (checks.code === 1) finish({ status: "blocked", reason: "checks-failed", message: `PR #${pr.number} has a failing required check (${checks.last}); nothing was merged — fix it on ${branch}, push, and re-send` });
    if (checks.code !== 0) run.fail("gh-auth", `wait-for-checks.sh pr ${pr.number}: ${checks.last}`, { reauth: "gh auth login" });

    // merge: a normal merge commit through the ruleset; never --admin, --squash, --rebase, or --auto.
    out.phase = "merge";
    const merge = ghRun(checkout, ["pr", "merge", String(pr.number), "--merge"], 120000);
    if (!merge.ok) ghFail(merge, `gh pr merge ${pr.number} --merge`);
    run.act("merge", `PR #${pr.number} merged into ${defaultBranch} with a merge commit`);
    pr = prLookup() ?? pr;
  }
  out.pr = prSummary(pr);
  out.mergeSha = pr.mergeCommit?.oid ?? null;

  // delete-branch: the remote branch goes once merged; already gone is a warning.
  out.phase = "delete-branch";
  if (gitRun(checkout, ["ls-remote", "--exit-code", "--heads", "origin", branch]).ok) {
    const del = gitRun(checkout, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) run.act("delete-branch", `origin/${branch} deleted`);
    else out.warnings.push(`delete-branch: git push origin --delete ${branch} failed (${del.stderr.split("\n")[0]})`);
  }

  // sync: the default fast-forwarded and the merged branch deleted — except in a linked
  // worktree, which keeps its branch until /agento close-session removes it.
  out.phase = "sync";
  gitRun(checkout, ["fetch", "--prune", "origin"]);
  out.sync = { switched: false, fastForwarded: false, branchDeleted: false, skipped: null };
  if (linked) {
    out.sync.skipped = `linked worktree ${checkout} stays on ${branch}; /agento close-session removes it and deletes the merged branch`;
    out.next = [`/agento close-session ${branch}`];
  } else {
    if (git(checkout, "branch", "--show-current") !== defaultBranch) {
      const sw = gitRun(checkout, ["switch", defaultBranch]);
      if (!sw.ok) run.fail("sync-failed", `git -C ${checkout} switch ${defaultBranch}: ${sw.stderr.split("\n")[0]}; switch by hand, then re-send`);
      out.sync.switched = true;
      run.act("switch", `switched ${checkout} to ${defaultBranch}`);
    }
    const before = git(checkout, "rev-parse", "HEAD");
    const ff = gitRun(checkout, ["merge", "--ff-only", defaultRef], 120000);
    if (!ff.ok) run.fail("sync-failed", `git -C ${checkout} merge --ff-only ${defaultRef}: ${ff.stderr.split("\n")[0]}; reconcile ${defaultBranch} by hand, then re-send`);
    if (git(checkout, "rev-parse", "HEAD") !== before) {
      out.sync.fastForwarded = true;
      run.act("sync", `${defaultBranch} fast-forwarded to ${defaultRef} at ${checkout}`);
    }
    if (git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
      const deletion = gitRun(checkout, ["branch", "-d", branch]);
      if (deletion.ok) {
        out.sync.branchDeleted = true;
        run.act("delete-local-branch", `local ${branch} deleted at ${checkout}`);
      } else out.warnings.push(`delete-local-branch: git branch -d ${branch} failed: ${deletion.stderr.split("\n")[0]}`);
    }
  }
  out.phase = "done";
  finish({ outcome: out.actions.some((a) => a.step === "merge") ? "merged" : "already-merged" });
}

// --- ship ------------------------------------------------------------------

const SHIP_EXIT = { ok: 0, pending: 2, rejected: 3, blocked: 3, failed: 3 };
const SHIP_PR_FIELDS = "number,state,isDraft,mergeStateStatus,mergeable,url,title,body,mergeCommit,baseRefName";
const WAIT_FOR_CHECKS = path.join(PLUGIN_ROOT, "scripts", "wait-for-checks.sh");

// scripts/wait-for-checks.sh in the foreground, bounded by the caller's seconds budget.
function waitForChecks(kind, target, cwd, { repo = null, maxSeconds = 50 } = {}) {
  const args = [WAIT_FOR_CHECKS, kind, String(target), "--max-seconds", String(Math.max(0, maxSeconds)), "--interval", "10", ...(repo ? ["--repo", repo] : [])];
  const result = spawnSync("bash", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter(Boolean);
  return { code: result.status ?? 3, last: lines.at(-1) ?? (result.error?.message ?? "wait-for-checks.sh produced no output") };
}

function shipArgs() {
  const type = requireType(rest[0]);
  const slug = requireSlug(rest[1]);
  if (rest.length > 2) usage(`ship takes exactly <feature|issue> <slug>, got extra ${JSON.stringify(rest.slice(2).join(" "))}`);
  return { type, slug, confirm: options.confirm ?? null, wait: options.wait ?? 50 };
}

// `gh pr view <branch>` with the fields the ship audit and merge need; a merged PR
// is still found by its head branch after the remote branch is deleted.
function shipPrLookup(branch, cwd, label) {
  const result = ghRun(cwd, ["pr", "view", branch, "--json", SHIP_PR_FIELDS], 20000);
  if (!result.ok) return { pr: null, warning: `${label}: gh pr view ${branch} failed: ${result.stderr.split("\n")[0]}` };
  try {
    return { pr: JSON.parse(result.stdout), warning: null };
  } catch {
    return { pr: null, warning: `${label}: gh pr view ${branch} returned non-JSON output` };
  }
}

const prSummary = (pr) => (pr ? { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft), mergeStateStatus: pr.mergeStateStatus ?? null, mergeable: pr.mergeable ?? null, url: pr.url ?? null, mergeCommit: pr.mergeCommit?.oid ?? null } : null);

// GitHub reports a conflict as mergeable CONFLICTING / mergeStateStatus DIRTY; mergeStateStatus is never CONFLICTING.
const isConflicting = (pr) => pr?.mergeable === "CONFLICTING" || pr?.mergeStateStatus === "DIRTY";

const utcDate = () => new Date().toISOString().slice(0, 10);

function ship() {
  const { type, slug, confirm, wait } = shipArgs();
  const startedAt = Date.now();
  const remainingSeconds = () => Math.max(0, wait - Math.floor((Date.now() - startedAt) / 1000));
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const defaultBranch = config.branches.default;
  const shipCommand = (token = null) => `/agento ship ${slug}${token ? ` --confirm ${token}` : ""}`;
  const out = {
    status: "ok",
    type,
    slug,
    branch: deliveryBranch(type, slug),
    mode: "in-repo",
    phase: null,
    resumedAt: null,
    outcome: null,
    audit: null,
    gaps: { hard: [], confirm: [] },
    confirmToken: null,
    rejectTo: null,
    actions: [],
    pr: null,
    companionPr: null,
    mergeSha: null,
    release: null,
    teardown: null,
    postShip: null,
    next: [],
    preflight: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, SHIP_EXIT[result.status]);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });
  const act = (step, detail) => out.actions.push({ step, detail });

  // Window check (§11): the primary checkout.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);

  // Capability preflight (§10): fail rejects, warn proceeds with the fallback.
  const doctor = runDoctor(checksFor(COMMAND_NEEDS.ship));
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) reject(failed.detail, { capability: capabilityOf(failed.id), check: failed.id, fallback: failed.fallback });
  out.preflight = doctor.checks.filter((c) => c.status === "warn").map(({ id, status, detail, fallback }) => ({ id, capability: capabilityOf(id), status, detail, fallback }));

  // --prune, so a remote branch deleted by an earlier call reads as gone.
  const fetched = new Set();
  const fetch = (dir, label) => {
    if (fetched.has(path.resolve(dir))) return;
    fetched.add(path.resolve(dir));
    const result = fetchOrigin(dir);
    if (result.ok) return;
    if (result.auth) fail("fetch-auth", result.message, { reauth: result.reauth });
    out.warnings.push(`fetch: ${label} ${result.url ?? "origin"} not fetched (${result.stderr}); continuing from local refs`);
  };
  fetch(primary, "product");
  if (artifacts.external) fetch(artifactsRoot, "companion");

  // Preflight: the ship-preflight computation in process. After the merge the remote
  // branch is gone and the roadmap lives on the artifact default; resume from there.
  const worktreeList = productWorktreeText({ fresh: true });
  const decided = decideWithLayout(type, slug, (l) =>
    evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot: l.artifactsRoot, currentBranch, git: l.artifactsGit, config: l.config, worktreeList }),
  );
  let preflight = decided.decision;
  const { layout } = decided;
  const external = layout.artifacts.external;
  const artifactsClone = layout.artifactsRoot;
  const artifactDefault = layout.config.branches.default;
  const branch = out.branch;
  let roadmapRel = null;
  if (preflight.status === "ok") {
    const { result } = resolveWithLayout(type, slug);
    roadmapRel = result.source === "local" ? path.relative(layout.artifactsRoot, result.path).split(path.sep).join("/") : result.path;
  } else if (preflight.reason === "no-resolvable-roadmap") {
    roadmapRel = roadmapPathOnRef(layout, `origin/${artifactDefault}`, type, slug);
    if (roadmapRel) {
      const owner = findOwner({ worktrees: parseWorktreeList(worktreeList), worktreesDir: primaryWorktreesDir(), branch, config });
      preflight = { status: "ok", resolutionSource: "default", branch, owner, message: `Roadmap for ${type}/${slug} resolved from origin/${artifactDefault}; the delivery branch is already merged.` };
    }
  }
  if (preflight.status !== "ok") reject(preflight.reason, { message: preflight.message });
  if (external) fetch(artifactsClone, "companion");
  out.mode = external ? "companion" : "in-repo";
  const { owner } = preflight;
  if (owner?.role === "primary") {
    reject("primary-owns-branch", { message: `The primary worktree at ${owner.path} is on ${branch}; return it to ${defaultBranch} first.`, fix: `git switch ${defaultBranch}` });
  }
  const companion = companionOfOwner(owner, layout);
  const ownerTree = ownerTreeOf(owner);
  const companionTree = companionTreeOf(companion);

  // Pull requests: the code PR in the product, the artifact PR inside the companion clone.
  const codeLookup = shipPrLookup(branch, root, "pr");
  if (codeLookup.warning) out.warnings.push(codeLookup.warning);
  const pr = codeLookup.pr;
  let companionPr = null;
  if (external) {
    const lookup = shipPrLookup(branch, artifactsClone, "companionPr");
    if (lookup.warning) out.warnings.push(lookup.warning);
    companionPr = lookup.pr;
  }
  out.pr = prSummary(pr);
  out.companionPr = prSummary(companionPr);
  if (!pr) reject("pr-missing", { message: `no pull request found for ${branch} in the product repository; the Builder opens the draft PR on its first push` });
  if (pr.state === "CLOSED") reject("pr-closed", { message: `pull request #${pr.number} for ${branch} is closed without a merge; reopen it or start the delivery over` });
  out.mergeSha = pr.mergeCommit?.oid ?? null;
  const conflictGap = () => ({ code: "pr-conflicting", detail: `PR #${pr.number} (${pr.url}) conflicts with ${defaultBranch}; resolve it in the build window per the concurrent-delivery hotspot recipes` });
  const companionConflictGap = () => ({ code: "companion-pr-conflicting", detail: `companion PR #${companionPr.number} (${companionPr.url}) conflicts with ${artifactDefault}; resolve it in the companion half` });

  // Artifact reads: the branch while the PR is open, the artifact default once merged.
  const artifactRef = pr.state === "MERGED" ? `origin/${artifactDefault}` : refFor(branch, layout.agit).ref;
  const artifactDir = path.posix.dirname(roadmapRel);
  const readArtifact = (name) => layout.agit("show", `${artifactRef}:${artifactDir}/${name}`) || null;
  const roadmapContent = readArtifact("roadmap.md") ?? "";
  const steps = parseRoadmapSteps(roadmapContent);
  const postShipPending = steps.filter((s) => s.postShip && !s.ticked);
  const behindDefault = (clone, name) => (git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) ? Number.parseInt(git(clone, "rev-list", "--count", `${name}..origin/${name}`), 10) || 0 : 0);

  // Phase derivation from git + GitHub state, never from a journal.
  let phase;
  if (pr.state === "OPEN") phase = header(roadmapContent, "status") === "complete" ? "checks" : "audit";
  else if (external && companionPr?.state === "OPEN") phase = "merge-companion";
  else if (behindDefault(primary, defaultBranch) > 0 || (external && behindDefault(artifactsClone, artifactDefault) > 0)) phase = "sync";
  else if (config.checks?.releaseWorkflow) phase = "release";
  else if (owner) phase = "teardown";
  else if (postShipPending.length) phase = "epilogue";
  else phase = "done";
  out.resumedAt = phase;
  out.phase = phase;
  out.audit = { owner, ownerTree, companion, companionGaps: companionGaps(companion), companionTree, layout: layout.layout, artifactsRoot: artifactsClone, artifactRef, roadmapPath: roadmapRel };

  // Code-side facts shared by the audit and the write phase.
  const pgit = (...args) => git(root, ...args);
  const codeRef = pr.state === "MERGED" ? `origin/${defaultBranch}` : refFor(branch, pgit).ref;
  const versionOf = (ref, file) => pgit("show", `${ref}:${file}`).match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const changelogFacts = () => {
    let from = null;
    let to = null;
    for (const file of [".claude-plugin/plugin.json", "package.json"]) {
      const before = versionOf(`origin/${defaultBranch}`, file);
      const after = versionOf(codeRef, file);
      if (after && after !== before) {
        from = before;
        to = after;
        break;
      }
    }
    const versionChanged = to !== null;
    const heading = pgit("show", `${codeRef}:CHANGELOG.md`).match(/^## (\S+) \(unreleased\)/m)?.[1] ?? null;
    return { versionChanged, from, to, unreleasedHeading: heading, needsStamp: versionChanged && heading !== null, headingWithoutVersionChange: heading !== null && !versionChanged };
  };

  // ---- audit (the PR is open and the confirm writes have not landed) ----
  let acceptedGaps = [];
  let changelog = null;
  if (phase === "audit") {
    const reviewContent = readArtifact("review.md");
    const planContent = readArtifact("plan.md") ?? "";
    const reviewTs = reviewContent === null ? null : Number(layout.agit("log", "-1", "--format=%ct", artifactRef, "--", `${artifactDir}/review.md`)) || null;
    const codeLine = pgit("log", "-1", "--format=%H %ct", codeRef, "--", ".", `:(exclude)${artifactDir}`) || pgit("log", "-1", "--format=%H %ct", codeRef);
    const [codeSha, codeTs] = codeLine ? codeLine.split(" ") : [null, null];
    const iso = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString() : null);
    const review = {
      present: reviewContent !== null,
      verdict: reviewContent?.match(/^Verdict:\s*(approve|request-changes)/m)?.[1] ?? null,
      stale: reviewTs !== null && codeTs !== null && reviewTs < Number(codeTs),
      reviewedAt: iso(reviewTs),
      lastCodeCommit: codeSha ? { sha: codeSha, at: iso(codeTs) } : null,
    };
    const issueNumber = type === "issue" ? header(roadmapContent, "github-issue").match(/\d+/)?.[0] ?? null : null;
    const issue = type === "issue" ? { githubIssue: issueNumber, fixesLine: issueNumber !== null && (pr.body ?? "").includes(`Fixes #${issueNumber}`), resolutionWritten: /^## Resolution\b/m.test(planContent) } : null;
    changelog = changelogFacts();
    const diffFiles = pgit("diff", "--name-only", `origin/${defaultBranch}...${codeRef}`).split("\n").filter(Boolean);
    const postShipSteps = steps.filter((s) => s.postShip);
    const risks = planContent.match(/^## Risks\b[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? "";
    Object.assign(out.audit, {
      roadmap: { status: header(roadmapContent, "status"), unticked: steps.filter((s) => !s.ticked && !s.postShip).map((s) => `${s.id} ${s.text}`), postShip: postShipSteps.map((s) => ({ id: s.id, text: s.text, ticked: s.ticked })) },
      review,
      issue,
      changelog,
      pr: { ...out.pr, title: pr.title ?? null, mergeable: pr.mergeable ?? null },
      companionPr: companionPr ? { ...out.companionPr, title: companionPr.title ?? null, mergeable: companionPr.mergeable ?? null } : null,
      diffFiles,
    });

    // Gap sorting: the two pinned lists; nothing else counts as a gap.
    const hard = [];
    const confirmGaps = [];
    const unticked = out.audit.roadmap.unticked;
    if (unticked.length) hard.push({ code: "unticked-steps", detail: `${unticked.length} unticked step(s) that are not (manual, post-ship): ${steps.filter((s) => !s.ticked && !s.postShip).map((s) => s.id).join(", ")}` });
    if (!review.present) hard.push({ code: "review-missing", detail: `${artifactDir}/review.md is absent on ${artifactRef}` });
    else if (review.verdict === "request-changes") hard.push({ code: "review-request-changes", detail: `${artifactDir}/review.md ends with Verdict: request-changes` });
    else if (review.verdict !== "approve") hard.push({ code: "review-missing", detail: `${artifactDir}/review.md carries no Verdict: approve line` });
    if (review.present && review.stale) hard.push({ code: "review-stale", detail: `review.md (${review.reviewedAt}) is older than the last code commit ${codeSha.slice(0, 7)} (${review.lastCodeCommit.at}) on ${codeRef}` });
    if (owner && ownerTree === null) hard.push({ code: "owner-tree-unreadable", detail: `the owner worktree ${owner.path} could not be read, so it cannot be shown clean` });
    if (ownerTree?.tracked.length) hard.push({ code: "owner-tree-dirty", detail: `uncommitted tracked changes in ${owner.path}: ${ownerTree.tracked.join(", ")}`, paths: ownerTree.tracked });
    if (ownerTree?.ahead > 0) hard.push({ code: "owner-ahead", detail: `${ownerTree.ahead} commit(s) in ${owner.path} are not pushed to origin/${branch}` });
    for (const gap of out.audit.companionGaps) {
      const entry = { code: `companion-${gap}`, detail: companionGapMessage(companion, [gap], type, slug) };
      if (gap === "dirty" && companionTree) entry.paths = [...companionTree.tracked, ...companionTree.untracked];
      hard.push(entry);
    }
    if (external) {
      if (!companionPr) hard.push({ code: "companion-missing-pr", detail: `no pull request for ${branch} in the companion repository at ${artifactsClone}; open it from the companion half` });
      else if (companionPr.state !== "OPEN") hard.push({ code: "companion-pr-not-open", detail: `companion PR #${companionPr.number} is ${companionPr.state.toLowerCase()} (${companionPr.url}); the code PR is still open` });
      else if (isConflicting(companionPr)) hard.push(companionConflictGap());
    }
    if (isConflicting(pr)) hard.push(conflictGap());
    if (changelog.headingWithoutVersionChange) hard.push({ code: "changelog-heading-without-version", detail: `CHANGELOG.md carries "## ${changelog.unreleasedHeading} (unreleased)" but the branch does not change "version" in .claude-plugin/plugin.json or package.json` });
    if (postShipSteps.length && !/post-ship/i.test(risks)) hard.push({ code: "post-ship-unjustified", detail: `${postShipSteps.length} (manual, post-ship) step(s) without a post-ship justification under plan.md ## Risks: ${postShipSteps.map((s) => s.id).join(", ")}` });
    if (ownerTree && !ownerTree.tracked.length && ownerTree.ahead === 0 && ownerTree.untracked.length) {
      confirmGaps.push({ code: "untracked-byproducts", detail: `${ownerTree.untracked.length} untracked file(s) in ${owner.path} will be deleted`, paths: ownerTree.untracked });
    }
    if (changelog.needsStamp) confirmGaps.push({ code: "changelog-unstamped", detail: `CHANGELOG.md "## ${changelog.unreleasedHeading} (unreleased)" will be stamped with today's UTC date in the product` });
    if (pr.mergeStateStatus === "BEHIND") confirmGaps.push({ code: "pr-behind", detail: `PR #${pr.number} is behind ${defaultBranch}; origin/${defaultBranch} will be merged into ${branch} (never rebased)` });
    if (external && companionPr?.mergeStateStatus === "BEHIND") confirmGaps.push({ code: "companion-pr-behind", detail: `companion PR #${companionPr.number} is behind ${artifactDefault}; origin/${artifactDefault} will be merged into the companion half` });
    if (pr.mergeable === "UNKNOWN") out.warnings.push(`pr-mergeable-unknown: GitHub has not computed mergeability for PR #${pr.number} yet; re-send to re-check`);
    if (external && companionPr?.state === "OPEN" && companionPr.mergeable === "UNKNOWN") out.warnings.push(`companion-pr-mergeable-unknown: GitHub has not computed mergeability for companion PR #${companionPr.number} yet; re-send to re-check`);

    out.gaps = { hard, confirm: confirmGaps };
    out.confirmToken = confirmTokenFor({ slug, pr: pr.number, companionPr: companionPr?.number ?? null, confirm: confirmGaps });
    const reviewOnly = hard.length > 0 && hard.every((g) => g.code.startsWith("review-"));
    out.rejectTo = !hard.length ? null : reviewOnly ? { command: `/agento review-${type} ${slug}`, window: "build" } : owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : { command: `/agento start-session ${type}/${slug} --resume`, window: "primary" };
    if (hard.length) reject("audit-gaps", { message: `${hard.length} hard gap(s): ${hard.map((g) => g.code).join(", ")}`, next: [out.rejectTo.command] });

    // Not a gap: an issue PR without its closing keyword gets it, idempotently.
    if (issue && issue.githubIssue && !issue.fixesLine) {
      const nwo = ghRun(root, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
      if (!nwo.ok) fail("gh-error", `gh repo view --json nameWithOwner: ${nwo.stderr}`);
      const body = `${(pr.body ?? "").replace(/\s+$/, "")}\n\nFixes #${issue.githubIssue}`.replace(/^\n+/, "");
      const patch = ghRun(root, ["api", `repos/${nwo.stdout}/pulls/${pr.number}`, "-X", "PATCH", "-f", `body=${body}`], 20000);
      if (!patch.ok) fail("gh-error", `gh api repos/${nwo.stdout}/pulls/${pr.number} -X PATCH: ${patch.stderr}`);
      issue.fixesLine = true;
      act("fixes-line-added", `Fixes #${issue.githubIssue} appended to the body of PR #${pr.number}`);
    }

    if (!confirm) finish({ outcome: "awaiting-confirm", next: [shipCommand()] });
    if (confirm !== out.confirmToken) reject("confirm-stale", { message: `--confirm ${confirm} does not match the recomputed token ${out.confirmToken}; the confirmation gaps changed — present them again`, providedToken: confirm, next: [shipCommand()] });
    acceptedGaps = confirmGaps;
  }

  // Restorations for the no-owner path (the primary or the companion clone switched
  // onto the branch) run on exit, whichever result line ends the call.
  const restores = [];
  process.on("exit", () => {
    for (const restore of restores.reverse()) restore();
  });
  const switchTo = (clone, target, label) => {
    if (git(clone, "branch", "--show-current") === target) return;
    if (git(clone, "status", "--porcelain") !== "") reject("primary-dirty", { message: `${label} checkout ${clone} has uncommitted changes; with no owner worktree the ship writes happen there — commit, stash, or discard them first` });
    const back = git(clone, "branch", "--show-current");
    const sw = gitRun(clone, ["switch", target]);
    if (!sw.ok) fail("switch-failed", `git -C ${clone} switch ${target}: ${sw.stderr}`);
    restores.push(() => gitRun(clone, ["switch", back || layout.config.branches.default]));
  };
  // The §9 receipt data for a rejection that carries `rejectTo`: `allowed` is the
  // primary row for the post-rejection lifecycle (never the unrelated create
  // commands), and `elsewhere` names the exact command and window `rejectTo` gives.
  const receiptForRejectTo = (lifecycle, reason) => {
    out.allowed = deriveAllowed({ role: "primary", lifecycle, delivery: { type, slug } }).allowed;
    out.elsewhere = [{ command: out.rejectTo.command, window: out.rejectTo.window, reason }];
  };
  const integrate = (dir, defaultRef, label) => {
    const merge = mergeRef(dir, defaultRef);
    if (merge.ok) {
      if (merge.merged) act("integrate", `${label}: merged ${defaultRef} into ${branch} at ${dir}`);
      return;
    }
    const { clean, conflicts } = merge;
    out.rejectTo = owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : { command: `/agento start-session ${type}/${slug} --resume`, window: "primary" };
    receiptForRejectTo("in-review", `merging ${defaultRef} into ${branch} conflicted; resolve it in the build window`);
    reject("integration-conflict", { message: `merging ${defaultRef} into ${branch} at ${dir} conflicts (${merge.stderr}); the merge was aborted${clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; resolve it in the build window`, conflicts, next: [out.rejectTo.command] });
  };
  const push = (dir, label, refspec = branch) => {
    const result = pushRef(dir, refspec);
    if (!result.ok) fail(result.reason, result.message, result.reauth ? { reauth: result.reauth } : {});
    act("push", `${label}: pushed ${refspec} from ${dir}`);
  };
  const nameWithOwner = (cwd) => {
    const result = ghRun(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
    if (!result.ok) fail("gh-error", `gh repo view --json nameWithOwner in ${cwd}: ${result.stderr}`);
    return result.stdout;
  };
  const waitChecks = (kind, target, cwd, opts = {}) => waitForChecks(kind, target, cwd, { ...opts, maxSeconds: remainingSeconds() });
  const pending = (atPhase, message) => finish({ status: "pending", phase: atPhase, message, next: [shipCommand(atPhase === "checks" ? confirm : null)] });
  const ghFailure = (result, what) => {
    if (result.missing || /HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(result.stderr)) fail("gh-auth", `${what}: ${result.stderr.split("\n")[0]}`, { reauth: "gh auth login" });
    fail("gh-error", `${what}: ${result.stderr.split("\n")[0]}`);
  };
  // Reopen at checks: the roadmap goes back to in-progress on origin/<branch>, so the
  // build window routes to the Builder and the next ship send re-audits after a fix.
  const reopenStepText = (code) => {
    switch (code) {
      case "pr-conflicting":
        return `Merge \`origin/${defaultBranch}\` into \`${branch}\` with \`agento.mjs sync\` and resolve the conflict per the concurrent-delivery hotspot recipes — verify: \`sync\` reports no \`integration-conflict\`; \`gh pr view ${pr.number} --json mergeable,mergeStateStatus\` is not CONFLICTING/DIRTY; the full test command passes`;
      case "companion-pr-conflicting":
        return `Merge \`origin/${artifactDefault}\` into the companion half with \`agento.mjs sync\` and resolve the conflict per the concurrent-delivery hotspot recipes — verify: \`sync\` reports no \`integration-conflict\`; \`gh pr view ${companionPr.number} --json mergeable,mergeStateStatus\` is not CONFLICTING/DIRTY`;
      case "checks-failed":
        return `Fix the failing required check — verify: \`scripts/wait-for-checks.sh pr ${pr.number}\` succeeds`;
      default:
        return null;
    }
  };
  const reopen = (codes) => {
    const target = !external ? (owner ? owner.path : primary) : companion?.registered ? companion.path : artifactsClone;
    if (target === primary || target === artifactsClone) switchTo(target, branch, external ? "companion" : "primary");
    const ref = `origin/${branch}`;
    if (git(target, "rev-parse", "--verify", "--quiet", ref)) {
      const ff = gitRun(target, ["merge", "--ff-only", ref]);
      if (!ff.ok) fail("owner-diverged", `${target} cannot fast-forward to ${ref} to reopen the roadmap: ${ff.stderr.split("\n")[0]}; reconcile it in the build window`);
    }
    const roadmapFile = path.join(target, roadmapRel);
    const current = fs.readFileSync(roadmapFile, "utf8");
    const stepText = Object.fromEntries(codes.map((code) => [code, reopenStepText(code)]).filter(([, text]) => text));
    const reopened = reopenRoadmap(current, { date: utcDate(), codes, stepText });
    if (reopened !== current) {
      fs.writeFileSync(roadmapFile, reopened);
      gitRun(target, ["add", "--", roadmapRel]);
      const commit = gitRun(target, ["commit", "-q", "-m", `docs(${type}): reopen ${slug} (${codes.join(", ")})`]);
      if (!commit.ok) fail("commit-failed", `git -C ${target} commit (roadmap reopen): ${commit.stderr}`);
    }
    if (git(target, "rev-parse", "HEAD") !== git(target, "rev-parse", ref)) push(target, external ? "companion" : "product");
    for (const restore of restores.splice(0)) restore();
    act("roadmap-reopened", `roadmap status: in-progress (${codes.join(", ")}) on origin/${branch} from ${target}`);
    out.rejectTo = owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : { command: `/agento start-session ${type}/${slug} --resume`, window: "primary" };
    receiptForRejectTo("building", "ship reopened the roadmap to in-progress; resolve the reopen step in the build window, then re-review");
  };
  const rejectReopened = (hard) => {
    out.gaps = { hard, confirm: [] };
    reject("audit-gaps", { message: `${hard.length} hard gap(s) at checks: ${hard.map((g) => g.code).join(", ")}; the roadmap was reopened to in-progress`, next: [out.rejectTo.command] });
  };
  // A policy-blocked merge is the base branch policy (a required status check never
  // reported, or required reviews unresolved), never a conflict: wait within the
  // grace for the missing required checks, then stop `blocked` / `merge-blocked`
  // without reopening the roadmap or invalidating the review.
  const headCommitAge = () => {
    const ts = Number(pgit("log", "-1", "--format=%ct", codeRef));
    return Number.isFinite(ts) ? Math.floor(Date.now() / 1000) - ts : Infinity;
  };
  const readPrState = () => {
    const result = ghRun(root, ["pr", "view", branch, "--json", "statusCheckRollup,mergeStateStatus"], 20000);
    if (!result.ok) return { mergeStateStatus: pr.mergeStateStatus, rollup: [] };
    try {
      const json = JSON.parse(result.stdout);
      return { mergeStateStatus: json.mergeStateStatus ?? pr.mergeStateStatus, rollup: json.statusCheckRollup ?? [] };
    } catch {
      return { mergeStateStatus: pr.mergeStateStatus, rollup: [] };
    }
  };
  const blockedMerge = (rollup = null, refusalStderr = null) => {
    const contexts = ghRequiredContexts(root, nameWithOwner(root), defaultBranch);
    const required = requiredContexts(contexts.rules, contexts.protection);
    const { absent, pending: pendingList, failed } = missingRequired(required, rollup ?? readPrState().rollup);
    const missing = [...absent, ...pendingList];
    if (missing.length && headCommitAge() <= 600) {
      pending("checks", `PR #${pr.number} is blocked by the base branch policy; waiting for required check(s) to report: ${missing.join(", ")}`);
    }
    if (missing.length) {
      finish({ status: "blocked", reason: "merge-blocked", message: `PR #${pr.number} is blocked by the base branch policy: required check(s) ${missing.join(", ")} have not reported${failed.length ? ` and ${failed.join(", ")} failed` : ""}. Re-trigger them, then re-send /agento ship ${slug}`, next: [shipCommand()] });
    }
    if (failed.length) {
      finish({ status: "blocked", reason: "merge-blocked", message: `PR #${pr.number} is blocked by the base branch policy: required check(s) ${failed.join(", ")} failed. Fix them, then re-send /agento ship ${slug}`, next: [shipCommand()] });
    }
    if (!contexts.known) {
      const refusal = refusalStderr ? ` (gh: ${refusalStderr.split("\n")[0]})` : "";
      finish({ status: "blocked", reason: "merge-blocked", message: `PR #${pr.number} is blocked by the base branch policy; the required status checks could not be read from the ruleset/protection endpoints${refusal}. Resolve the policy requirements, then re-send /agento ship ${slug}`, next: [shipCommand()] });
    }
    finish({ status: "blocked", reason: "merge-blocked", message: `PR #${pr.number} is blocked by the base branch policy (required reviews or conversation resolution); nothing was reopened. Resolve the policy requirements, then re-send /agento ship ${slug}`, next: [shipCommand()] });
  };
  let shippedHere = false;

  // ---- confirm → checks → merge-code (the PR is still open) ----
  if (phase === "audit" || phase === "checks") {
    // A conflict found after the confirm writes landed: reopen before anything else is written.
    if (phase === "checks") {
      const hard = [...(isConflicting(pr) ? [conflictGap()] : []), ...(external && isConflicting(companionPr) ? [companionConflictGap()] : [])];
      if (hard.length) {
        reopen(hard.map((g) => g.code));
        rejectReopened(hard);
      }
    }
    const accepted = new Set(acceptedGaps.map((g) => g.code));
    const productTarget = owner ? owner.path : primary;
    const artifactTarget = !external ? productTarget : companion?.registered ? companion.path : artifactsClone;
    if (!owner) switchTo(primary, branch, "primary");
    if (external && !companion?.registered) switchTo(artifactsClone, branch, "companion");

    if (phase === "audit") {
      out.phase = "confirm";
      // Untracked byproducts first: exactly the listed paths, literal, never -d or -x.
      const byproducts = acceptedGaps.find((g) => g.code === "untracked-byproducts");
      if (byproducts) {
        const clean = gitRun(owner.path, ["--literal-pathspecs", "clean", "-f", "--", ...byproducts.paths]);
        if (!clean.ok) fail("clean-failed", `git -C ${owner.path} --literal-pathspecs clean -f -- …: ${clean.stderr}`);
        act("clean", `removed ${byproducts.paths.length} untracked file(s) from ${owner.path}: ${byproducts.paths.join(", ")}`);
        const after = treeState(owner.path);
        if (!after || after.tracked.length || after.untracked.length || after.ahead !== 0) {
          reject("owner-tree-changed", { message: `${owner.path} is not clean after the byproduct cleanup (tracked: ${after?.tracked.join(", ") || "none"}; untracked: ${after?.untracked.join(", ") || "none"}; ahead: ${after?.ahead ?? "?"}); nothing else was written`, ownerTreeAfter: after });
        }
      }
    }

    // The write targets sit at origin/<branch> (owners are never ahead here); then the accepted integrations.
    for (const [dir, ref, label] of [[productTarget, `origin/${branch}`, "product"], ...(external ? [[artifactTarget, `origin/${branch}`, "companion"]] : [])]) {
      if (!git(dir, "rev-parse", "--verify", "--quiet", ref)) continue;
      const ff = gitRun(dir, ["merge", "--ff-only", ref]);
      if (!ff.ok) reject("owner-diverged", { message: `${label} checkout ${dir} cannot fast-forward to ${ref}: ${ff.stderr.split("\n")[0]}; reconcile it in the build window` });
    }
    const behindNow = phase === "checks" && pr.mergeStateStatus === "BEHIND";
    if (accepted.has("pr-behind") || behindNow) integrate(productTarget, `origin/${defaultBranch}`, "product");
    if (external && (accepted.has("companion-pr-behind") || (phase === "checks" && companionPr?.mergeStateStatus === "BEHIND"))) integrate(artifactTarget, `origin/${artifactDefault}`, "companion");

    const today = utcDate();
    if (phase === "audit") {
      // Roadmap: status complete, the accepted gaps as Follow-ups; one artifact commit.
      const roadmapFile = path.join(artifactTarget, roadmapRel);
      fs.writeFileSync(roadmapFile, completeRoadmap(fs.readFileSync(roadmapFile, "utf8"), { date: today, followups: acceptedGaps }));
      gitRun(artifactTarget, ["add", "--", roadmapRel]);
      const commit = gitRun(artifactTarget, ["commit", "-q", "-m", `docs(${type}): ship ${slug}`]);
      if (!commit.ok) fail("commit-failed", `git -C ${artifactTarget} commit (roadmap): ${commit.stderr}`);
      act("roadmap-complete", `roadmap status: complete${acceptedGaps.length ? ` with ${acceptedGaps.length} accepted gap(s) under ## Follow-ups (accepted at ship)` : ""} committed at ${artifactTarget}`);
      if (changelog.needsStamp) stampChangelog(productTarget, changelog.unreleasedHeading, today, act);
    } else {
      // Resume on a later UTC date: refresh a stamp older than today before the merge.
      const facts = changelogFacts();
      const stamped = pgit("show", `${codeRef}:CHANGELOG.md`).match(/^## (\S+) \((\d{4}-\d{2}-\d{2})\)/m);
      if (facts.versionChanged && stamped && stamped[1] === facts.to && stamped[2] !== today) stampChangelog(productTarget, facts.to, today, act, stamped[2]);
    }

    // Push product first, then companion, so the tick never precedes its code.
    if (git(productTarget, "rev-parse", "HEAD") !== pgit("rev-parse", `origin/${branch}`)) push(productTarget, "product");
    if (external && git(artifactTarget, "rev-parse", "HEAD") !== layout.agit("rev-parse", `origin/${branch}`)) push(artifactTarget, "companion");
    for (const restore of restores.splice(0)) restore();

    // Ready, wait, merge — the code PR first; the companion PR is readied now and merged after.
    out.phase = "checks";
    if (pr.isDraft) {
      const ready = ghRun(root, ["pr", "ready", String(pr.number)], 30000);
      if (!ready.ok) ghFailure(ready, `gh pr ready ${pr.number}`);
      act("pr-ready", `PR #${pr.number} marked ready for review`);
    }
    if (external && companionPr?.isDraft) {
      const ready = ghRun(artifactsClone, ["pr", "ready", String(companionPr.number)], 30000);
      if (!ready.ok) ghFailure(ready, `gh pr ready ${companionPr.number} (companion)`);
      companionPr.isDraft = false;
      act("companion-pr-ready", `companion PR #${companionPr.number} marked ready for review`);
    }
    const checks = waitChecks("pr", pr.number, root);
    if (checks.code === 2) pending("checks", `PR #${pr.number}: ${checks.last}`);
    if (checks.code === 1) {
      reopen(["checks-failed"]);
      fail("checks-failed", `PR #${pr.number} has a failing required check (${checks.last}); the roadmap was reopened to in-progress — fix it in the build window, then re-review and re-send`, { rejectTo: out.rejectTo });
    }
    if (checks.code !== 0) fail("gh-auth", `wait-for-checks.sh pr ${pr.number}: ${checks.last}`, { reauth: "gh auth login" });

    // A BLOCKED PR after green checks is the base branch policy (a required status
    // check never reported), not a conflict: wait within the grace, then report
    // `merge-blocked` without reopening.
    if (readPrState().mergeStateStatus === "BLOCKED") blockedMerge();

    out.phase = "merge-code";
    const merge = ghRun(root, ["pr", "merge", String(pr.number), "--merge"], 120000);
    if (!merge.ok) {
      const refusal = classifyMergeRefusal(merge.stderr, pr.mergeStateStatus);
      if (refusal === "blocked") blockedMerge(null, merge.stderr);
      if (refusal === "behind") {
        integrate(productTarget, `origin/${defaultBranch}`, "product");
        pending("merge-code", `PR #${pr.number} is behind ${defaultBranch}; origin/${defaultBranch} was merged into ${branch} — re-send /agento ship ${slug} to merge`);
      }
      if (refusal === "conflict") {
        reopen(["pr-conflicting"]);
        rejectReopened([conflictGap()]);
      }
      ghFailure(merge, `gh pr merge ${pr.number} --merge`);
    }
    act("merge-code", `PR #${pr.number} merged into ${defaultBranch} with a merge commit`);
    shippedHere = true;
    const del = gitRun(primary, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) act("delete-branch", `origin/${branch} deleted from the product`);
    else out.warnings.push(`delete-branch: git push origin --delete ${branch} failed (${del.stderr.split("\n")[0]}); the remote branch may already be gone`);
    gitRun(primary, ["fetch", "--prune", "origin"]);
    const merged = shipPrLookup(branch, root, "pr");
    if (merged.pr) {
      out.pr = prSummary(merged.pr);
      out.mergeSha = merged.pr.mergeCommit?.oid ?? null;
    }
  }

  // ---- merge-companion (companion mode; the resume point of the half-shipped case) ----
  if (external && companionPr?.state === "OPEN") {
    out.phase = "merge-companion";
    const halfShipped = `code PR #${pr.number} merged, companion PR #${companionPr.number} open at ${companionPr.url}; re-send /agento ship ${slug} to resume at the companion merge`;
    const companionFail = (detail) => fail("companion-merge", halfShipped, { detail });
    if (companionPr.isDraft) {
      const ready = ghRun(artifactsClone, ["pr", "ready", String(companionPr.number)], 30000);
      if (!ready.ok) companionFail(`gh pr ready ${companionPr.number}: ${ready.stderr}`);
      act("companion-pr-ready", `companion PR #${companionPr.number} marked ready for review`);
    }
    const checks = waitChecks("pr", companionPr.number, artifactsClone, { repo: nameWithOwner(artifactsClone) });
    if (checks.code === 2) pending("merge-companion", `companion PR #${companionPr.number}: ${checks.last}`);
    if (checks.code !== 0) companionFail(`wait-for-checks.sh pr ${companionPr.number}: ${checks.last}`);
    const merge = ghRun(artifactsClone, ["pr", "merge", String(companionPr.number), "--merge"], 120000);
    if (!merge.ok) companionFail(`gh pr merge ${companionPr.number} --merge: ${merge.stderr}`);
    act("merge-companion", `companion PR #${companionPr.number} merged into ${artifactDefault} with a merge commit`);
    shippedHere = true;
    const del = gitRun(artifactsClone, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) act("companion-delete-branch", `origin/${branch} deleted from the companion`);
    else out.warnings.push(`companion-delete-branch: git -C ${artifactsClone} push origin --delete ${branch} failed (${del.stderr.split("\n")[0]}); the remote branch may already be gone`);
    gitRun(artifactsClone, ["fetch", "--prune", "origin"]);
    const merged = shipPrLookup(branch, artifactsClone, "companionPr");
    if (merged.pr) out.companionPr = prSummary(merged.pr);
  }

  // ---- sync: both defaults fast-forwarded to their origin ----
  out.phase = "sync";
  const postBranch = `${config.branches.postShip}${slug}`;
  const syncDefault = (clone, name, label, { keepPostShip = true } = {}) => {
    gitRun(clone, ["fetch", "--prune", "origin"]);
    const current = git(clone, "branch", "--show-current");
    if (current !== name) {
      // The epilogue works on post-ship/<slug> in this checkout: update the default in place.
      if (keepPostShip && current === postBranch && postShipPending.length) {
        const before = git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
        const ff = gitRun(clone, ["fetch", "origin", `${name}:${name}`], 120000);
        if (!ff.ok) fail("sync-failed", `git -C ${clone} fetch origin ${name}:${name}: ${ff.stderr.split("\n")[0]}; reconcile ${name} by hand, then re-send`);
        if (git(clone, "rev-parse", name) !== before) act("sync", `${label}: ${name} fast-forwarded to origin/${name} at ${clone} (kept on ${postBranch})`);
        return;
      }
      if (git(clone, "status", "--porcelain") !== "") {
        out.warnings.push(`sync: ${label} checkout ${clone} is on ${current || "a detached HEAD"} with uncommitted changes; ${name} was not fast-forwarded`);
        return;
      }
      const sw = gitRun(clone, ["switch", name]);
      if (!sw.ok) fail("sync-failed", `git -C ${clone} switch ${name}: ${sw.stderr}`);
      act("switch", `${label}: switched ${clone} to ${name}`);
    }
    const before = git(clone, "rev-parse", "HEAD");
    const ff = gitRun(clone, ["merge", "--ff-only", `origin/${name}`], 120000);
    if (!ff.ok) fail("sync-failed", `git -C ${clone} merge --ff-only origin/${name}: ${ff.stderr.split("\n")[0]}; reconcile ${name} by hand, then re-send`);
    if (git(clone, "rev-parse", "HEAD") !== before) act("sync", `${label}: ${name} fast-forwarded to origin/${name} at ${clone}`);
    const ahead = Number.parseInt(git(clone, "rev-list", "--count", `origin/${name}..HEAD`), 10) || 0;
    if (ahead || git(clone, "status", "--porcelain") !== "") out.warnings.push(`sync: ${label} ${name} at ${clone} is ${ahead ? `${ahead} commit(s) ahead of origin/${name}` : "not clean"} after the fast-forward`);
  };
  syncDefault(primary, defaultBranch, "product");
  if (external) syncDefault(artifactsClone, artifactDefault, "companion");
  // No owner: the local branch the writes used (or an earlier session left) goes once merged.
  if (!owner) {
    for (const [clone, defaultRef, label] of [[primary, `origin/${defaultBranch}`, "product"], ...(external ? [[artifactsClone, `origin/${artifactDefault}`, "companion"]] : [])]) {
      const verdict = branchVerdict(clone, parseWorktreeList(git(clone, "worktree", "list", "--porcelain")), branch, defaultRef);
      if (verdict.action !== "deleted") continue;
      const deletion = gitRun(clone, ["branch", "-d", branch]);
      if (deletion.ok) act("delete-local-branch", `${label}: local ${branch} deleted at ${clone} (${verdict.reason})`);
      else out.warnings.push(`delete-local-branch: git -C ${clone} branch -d ${branch} failed: ${deletion.stderr.split("\n")[0]}`);
    }
  }

  // ---- release: the deploy verdict for the merge commit, bounded by the remaining budget ----
  if (config.checks?.releaseWorkflow) {
    out.phase = "release";
    const workflow = config.checks.releaseWorkflow;
    if (!out.mergeSha) {
      const fresh = shipPrLookup(branch, root, "pr");
      out.mergeSha = fresh.pr?.mergeCommit?.oid ?? null;
    }
    if (!out.mergeSha) fail("release-no-merge-sha", `PR #${pr.number} reports no merge commit yet; re-send in a moment`);
    const short = out.mergeSha.slice(0, 7);
    const { fields } = releaseVerdict(out.mergeSha, { wait: remainingSeconds(), interval: 10 });
    out.release = { verdict: fields.verdict, workflow, run: fields.run, supersededBy: fields.supersededBy, reason: fields.reason ?? null, mergeDate: fields.mergeDate ?? null, dispatched: false };
    if (fields.status === "error") {
      if (fields.reason === "gh-missing" || fields.reason === "auth") fail("gh-auth", fields.message, { reauth: "gh auth login" });
      fail("gh-error", fields.message);
    }
    if (fields.verdict === "pending") pending("release", `release ${workflow} for ${short}: ${fields.reason ?? "run in progress"}`);
    if (fields.verdict === "dispatch-required") {
      // Follow a dispatch run created after the merge; otherwise dispatch exactly once and let the re-send find it.
      const list = ghRun(root, ["run", "list", "--workflow", workflow, "--event", "workflow_dispatch", "--json", "databaseId,createdAt,url,status,conclusion", "--limit", "20"], 30000);
      if (!list.ok) ghFailure(list, `gh run list --workflow ${workflow} --event workflow_dispatch`);
      let runs = [];
      try {
        runs = JSON.parse(list.stdout || "[]");
      } catch {
        fail("gh-error", `gh run list --workflow ${workflow} returned non-JSON output`);
      }
      const run = runs.filter((r) => fields.mergeDate && r.createdAt > fields.mergeDate).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
      if (!run) {
        const dispatch = ghRun(root, ["workflow", "run", workflow, "--ref", defaultBranch], 30000);
        if (!dispatch.ok) ghFailure(dispatch, `gh workflow run ${workflow} --ref ${defaultBranch}`);
        out.release.dispatched = true;
        act("release-dispatch", `gh workflow run ${workflow} --ref ${defaultBranch} (no workflow_dispatch run after ${fields.mergeDate})`);
        pending("release", `release ${workflow} dispatched for ${short}; the re-send follows the run it created`);
      }
      out.release.run = { id: run.databaseId, event: "workflow_dispatch", status: run.status ?? null, conclusion: run.conclusion ?? null, url: run.url ?? null, headSha: null };
      if (run.status !== "completed") {
        const follow = waitChecks("run", run.databaseId, root);
        if (follow.code === 2) pending("release", `release run ${run.url ?? run.databaseId}: ${follow.last}`);
        if (follow.code === 1) fail("release-failed", `release run ${run.url ?? run.databaseId} failed: ${follow.last}`);
        if (follow.code !== 0) fail("gh-auth", `wait-for-checks.sh run ${run.databaseId}: ${follow.last}`, { reauth: "gh auth login" });
        Object.assign(out.release.run, { status: "completed", conclusion: "success" });
      } else if (run.conclusion !== "success") fail("release-failed", `release run ${run.url ?? run.databaseId} concluded ${run.conclusion}`);
      out.release.verdict = "success";
    }
    if (fields.verdict === "failed" || fields.verdict === "no-run") {
      fail(`release-${fields.verdict}`, `release ${workflow} for ${short}: ${fields.verdict}${fields.reason ? ` (${fields.reason})` : ""}${fields.run?.url ? ` — ${fields.run.url}` : ""}; re-sending re-derives the verdict, never a second release`);
    }
    act("release", `${workflow} for ${short}: ${out.release.verdict}${out.release.run?.url ? ` (${out.release.run.url})` : ""}${out.release.supersededBy?.url ? `, superseded by ${out.release.supersededBy.url}` : ""}`);
  }

  // ---- teardown: the owner's halves, workspace file, and merged local branches ----
  if (owner) {
    out.phase = "teardown";
    const productList = productWorktrees({ fresh: true });
    const companionList = external ? parseWorktreeList(git(artifactsClone, "worktree", "list", "--porcelain")) : [];
    const resolved = resolveSessionPaths(owner.dirPrefix, owner.id, layout);
    const inspect = (halfPath, list) => {
      const entry = registeredAt(list, halfPath);
      return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, registered: Boolean(entry), onDisk: fs.existsSync(halfPath), removed: false };
    };
    const halves = [{ label: "product", half: inspect(owner.path, productList), clone: primary }];
    if (external) halves.push({ label: "companion", half: inspect(companion?.path ?? resolved.companion.worktree, companionList), clone: artifactsClone });
    const workspace = resolved.workspace ? { path: resolved.workspace, existed: fs.existsSync(resolved.workspace), removed: false } : null;
    const branches = {
      product: branchVerdict(primary, productList, branch, `origin/${defaultBranch}`, halves[0].half.path),
      companion: external ? branchVerdict(artifactsClone, companionList, branch, `origin/${artifactDefault}`, halves[1].half.path) : null,
    };
    const removal = removeSessionPair({ halves, workspace, branches });
    out.teardown = { product: removal.product, companion: removal.companion, workspace, branches, occupants: removal.occupants, pausedPath: null };
    if (removal.status === "blocked") {
      const flagged = halves.find((h) => h.label === removal.half).half.path;
      out.teardown.pausedPath = flagged;
      const summary = halves.filter((h) => removal.occupants[h.label].length).map((h) => `${h.label} half ${h.half.path}: ${removal.occupants[h.label].join(", ")}`).join("; ");
      finish({ status: "blocked", reason: "occupied", outcome: "paused-teardown", message: `paused at teardown (worktree ${flagged} still open): ${summary}; close that VS Code window or terminal, then re-send /agento ship ${slug}`, next: [shipCommand()] });
    }
    if (removal.status === "failed") fail(removal.reason, removal.message, { half: removal.half });
    const removed = halves.filter((h) => h.half.removed).map((h) => h.half.path);
    act("teardown", `removed ${removed.length ? removed.join(", ") : "no registered half"}${workspace?.removed ? ` and ${workspace.path}` : ""}; branches: product ${branches.product.action}${branches.companion ? `, companion ${branches.companion.action}` : ""}`);
    shippedHere = true;
  }

  // ---- epilogue: (manual, post-ship) steps land from a post-ship branch of the artifact checkout ----
  if (postShipPending.length) {
    out.phase = "epilogue";
    const checkout = external ? artifactsClone : primary;
    const label = external ? "companion" : "product";
    gitRun(checkout, ["fetch", "--prune", "origin"]);
    if (git(checkout, "branch", "--show-current") !== postBranch) {
      if (git(checkout, "status", "--porcelain") !== "") {
        reject("primary-dirty", { message: `${label} checkout ${checkout} has uncommitted changes; the post-ship evidence lands from ${postBranch} there — commit, stash, or discard them first` });
      }
      const exists = git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${postBranch}`);
      const sw = exists ? gitRun(checkout, ["switch", postBranch]) : gitRun(checkout, ["switch", "-c", postBranch, "--no-track", `origin/${artifactDefault}`]);
      if (!sw.ok) fail("switch-failed", `git -C ${checkout} switch ${exists ? "" : "-c "}${postBranch}: ${sw.stderr}`);
      act(exists ? "switch" : "post-ship-branch", exists ? `${label}: switched ${checkout} to ${postBranch}` : `${label}: created ${postBranch} from origin/${artifactDefault} at ${checkout}`);
    }
    const roadmapFile = path.join(checkout, roadmapRel);
    const working = fs.existsSync(roadmapFile) ? fs.readFileSync(roadmapFile, "utf8") : roadmapContent;
    const evidenceOf = (text) => text.match(/\((evidence\/[^)\s]+)\)/)?.[1] ?? text.match(/\bevidence\/[^\s)]+/)?.[0] ?? null;
    const postSteps = parseRoadmapSteps(working).filter((s) => s.postShip).map((s) => {
      const evidence = evidenceOf(s.text);
      return { id: s.id, text: s.text, ticked: s.ticked, evidence, evidencePresent: evidence !== null && fs.existsSync(path.join(checkout, artifactDir, evidence)) };
    });
    const existing = shipPrLookup(postBranch, checkout, "postShipPr");
    let postPr = existing.pr?.state === "OPEN" ? existing.pr : null;
    out.postShip = { branch: postBranch, path: checkout, steps: postSteps, pr: prSummary(postPr) };
    const remaining = postSteps.filter((s) => !s.ticked || !s.evidencePresent);
    if (!postSteps.length || remaining.length) {
      finish({ outcome: "post-ship-pending", message: `${remaining.length} (manual, post-ship) step(s) await a tick with a linked evidence file under ${checkout}/${artifactDir}/evidence/: ${remaining.map((s) => s.id).join(", ")}`, next: [shipCommand()] });
    }
    if (git(checkout, "status", "--porcelain") !== "") {
      gitRun(checkout, ["add", "--", artifactDir]);
      const commit = gitRun(checkout, ["commit", "-q", "-m", `docs(post-ship): ${slug} evidence`]);
      if (!commit.ok) fail("commit-failed", `git -C ${checkout} commit (post-ship evidence): ${commit.stderr}`);
      act("post-ship-commit", `evidence and roadmap ticks committed on ${postBranch} at ${checkout}`);
    }
    if (git(checkout, "rev-parse", "HEAD") !== git(checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${postBranch}`)) push(checkout, label, postBranch);
    if (!postPr) {
      const create = ghRun(checkout, ["pr", "create", "--base", artifactDefault, "--head", postBranch, "--title", `docs(post-ship): ${slug} evidence`, "--body", `Post-ship evidence for ${type}/${slug}: ${postSteps.map((s) => s.id).join(", ")}.`], 60000);
      if (!create.ok) ghFailure(create, `gh pr create --head ${postBranch}`);
      postPr = shipPrLookup(postBranch, checkout, "postShipPr").pr;
      if (!postPr) fail("gh-error", `gh pr create for ${postBranch} returned but the PR cannot be looked up`);
      act("post-ship-pr", `opened PR #${postPr.number} for ${postBranch} (${postPr.url})`);
    }
    out.postShip.pr = prSummary(postPr);
    const checks = waitChecks("pr", postPr.number, checkout, external ? { repo: nameWithOwner(checkout) } : {});
    if (checks.code === 2) pending("epilogue", `post-ship PR #${postPr.number}: ${checks.last}`);
    if (checks.code === 1) fail("post-ship-checks-failed", `post-ship PR #${postPr.number} has a failing required check (${checks.last})`);
    if (checks.code !== 0) fail("gh-auth", `wait-for-checks.sh pr ${postPr.number}: ${checks.last}`, { reauth: "gh auth login" });
    const merge = ghRun(checkout, ["pr", "merge", String(postPr.number), "--merge"], 120000);
    if (!merge.ok) ghFailure(merge, `gh pr merge ${postPr.number} --merge`);
    act("post-ship-merge", `post-ship PR #${postPr.number} merged into ${artifactDefault}`);
    const del = gitRun(checkout, ["push", "origin", "--delete", postBranch], 60000);
    if (!del.ok) out.warnings.push(`post-ship-delete-branch: git -C ${checkout} push origin --delete ${postBranch} failed (${del.stderr.split("\n")[0]})`);
    syncDefault(checkout, artifactDefault, label, { keepPostShip: false });
    const deletion = gitRun(checkout, ["branch", "-d", postBranch]);
    if (deletion.ok) act("post-ship-cleanup", `${label}: local ${postBranch} deleted at ${checkout}`);
    else out.warnings.push(`post-ship-cleanup: git -C ${checkout} branch -d ${postBranch} failed: ${deletion.stderr.split("\n")[0]}`);
    const landed = shipPrLookup(postBranch, checkout, "postShipPr").pr;
    if (landed) out.postShip.pr = prSummary(landed);
    shippedHere = true;
  }
  finish({ phase: "done", outcome: shippedHere ? "shipped" : "already-shipped", next: [] });
}

// `## <version> (unreleased)` → `## <version> (<date>)` in CHANGELOG.md, one product commit.
function stampChangelog(dir, version, date, act, previous = null) {
  const file = path.join(dir, "CHANGELOG.md");
  const before = fs.readFileSync(file, "utf8");
  const from = previous ? `## ${version} (${previous})` : `## ${version} (unreleased)`;
  if (!before.includes(from)) return;
  fs.writeFileSync(file, before.replace(from, `## ${version} (${date})`));
  gitRun(dir, ["add", "--", "CHANGELOG.md"]);
  const commit = gitRun(dir, ["commit", "-q", "-m", `chore(release): stamp CHANGELOG ${version} (${date})`]);
  if (!commit.ok) emit({ status: "failed", reason: "commit-failed", message: `git -C ${dir} commit (changelog stamp): ${commit.stderr}` }, 3);
  act("changelog-stamp", `CHANGELOG.md "## ${version} (${previous ?? "unreleased"})" stamped (${date}) at ${dir}`);
}

// First 12 hex characters of SHA-256 over the canonical JSON of the accepted gap set,
// so the token survives the CLI's own later commits and dies with any change to the gaps.
function confirmTokenFor(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeJson(payload))).digest("hex").slice(0, 12);
}

function roadmapPathOnRef(layout, ref, type, slug) {
  const top = type === "feature" ? layout.config.artifacts.features : layout.config.artifacts.issues;
  return layout.agit("ls-tree", "-r", "--name-only", ref, `${top}/`).split("\n").find((p) => p.endsWith(`/${slug}/roadmap.md`)) ?? null;
}

// `- [ ] N.M (manual, post-ship) text — verify: …` lines of a roadmap.
function parseRoadmapSteps(content) {
  return [...content.matchAll(/^- \[( |x)\] (\d+\.\d+) (.*)$/gm)].map(([, mark, id, text]) => ({
    id,
    text,
    ticked: mark === "x",
    manual: /^\(manual/.test(text),
    postShip: text.startsWith("(manual, post-ship)"),
  }));
}



// --- preflight: the §9–§11 opening of every command in one call ---------------

// §9 operation ID `<command>:<subject>:<short-sha>`: the slug when one was passed;
// else the managed session id; else the branch; else, detached and unmanaged, HEAD.
function opIdFor(command, slug, worktree) {
  const subject = slug ?? (worktree.isManaged && worktree.dirPrefix && worktree.id ? `${worktree.dirPrefix}-${worktree.id}` : !worktree.detached && worktree.branch ? worktree.branch : "HEAD");
  const sha = git(root, "rev-parse", "--short", "HEAD") || "HEAD";
  return { subject, opId: `${command}:${subject}:${sha}` };
}

function preflightArgs() {
  const command = rest[0];
  if (!command) usage(`preflight needs a command; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
  if (!COMMAND_NEEDS[command]) usage(`preflight: unknown command ${command}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
  const args = rest.slice(1);
  if (args.length > 2) usage(`preflight takes <command> [<type> <slug> | <type>/<slug> | <slug>], got ${JSON.stringify(rest.join(" "))}`);
  if (args.length === 2) return { command, type: requireType(args[0]), slug: requireSlug(args[1]), full: Boolean(options.full) };
  const typed = args[0]?.match(/^(feature|issue)\/(.*)$/);
  if (typed) return { command, type: typed[1], slug: requireSlug(typed[2]), full: Boolean(options.full) };
  return { command, type: null, slug: args[0] ? requireSlug(args[0]) : null, full: Boolean(options.full) };
}

// The §9 receipt and preflight lines, spelled exactly as the policy does.
function receiptLines({ opId, window, doctor }) {
  if (!window.match) {
    const alternatives = [...window.allowed, ...window.elsewhere.map((e) => `${e.command} (${e.window} window)`)];
    return { status: "rejected", receipt: `Receipt: rejected — ${window.reason}; allowed: ${alternatives.length ? alternatives.join(", ") : "none"}`, preflightLines: [] };
  }
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) return { status: "rejected", receipt: `Receipt: rejected — ${capabilityOf(failed.id)}: ${failed.detail}; fallback: ${failed.fallback}`, preflightLines: [] };
  const preflightLines = doctor.checks.filter((c) => c.status === "warn").map((c) => `Preflight: ${capabilityOf(c.id)} warn — ${c.fallback}`);
  return { status: "ok", receipt: `Receipt: accepted ${opId}`, preflightLines };
}

// What `preflight <command> [<type> <slug>]` emits: the session record, the §11
// window verdict, `doctor --for <command>`, the slug's resolution (null without a
// slug), the config document, and the §9 op-id, receipt, and preflight lines.
// `--full` is that document unchanged; the default is the brief document (the
// fields commands actually read), which drops `session.worktrees`, `session.allowed`,
// `session.elsewhere`, `config`, `root`, `configSource`, and `doctor.checks`.
function preflightDocument({ command, type, slug, full = false }) {
  const session = sessionRecord();
  const rule = WINDOW_ROLES[command];
  const clean = rule.clean ? git(session.worktree.path, "status", "--porcelain") === "" : true;
  const window = windowVerdict({ command, record: session, slug, clean, defaultBranch: config.branches.default });
  const doctor = doctorDocument(command);
  const { subject, opId } = opIdFor(command, slug, session.worktree);
  const { status, receipt, preflightLines } = receiptLines({ opId, window, doctor });
  if (full) {
    return {
      status,
      command,
      opId,
      subject,
      receipt,
      preflightLines,
      session,
      window,
      doctor,
      resolve: slug ? resolveDocument(type, slug) : null,
      config: configDocument(),
      root,
      configSource: source,
    };
  }
  const { role, hosted, worktree, companion, workspace, delivery, pr, companionPr, lifecycle, warnings } = session;
  return {
    status,
    command,
    opId,
    subject,
    receipt,
    preflightLines,
    window: {
      role: window.role,
      required: window.required,
      match: window.match,
      reason: window.reason,
      allowed: window.allowed,
      elsewhere: window.elsewhere,
      ...(window.role === "unmanaged" ? { primary: session.worktrees[0]?.path ?? root } : {}),
    },
    session: { role, hosted, worktree, companion, workspace, delivery, pr, companionPr, lifecycle, warnings },
    doctor: { status: doctor.status, for: doctor.for, failing: doctor.checks.filter((c) => c.status !== "ok") },
    ...(slug ? { resolve: resolveDocument(type, slug) } : {}),
  };
}



// One module per command family (plan Approach rule 2). Each entry maps a
// subcommand name to the `scripts/commands/<file>.mjs` module that exports it as
// `commands[<name>]`. The table is empty until Phase 3; unlisted commands fall
// through to the legacy switch below, which shrinks as each family moves out.
const COMMAND_MODULES = {
  release: "release",
  migrate: "migrate",
  harness: "harness",
  models: "models",
  config: "resolve",
  resolve: "resolve",
  find: "resolve",
  ports: "resolve",
  status: "status",
  initiative: "status",
  metrics: "status",
  dashboard: "status",
};

if (Object.hasOwn(COMMAND_MODULES, command)) {
  const handlers = await import(`./commands/${COMMAND_MODULES[command]}.mjs`);
  await handlers.commands[command]();
} else {
  switch (command) {

  case "close-decision": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    const worktreeList = productWorktreeText();
    const { decision, layout } = decideWithLayout(type, slug, (l) =>
      closeBuildSessionDecision({ type, slug, currentBranch, worktreeList, git: l.artifactsGit, rootDir: root, artifactsRoot: l.artifactsRoot, config: l.config }),
    );
    if (decision.status !== "ok") withExit(withLayout(decision, layout));
    const companion = companionOfOwner(decision.owner, layout);
    const gaps = companionGaps(companion);
    if (gaps.length) {
      withExit(
        withLayout(
          {
            status: "error",
            reason: "companion-unpushed",
            owner: decision.owner,
            companion,
            message: companionGapMessage(companion, gaps, type, slug),
          },
          layout,
        ),
      );
    }
    withExit(withLayout({ ...decision, companion }, layout));
    break;
  }

  case "ship-preflight": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    const worktreeList = productWorktreeText();
    const { decision: preflight, layout } = decideWithLayout(type, slug, (l) =>
      evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot: l.artifactsRoot, currentBranch, git: l.artifactsGit, config: l.config, worktreeList }),
    );
    if (preflight.status !== "ok") withExit(withLayout(preflight, layout));
    const companion = companionOfOwner(preflight.owner, layout);
    const gaps = companionGaps(companion);
    const ownerTree = ownerTreeOf(preflight.owner);
    const companionTree = companionTreeOf(companion);
    if (!options.pr) withExit(withLayout({ ...preflight, companion, companionGaps: gaps, ownerTree, companionTree }, layout));
    const { pr, warnings: prWarnings } = lookupPullRequest(preflight.branch);
    const { pr: companionPr, warnings: companionPrWarnings } = lookupCompanionPullRequest(preflight.branch, layout);
    // A MERGED companion PR is the resume-at-teardown case, not a gap.
    if (layout.artifacts.external) {
      if (!companionPr) gaps.push("missing-pr");
      else if (companionPr.state === "CLOSED") gaps.push("pr-not-open");
      else if (isConflicting(companionPr)) gaps.push("conflicting-pr");
    }
    withExit(withLayout({ ...preflight, companion, companionGaps: gaps, ownerTree, companionTree, pr, companionPr, warnings: [...prWarnings, ...companionPrWarnings] }, layout));
    break;
  }

  case "paths": {
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
    break;
  }

  case "workspace": {
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
    break;
  }



  case "session": {
    if (rest.length) usage(`session takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    emit(sessionRecord({ pr: Boolean(options.pr) }));
    break;
  }

  case "windows": {
    windowsCommand(rest);
    break;
  }

  case "artifacts": {
    const [typeArg, slugArg, ...extra] = rest;
    if (!["feature", "issue"].includes(typeArg) || !slugArg || extra.length) usage("artifacts takes <feature|issue> <slug>");
    artifactsCommand(typeArg, requireSlug(slugArg));
    break;
  }

  case "handoff": {
    if (rest.length !== 2) usage(`handoff takes <checkout> "<command>" (quote the command), got ${rest.length} arguments`);
    handoffCommand(rest[0], rest[1]);
    break;
  }

  case "start-session": {
    startSession();
    break;
  }

  case "close-session": {
    closeSession();
    break;
  }

  case "ship": {
    ship();
    break;
  }

  case "sync": {
    sync();
    break;
  }

  case "step-commit": {
    stepCommit();
    break;
  }

  case "plan-publish": {
    planPublish();
    break;
  }

  case "review-publish": {
    reviewPublish();
    break;
  }

  case "publish-pr": {
    publishPr();
    break;
  }

  case "policy": {
    const sections = policySections(PLUGIN_ROOT);
    if (options.list) {
      if (rest.length) usage(`policy --list takes no section arguments, got ${JSON.stringify(rest.join(" "))}`);
      emit({ sections: sections.map(({ n, title, bytes }) => ({ n, title, bytes })) });
      break;
    }
    if (rest.length === 0) usage("policy requires one or more section numbers, or --list");
    const byN = new Map(sections.map((section) => [section.n, section]));
    const requested = [];
    for (const arg of rest) {
      if (!/^\d+$/.test(arg)) usage(`policy: unknown section ${JSON.stringify(arg)}`);
      if (!byN.has(arg)) usage(`policy: no such section ${JSON.stringify(arg)}`);
      if (!requested.includes(arg)) requested.push(arg);
    }
    requested.sort((a, b) => Number(a) - Number(b));
    const header = `# delivery-policy.instructions.md — sections ${requested.join(", ")}\n`;
    emitRaw(header + "\n" + requested.map((n) => byN.get(n).raw).join(""));
    break;
  }

  case "doctor": {
    if (rest.length) usage(`doctor takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    if (options.for && !COMMAND_NEEDS[options.for]) usage(`--for: unknown command ${options.for}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
    const document = doctorDocument(options.for ?? null);
    // warn is usable (exit 0); only a failed hard requirement is a resolution failure (exit 3).
    emit(document, document.status === "fail" ? 3 : 0);
    break;
  }

  case "preflight": {
    const document = preflightDocument(preflightArgs());
    emit(document, document.status === "ok" ? 0 : 3);
    break;
  }


  case "next": {
    if (rest.length > 1) usage(`next takes at most one slug, got ${JSON.stringify(rest.slice(1).join(" "))}`);
    const requestedSlug = rest[0] ? requireSlug(rest[0]) : null;
    const worktrees = productWorktrees();
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { role, worktree, reason: hostedReason } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
    const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config, companionWorktreesDir, companionWorktrees: companionWorktrees() });
    const roadmaps = allRoadmaps(null, [companionHalfOf(describeCompanion(worktree))]);
    const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps, config });
    const { lifecycle, warnings } = deriveLifecycle({ delivery, pr: null, companionPr: null });
    warnings.unshift(...anchor.warnings);
    if (hostedReason) warnings.unshift(hostedReason);
    const ownerOf = (branch) => findOwner({ worktrees, worktreesDir: sessionWorktreesDir, branch, config });

    const toCandidate = (record, sourceKind, layout = checkoutLayout()) => {
      const fresh = reviewFreshness(record.branch, record.dir, layout.agit);
      if (fresh.warning) warnings.push(fresh.warning);
      return {
        kind: "delivery",
        type: record.type,
        slug: record.slug,
        branch: record.branch,
        dir: record.dir,
        roadmap: record.roadmap,
        status: record.status,
        reviewVerdict: record.reviewVerdict,
        postShipPending: record.postShipPending,
        artifactPr: record.artifactPr,
        owner: ownerOf(record.branch),
        reviewFresh: fresh.reviewFresh,
        source: sourceKind,
        ref: fresh.ref,
        layout: layout.layout,
        artifactsRoot: layout.artifactsRoot,
      };
    };

    // Candidates: non-complete roadmaps in this checkout, deliveries owned by managed
    // worktrees (read from their branch when not in this checkout), ready members.
    const candidates = [];
    const seen = new Set();
    const add = (c) => {
      if (!c || seen.has(c.slug)) return;
      seen.add(c.slug);
      candidates.push(c);
    };
    for (const r of roadmaps) if (r.status !== "complete" || r.postShipPending > 0) add(toCandidate(r, "local"));
    for (const w of classified) {
      if (!w.isManaged || w.role !== "build") continue;
      const d = deriveDelivery({ branch: w.branch, dirPrefix: w.dirPrefix, id: w.id, roadmaps, config });
      if (!d || seen.has(d.slug)) continue;
      if (d.roadmap) add(toCandidate(roadmaps.find((r) => r.type === d.type && r.slug === d.slug), "local"));
      else {
        const found = roadmapOnBranch(d.type, d.slug);
        if (found) add(toCandidate(found.record, found.source, found.layout));
      }
    }
    const members = [];
    for (const b of allBreakdowns()) {
      const derived = deriveInitiative(b, roadmaps.filter((r) => r.type === "feature"));
      if (derived.status !== "ok") continue;
      for (const f of derived.features) if (f.ready) members.push({ kind: "initiative-member", slug: f.slug, type: "feature", initiative: b.slug, branch: f.branch });
    }
    for (const m of members) add(m);

    let missingMessage = null;
    if (requestedSlug && !seen.has(requestedSlug)) {
      const local = roadmaps.filter((r) => r.slug === requestedSlug);
      if (local.length === 1) add(toCandidate(local[0], "local"));
      else if (local.length > 1) {
        emit({ status: "ambiguous", role, lifecycle, slug: requestedSlug, type: null, next: null, candidates: local.map((r) => ({ kind: "delivery", slug: r.slug, type: r.type, status: r.status, initiative: r.initiative, owner: ownerOf(r.branch), invocation: `/agento continue ${r.slug}` })), reviewFresh: null, dispatch: null, warnings, reason: `Slug ${requestedSlug} exists as both a feature and an issue; specify which by its own worktree.`, root, configSource: source }, 3);
      } else {
        let resolved = null;
        for (const type of ["feature", "issue"]) {
          const found = roadmapOnBranch(type, requestedSlug);
          if (found) {
            resolved = found;
            break;
          }
        }
        if (resolved) add(toCandidate(resolved.record, resolved.source, resolved.layout));
        else missingMessage = `No roadmap for slug ${requestedSlug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin, and no initiative member with that slug is ready.`;
      }
    }

    const active = delivery?.dir ? reviewFreshness(delivery.branch, delivery.dir) : null;
    if (active?.warning) warnings.push(active.warning);
    const result = deriveNext({
      role,
      worktree,
      delivery,
      lifecycle,
      owner: delivery ? ownerOf(delivery.branch) : null,
      reviewFresh: active?.reviewFresh ?? null,
      candidates,
      requestedSlug,
      config,
    });
    if (result.status === "missing" && missingMessage) result.reason = missingMessage;
    const target = requestedSlug ? candidates.find((c) => c.slug === requestedSlug) ?? null : delivery && lifecycle !== "no-delivery" ? delivery : candidates.length === 1 ? candidates[0] : null;
    const targetFresh = target === delivery ? active?.reviewFresh ?? null : target?.kind === "delivery" ? target.reviewFresh : null;
    if (result.next) {
      result.next.target = resolveNextTarget({
        next: result.next,
        worktrees: classified,
        primaryPath: worktrees[0]?.path ?? root,
        branch: target?.branch ?? delivery?.branch ?? null,
        workspaceFor: (w) => describeWorkspace(w, sessionWorktreesDir),
      });
    }
    emit(
      {
        status: result.status,
        role,
        lifecycle,
        slug: target?.slug ?? requestedSlug ?? null,
        type: target?.type ?? null,
        artifactPr: target?.artifactPr ?? null,
        layout: target ? (target.layout ?? "checkout") : null,
        artifactsRoot: target ? (target.artifactsRoot ?? artifactsRoot) : null,
        next: result.next,
        candidates: result.candidates,
        reviewFresh: targetFresh,
        dispatch: dispatchFor(result.next?.command),
        warnings: [...new Set(warnings)],
        reason: result.reason,
        root,
        configSource: source,
      },
      result.status === "ok" || result.status === "none" ? 0 : 3,
    );
    break;
  }

  default:
    usage(command ? `unknown command ${command}` : "missing command");
  }
}
