// The `next` subcommand and its helpers, moved unchanged from the legacy switch
// in `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { classifyWorktrees, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, resolveNextTarget } from "../session-state.mjs";
import {
  agit,
  anchor,
  artifactsRoot,
  companionWorktrees,
  companionWorktreesDir,
  config,
  emit,
  PLUGIN_ROOT,
  primaryWorktreesDir,
  productWorktrees,
  rest,
  roleCwd,
  root,
  source,
  usage,
} from "../lib/context.mjs";
import { allBreakdowns, deriveInitiative, refFor } from "../lib/documents.mjs";
import { checkoutLayout, roadmapOnBranch } from "../lib/layout.mjs";
import { allRoadmaps } from "../lib/records.mjs";
import { requireSlug } from "../lib/resolve.mjs";
import { companionHalfOf, describeCompanion, describeWorkspace } from "../lib/session.mjs";

function reviewFreshness(branch, dir, g = agit) {
  const { ref, warning } = refFor(branch, g);
  const reviewTs = g("log", "-1", "--format=%ct", ref, "--", `${dir}/review.md`);
  if (!reviewTs) return { reviewFresh: null, ref, warning };
  const otherTs = g("log", "-1", "--format=%ct", ref, "--", ".", `:(exclude)${dir}/review.md`);
  return { reviewFresh: Number(reviewTs) >= Number(otherTs || 0), ref, warning };
}

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

export const commands = {
  next() {
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
  },
};
