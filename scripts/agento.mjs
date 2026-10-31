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

import fs from "node:fs";
import path from "node:path";

import { classifyWorktrees, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, resolveNextTarget } from "./session-state.mjs";
import {
  usage,
  emit,
  anchor,
  root,
  roleCwd,
  config,
  source,
  artifactsRoot,
  agit,
  companionWorktreesDir,
  companionWorktrees,
  productWorktrees,
  primaryWorktreesDir,
  PLUGIN_ROOT,
  command,
  rest,
} from "./lib/context.mjs";
import { allRoadmaps } from "./lib/records.mjs";
import { checkoutLayout, roadmapOnBranch } from "./lib/layout.mjs";
import { requireSlug } from "./lib/resolve.mjs";
import { companionHalfOf, describeCompanion, describeWorkspace } from "./lib/session.mjs";
import { allBreakdowns, deriveInitiative, refFor } from "./lib/documents.mjs";









// close-decision / ship-preflight: the companion half owned alongside the product
// half, or null when no managed worktree owns the branch (or in-repo mode).






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



















// --- ship ------------------------------------------------------------------






// GitHub reports a conflict as mergeable CONFLICTING / mergeStateStatus DIRTY; mergeStateStatus is never CONFLICTING.




// --- preflight: the §9–§11 opening of every command in one call ---------------




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
  policy: "doctor",
  doctor: "doctor",
  preflight: "doctor",
  paths: "paths",
  workspace: "paths",
  windows: "paths",
  artifacts: "paths",
  handoff: "paths",
  session: "session",
  "start-session": "session",
  "close-session": "session",
  sync: "publish",
  "step-commit": "publish",
  "plan-publish": "publish",
  "review-publish": "publish",
  "publish-pr": "publish",
  "close-decision": "ship",
  "ship-preflight": "ship",
  ship: "ship",
};

if (Object.hasOwn(COMMAND_MODULES, command)) {
  const handlers = await import(`./commands/${COMMAND_MODULES[command]}.mjs`);
  await handlers.commands[command]();
} else {
  switch (command) {



















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
