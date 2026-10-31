// The `session`, `start-session`, and `close-session` subcommands and their
// helpers, moved unchanged from the legacy switch in `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { closeBuildSessionDecision } from "../delivery-roadmap-resolver.mjs";
import { classifyFetchFailure, findOwner, halfState, nextSessionId, parseWorktreeList } from "../session-state.mjs";
import {
  artifacts,
  artifactsRoot,
  companionWorktrees,
  companionWorktreesDir,
  config,
  currentBranch,
  emit,
  git,
  options,
  primaryWorktreesDir,
  productWorktrees,
  productWorktreeText,
  rest,
  root,
  samePath,
  source,
  usage,
} from "../lib/context.mjs";
import { capabilityOf, checksFor, COMMAND_NEEDS, runDoctor } from "../lib/doctor.mjs";
import { gitRun, isAncestor, reauthFor } from "../lib/git.mjs";
import { checkoutLayout, decideWithLayout, deliveryBranch, resolveWithLayout } from "../lib/layout.mjs";
import { originOf, registeredAt, resolveSessionPaths, writeSessionWorkspace } from "../lib/paths.mjs";
import { header } from "../lib/records.mjs";
import { requireSlug } from "../lib/resolve.mjs";
import {
  branchVerdict,
  companionGaps,
  companionGapMessage,
  companionOfOwner,
  removeSessionPair,
  sessionRecord,
  treeState,
} from "../lib/session.mjs";

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

export const commands = {
  session() {
    if (rest.length) usage(`session takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    emit(sessionRecord({ pr: Boolean(options.pr) }));
  },
  "start-session"() {
    startSession();
  },
  "close-session"() {
    closeSession();
  },
};
