// The `ship`, `ship-preflight`, and `close-decision` subcommands and the ship
// run, moved unchanged from the legacy switch in `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { classifyMergeRefusal, missingRequired, requiredContexts } from "../merge-state.mjs";
import {
  closeBuildSessionDecision,
  completeRoadmap,
  evaluateShipPreflight,
  reopenRoadmap,
} from "../delivery-roadmap-resolver.mjs";
import { deriveAllowed, findOwner, parseWorktreeList } from "../session-state.mjs";
import {
  agit,
  artifacts,
  artifactsRoot,
  artifactsGit,
  command,
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
  source,
  usage,
  withExit,
} from "../lib/context.mjs";
import { capabilityOf, checksFor, COMMAND_NEEDS, runDoctor } from "../lib/doctor.mjs";
import { refFor } from "../lib/documents.mjs";
import { fetchOrigin, mergeRef, pushRef, SHIP_EXIT } from "../lib/delivery-run.mjs";
import { gitRun } from "../lib/git.mjs";
import { ghRun, lookupCompanionPullRequest, lookupPullRequest } from "../lib/github.mjs";
import { decideWithLayout, deliveryBranch, resolveWithLayout, withLayout } from "../lib/layout.mjs";
import { registeredAt, resolveSessionPaths } from "../lib/paths.mjs";
import { header } from "../lib/records.mjs";
import { ghRequiredContexts, once, releaseVerdict } from "../lib/release.mjs";
import { requireSlug, requireType } from "../lib/resolve.mjs";
import { branchVerdict, companionGaps, companionGapMessage, companionOfOwner, removeSessionPair, sessionRecord, treeState } from "../lib/session.mjs";
import { confirmTokenFor, isConflicting, parseRoadmapSteps, prSummary, roadmapPathOnRef, shipPrLookup, stampChangelog, utcDate, waitForChecks } from "../lib/ship.mjs";

function ownerTreeOf(owner) {
  if (!owner || owner.role === "primary") return null;
  return treeState(owner.path);
}

function companionTreeOf(companion) {
  if (!companion?.registered) return null;
  const tree = treeState(companion.path);
  return tree && { tracked: tree.tracked, untracked: tree.untracked };
}

function shipArgs() {
  const type = requireType(rest[0]);
  const slug = requireSlug(rest[1]);
  if (rest.length > 2) usage(`ship takes exactly <feature|issue> <slug>, got extra ${JSON.stringify(rest.slice(2).join(" "))}`);
  return { type, slug, confirm: options.confirm ?? null, wait: options.wait ?? 50 };
}

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
    out.teardown = { product: removal.product, companion: removal.companion, workspace, branches, occupants: removal.occupants, stoppedHosts: removal.stoppedHosts, pausedPath: null };
    for (const { label, half } of halves) {
      for (const host of removal.stopped[label]) {
        act("stop-host", `stopped orphaned Mission Control host PID ${host.pid} (session ${host.sessionId.slice(0, 8)}) in ${half.path}`);
      }
    }
    if (removal.status === "blocked") {
      const flagged = halves.find((h) => h.label === removal.half).half.path;
      out.teardown.pausedPath = flagged;
      const summary = halves.filter((h) => removal.occupants[h.label].length).map((h) => `${h.label} half ${h.half.path}: ${removal.occupants[h.label].join(", ")}`).join("; ");
      const killPids = [...removal.killHosts.product, ...removal.killHosts.companion];
      const killSentence = killPids.length ? ` Stop the orphaned Copilot SDK extension hosts with: kill ${killPids.join(" ")}.` : "";
      finish({ status: "blocked", reason: "occupied", outcome: "paused-teardown", message: `paused at teardown (worktree ${flagged} still open): ${summary}; close that VS Code window or terminal, then re-send /agento ship ${slug}${killSentence}`, next: [shipCommand()] });
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

export const commands = {
  "close-decision"() {
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
  },
  "ship-preflight"() {
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
  },
  ship() {
    ship();
  },
};
