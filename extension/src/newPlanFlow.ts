import { pendingDispatchKey, savePendingDispatch, type PendingDispatchStore } from "./pendingDispatch.js";

export type NewPlanTarget = { kind: "folder" | "workspace"; path: string };

export interface NewPlanRequest {
  command: string;
}

export interface NewPlanFlowDependencies {
  readSession: (cwd?: string) => Promise<unknown>;
  submitCommand: (command: string, target: NewPlanTarget) => Promise<void>;
  pendingStore: PendingDispatchStore;
  openTarget: (target: NewPlanTarget) => PromiseLike<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  isCancellationRequested: () => boolean;
  offerRecovery: (message: string, actions: readonly ["Retry", "Focus target"]) => Promise<"Retry" | "Focus target" | undefined>;
}

export interface NewPlanFlowOptions {
  pollIntervalMs: number;
  timeoutMs: number;
}

export type NewPlanFlowResult =
  | { kind: "complete"; command: string; target: NewPlanTarget }
  | { kind: "timeout" | "cancelled" | "ambiguous" | "failed"; command: string; reason: string };

interface Worktree {
  path: string;
  role: string;
  isManaged: boolean;
  dirPrefix: string | null;
  repo?: string;
}

interface Session {
  worktrees: Worktree[];
  companion: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorktree(value: unknown): Worktree {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.role !== "string" || typeof value.isManaged !== "boolean") {
    throw new Error("session worktree is invalid");
  }
  if (value.dirPrefix !== null && typeof value.dirPrefix !== "string") {
    throw new Error("session worktree dirPrefix is invalid");
  }
  if (value.repo !== undefined && typeof value.repo !== "string") {
    throw new Error("session worktree repo is invalid");
  }
  return {
    path: value.path,
    role: value.role,
    isManaged: value.isManaged,
    dirPrefix: value.dirPrefix,
    repo: value.repo,
  };
}

function nullableRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`session ${key} is invalid`);
  return value;
}

function parseSession(value: unknown): Session {
  if (!isRecord(value) || value.status !== "ok" || !Array.isArray(value.worktrees)) {
    throw new Error("session response is invalid");
  }
  return {
    worktrees: value.worktrees.map(parseWorktree),
    companion: nullableRecord(value, "companion"),
    workspace: nullableRecord(value, "workspace"),
  };
}

function validateSlug(value: string): string {
  if (!SLUG_PATTERN.test(value)) throw new Error("initiative and member slugs must use canonical slug syntax");
  return value;
}

export function createNewPlanRequest(kind: "feature" | "issue", description: string): NewPlanRequest {
  const normalized = description.trim();
  if (!normalized) throw new Error("plan description must be non-empty");
  if (/\r|\n/.test(normalized)) throw new Error("plan description must fit on one line");
  return { command: `/agento new-${kind} ${normalized}` };
}

export function createInitiativePlanRequest(initiativeSlug: string, memberSlug: string): NewPlanRequest {
  return {
    command: `/agento new-feature initiative:${validateSlug(initiativeSlug)}/${validateSlug(memberSlug)}`,
  };
}

function productWorktrees(session: Session): Worktree[] {
  return session.worktrees.filter((worktree) => worktree.repo === undefined || worktree.repo === "product");
}

function primaryTarget(session: Session): NewPlanTarget {
  const matches = productWorktrees(session).filter((worktree) => worktree.role === "primary");
  if (matches.length !== 1) throw new Error(`Expected one primary checkout, found ${matches.length}.`);
  return { kind: "folder", path: matches[0]!.path };
}

function newPlanningWorktrees(session: Session, existingPaths: ReadonlySet<string>): Worktree[] {
  return productWorktrees(session).filter((worktree) =>
    worktree.isManaged && worktree.dirPrefix === "plan" && !existingPaths.has(worktree.path)
  );
}

function targetFromSession(session: Session, worktreePath: string): NewPlanTarget | null {
  if (session.companion !== null) {
    const workspacePath = session.workspace?.path;
    return session.workspace?.exists === true && typeof workspacePath === "string" && workspacePath.length > 0
      ? { kind: "workspace", path: workspacePath }
      : null;
  }
  return { kind: "folder", path: worktreePath };
}

async function handoff(
  request: NewPlanRequest,
  target: NewPlanTarget,
  dependencies: NewPlanFlowDependencies,
): Promise<NewPlanFlowResult> {
  const attempt = async (): Promise<void> => {
    await savePendingDispatch(dependencies.pendingStore, {
      target: target.path,
      command: request.command,
      createdAt: dependencies.now(),
    });
    try {
      await dependencies.openTarget(target);
    } catch (error) {
      await dependencies.pendingStore.update(pendingDispatchKey(target.path), undefined);
      throw error;
    }
  };

  try {
    await attempt();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const selection = await dependencies.offerRecovery(`Unable to open the planning target: ${detail}`, ["Retry", "Focus target"]);
    if (selection === "Retry" || selection === "Focus target") {
      try {
        await attempt();
      } catch (retryError) {
        const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
        return { kind: "failed", command: request.command, reason: `Unable to open the planning target: ${retryDetail}` };
      }
    } else {
      return { kind: "failed", command: request.command, reason: `Unable to open the planning target: ${detail}` };
    }
  }
  return { kind: "complete", command: request.command, target };
}

export async function runNewPlanFlow(
  request: NewPlanRequest,
  dependencies: NewPlanFlowDependencies,
  options: NewPlanFlowOptions,
): Promise<NewPlanFlowResult> {
  try {
    const before = parseSession(await dependencies.readSession());
    const primary = primaryTarget(before);
    const existingPaths = new Set(productWorktrees(before).map((worktree) => worktree.path));
    await dependencies.submitCommand("/agento start-session", primary);

    while (true) {
      const deadline = dependencies.now() + options.timeoutMs;
      while (dependencies.now() < deadline) {
        if (dependencies.isCancellationRequested()) {
          return { kind: "cancelled", command: request.command, reason: "Waiting for the planning worktree was cancelled." };
        }
        const current = parseSession(await dependencies.readSession());
        const candidates = newPlanningWorktrees(current, existingPaths);
        if (candidates.length > 1) {
          return {
            kind: "ambiguous",
            command: request.command,
            reason: `Found ${candidates.length} new planning worktrees; no target was selected.`,
          };
        }
        if (candidates.length === 1) {
          if (dependencies.isCancellationRequested()) {
            return { kind: "cancelled", command: request.command, reason: "Waiting for the planning worktree was cancelled." };
          }
          const candidate = candidates[0]!;
          const targetSession = parseSession(await dependencies.readSession(candidate.path));
          const target = targetFromSession(targetSession, candidate.path);
          if (target) return handoff(request, target, dependencies);
        }
        await dependencies.sleep(options.pollIntervalMs);
      }

      const reason = "Timed out waiting for a new planning worktree.";
      const selection = await dependencies.offerRecovery(reason, ["Retry", "Focus target"]);
      if (selection === "Retry") continue;
      if (selection === "Focus target") await dependencies.openTarget(primary);
      return { kind: "timeout", command: request.command, reason };
    }
  } catch (error) {
    const reason = `Unable to start a new plan: ${error instanceof Error ? error.message : String(error)}`;
    return { kind: "failed", command: request.command, reason };
  }
}