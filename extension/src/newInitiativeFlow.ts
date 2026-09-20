import path from "node:path";

export type NewInitiativeTarget = { kind: "folder"; path: string };

export interface NewInitiativeRequest {
  command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createNewInitiativeRequest(argument: string | undefined): NewInitiativeRequest | undefined {
  if (argument === undefined) return undefined;
  if (!argument.trim()) throw new Error("initiative brief must be non-empty");
  return { command: `/agento new-initiative ${argument}` };
}

export function primaryInitiativeTarget(value: unknown): NewInitiativeTarget {
  if (!isRecord(value) || value.status !== "ok" || !Array.isArray(value.worktrees)) {
    throw new Error("session response is invalid");
  }
  const matches = value.worktrees.filter((worktree) =>
    isRecord(worktree)
    && worktree.role === "primary"
    && (worktree.repo === undefined || worktree.repo === "product")
    && typeof worktree.path === "string"
  ) as Array<Record<string, unknown> & { path: string }>;
  if (matches.length !== 1) throw new Error(`Expected one primary checkout, found ${matches.length}.`);
  return { kind: "folder", path: matches[0]!.path };
}

export function repositoryRelativeBriefPath(primaryPath: string, selectedPath: string): string {
  const relativePath = path.relative(path.resolve(primaryPath), path.resolve(selectedPath));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("brief file must be inside the primary repository");
  }
  return relativePath.split(path.sep).join("/");
}