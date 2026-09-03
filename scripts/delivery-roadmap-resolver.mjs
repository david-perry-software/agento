import fs from "node:fs";
import path from "node:path";

import { loadAgentoConfig } from "./agento-config.mjs";

function artifactRoots(config) {
  return {
    feature: config.artifacts.features,
    issue: config.artifacts.issues,
  };
}

function branchPrefix(config, type) {
  return type === "feature" ? config.branches.feature : config.branches.issue;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findLocalRoadmaps({ rootDir, type, slug, config }) {
  const cfg = config ?? loadAgentoConfig(rootDir).config;
  const roots = artifactRoots(cfg);
  const baseDirs = [...new Set(Object.values(roots))].map((rel) => path.join(rootDir, rel));
  const matches = [];

  for (const base of baseDirs) {
    if (!fs.existsSync(base)) continue;

    const stack = [base];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(child);
          continue;
        }
        if (!entry.isFile() || entry.name !== "roadmap.md") continue;

        const parent = path.dirname(child);
        const parentName = path.basename(parent);
        if (parentName !== slug) continue;

        const rel = path.relative(rootDir, parent).split(path.sep).join("/");
        if (!rel) continue;
        const kind = rel.split("/").slice(0, roots[type].split("/").length).join("/");
        if (kind !== roots[type]) continue;

        matches.push(child.split(path.sep).join("/"));
      }
    }
  }

  return matches.sort();
}

function parseRoadmapContent(content, expectedBranch, expectedLabel) {
  const branchMatch = content.match(/(?:^|\n)branch:\s*([^\n#]+?)(?:\s+#.*)?(?:\r?\n|$)/m);
  if (!branchMatch) {
    return {
      status: "branch-mismatch",
      message: `Roadmap is missing a valid branch header for ${expectedLabel}. Expected exactly ${expectedBranch}.`,
    };
  }

  const branch = branchMatch[1].trim();
  if (branch !== expectedBranch) {
    return {
      status: "branch-mismatch",
      message: `Roadmap branch mismatch: header says ${branch}, expected ${expectedBranch}.`,
    };
  }

  const statusMatch = content.match(/(?:^|\n)status:\s*([^\n#]+?)(?:\s+#.*)?(?:\r?\n|$)/m);
  return {
    status: statusMatch ? "ok" : "branch-mismatch",
    branch,
    message: statusMatch ? "Roadmap resolved successfully." : `Roadmap is missing a status header for ${expectedBranch}.`,
  };
}

function normalizeGitPaths(raw, expectedTop, slug) {
  if (!raw) return [];
  const topParts = expectedTop.split("/").filter(Boolean);
  const paths = [];

  for (const line of raw.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < topParts.length + 2) continue;
    if (parts.at(-1) !== "roadmap.md") continue;
    if (parts.slice(0, topParts.length).join("/") !== expectedTop) continue;
    if (parts.at(-2) !== slug) continue;
    paths.push(normalized);
  }
  return paths;
}

export function resolveRoadmapArtifact({ rootDir, type, slug, currentBranch, git, config }) {
  const cfg = config ?? loadAgentoConfig(rootDir).config;
  const roots = artifactRoots(cfg);
  const expectedBranch = `${branchPrefix(cfg, type)}${slug}`;
  const expectedLabel = `${type}/${slug}`;
  const localMatches = findLocalRoadmaps({ rootDir, type, slug, config: cfg });

  if (localMatches.length > 1) {
    return {
      status: "conflict",
      source: "local",
      paths: localMatches,
      message: `Multiple matching roadmaps found for ${expectedLabel}: ${localMatches.join(", ")}. Keep exactly one roadmap per slug.`,
    };
  }

  if (localMatches.length === 1) {
    const pathValue = localMatches[0];
    const raw = fs.readFileSync(pathValue, "utf8");
    const parsed = parseRoadmapContent(raw, expectedBranch, expectedLabel);
    if (parsed.status === "ok") {
      return {
        status: "ok",
        source: "local",
        path: pathValue,
        branch: parsed.branch,
        message: `Resolved ${expectedLabel} from the current checkout at ${pathValue}.`,
      };
    }
    return {
      status: "branch-mismatch",
      source: "local",
      path: pathValue,
      message: parsed.message,
    };
  }

  const remoteRef = `origin/${expectedBranch}`;
  const remoteCandidates = [];
  const remoteList = git?.lsTree ? git.lsTree(remoteRef) : "";
  for (const remotePath of normalizeGitPaths(remoteList, roots[type], slug)) {
    const shown = git?.show ? git.show(`${remoteRef}:${remotePath}`) : "";
    if (!shown) continue;
    const parsed = parseRoadmapContent(shown, expectedBranch, expectedLabel);
    if (parsed.status === "branch-mismatch") {
      return {
        status: "branch-mismatch",
        source: "remote",
        message: `Remote roadmap for ${expectedLabel} has a branch mismatch: ${parsed.message}`,
      };
    }
    remoteCandidates.push({ path: remotePath, branch: parsed.branch, content: shown });
  }

  if (remoteCandidates.length > 1) {
    return {
      status: "conflict",
      source: "remote",
      paths: remoteCandidates.map((entry) => entry.path),
      message: `Multiple matching roadmaps were found on ${remoteRef}. Resolve the conflict before continuing.`,
    };
  }

  if (remoteCandidates.length === 1) {
    return {
      status: "ok",
      source: "remote",
      path: remoteCandidates[0].path,
      branch: remoteCandidates[0].branch,
      message: `Resolved ${expectedLabel} from ${remoteRef}; no local roadmap was present in the current checkout.`,
    };
  }

  return {
    status: "missing",
    source: "none",
    message: `No roadmap found locally for ${expectedLabel} and no matching artifact was resolvable on ${remoteRef}.`,
  };
}

export function closeBuildSessionDecision({ type, slug, currentBranch, worktreeList, git, rootDir, config }) {
  const effectiveRoot = rootDir ?? process.cwd();
  const cfg = config ?? loadAgentoConfig(effectiveRoot).config;
  const result = resolveRoadmapArtifact({
    rootDir: effectiveRoot,
    type,
    slug,
    currentBranch,
    git,
    config: cfg,
  });

  if (result.status === "ok") {
    const worktreeBase = path.basename(cfg.worktrees.dir);
    const managedPattern = new RegExp(`worktree .*${escapeRegExp(worktreeBase)}[/\\\\]`);
    const managedOwnsBranch = managedPattern.test(worktreeList || "");
    if (managedOwnsBranch || currentBranch !== cfg.branches.default) {
      return {
        status: "ok",
        reason: "managed-worktree-present",
        message: `Build session for ${type}/${slug} resolves successfully; the managed worktree still owns the branch.`,
      };
    }
    return {
      status: "ok",
      reason: "remote-roadmap-only",
      message: `No managed worktree owns ${type}/${slug}; the roadmap resolves from origin/${result.branch} and the session can be treated as already closed.`,
    };
  }

  if (result.status === "conflict") {
    return {
      status: "error",
      reason: "multiple-roadmaps",
      message: result.message,
    };
  }

  if (result.status === "branch-mismatch") {
    return {
      status: "error",
      reason: "branch-mismatch",
      message: result.message,
    };
  }

  return {
    status: "error",
    reason: "no-resolvable-roadmap",
    message: result.message,
  };
}

export function evaluateShipPreflight({ type, slug, rootDir, currentBranch, git, config }) {
  const cfg = config ?? loadAgentoConfig(rootDir).config;
  const result = resolveRoadmapArtifact({
    rootDir,
    type,
    slug,
    currentBranch,
    git,
    config: cfg,
  });

  if (result.status === "ok") {
    return {
      status: "ok",
      resolutionSource: result.source,
      branch: result.branch,
      message: `Ship preflight can proceed: roadmap resolved via ${result.source} fallback for ${type}/${slug}.`,
    };
  }

  if (result.status === "conflict") {
    return {
      status: "error",
      reason: "multiple-roadmaps",
      message: result.message,
    };
  }

  if (result.status === "branch-mismatch") {
    return {
      status: "error",
      reason: "branch-mismatch",
      message: result.message,
    };
  }

  return {
    status: "error",
    reason: "no-resolvable-roadmap",
    message: result.message,
  };
}
