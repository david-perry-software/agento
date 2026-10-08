import { pendingDispatchKey, savePendingDispatch, type PendingDispatchStore } from "./pendingDispatch.js";
import { OPEN_IN_CHAT, runStartSession, type StartSessionRunner } from "./startSessionCli.js";

export type NewPlanTarget = { kind: "folder" | "workspace"; path: string };

export interface NewPlanRequest {
  command: string;
}

export interface NewPlanFlowDependencies {
  readSession: () => Promise<unknown>;
  startSession: StartSessionRunner;
  submitCommand: (command: string, target: NewPlanTarget) => Promise<void>;
  pendingStore: PendingDispatchStore;
  openTarget: (target: NewPlanTarget) => PromiseLike<unknown>;
  now: () => number;
  offerRecovery: (message: string, actions: readonly ["Retry", "Focus target"]) => Promise<"Retry" | "Focus target" | undefined>;
  offerOpenInChat: (message: string) => Promise<typeof OPEN_IN_CHAT | undefined>;
}

// `reported`: the flow already showed the reason to the user (with Open in chat).
export type NewPlanFlowResult =
  | { kind: "complete"; command: string; target: NewPlanTarget }
  | { kind: "failed"; command: string; reason: string; reported?: boolean };

interface Worktree {
  path: string;
  role: string;
  isManaged: boolean;
  dirPrefix: string | null;
  repo?: string;
}

interface Session {
  worktrees: Worktree[];
  role: string | null;
  worktree: { path: string; detached: boolean } | null;
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

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`session ${key} is invalid`);
  return value;
}

function nullableSessionWorktree(value: unknown): { path: string; detached: boolean } | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.detached !== "boolean") {
    throw new Error("session worktree is invalid");
  }
  return { path: value.path, detached: value.detached };
}

function parseSession(value: unknown): Session {
  if (!isRecord(value) || value.status !== "ok" || !Array.isArray(value.worktrees)) {
    throw new Error("session response is invalid");
  }
  return {
    worktrees: value.worktrees.map(parseWorktree),
    role: nullableString(value, "role"),
    worktree: nullableSessionWorktree(value.worktree),
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
): Promise<NewPlanFlowResult> {
  try {
    const before = parseSession(await dependencies.readSession());
    if (before.role === "plan" && before.worktree?.detached === true) {
      const target: NewPlanTarget = { kind: "folder", path: before.worktree.path };
      await dependencies.submitCommand(request.command, target);
      return { kind: "complete", command: request.command, target };
    }
    const primary = primaryTarget(before);
    const started = await runStartSession(() => dependencies.startSession([], primary.path));
    if (started.kind === "ok") return handoff(request, started.target, dependencies);

    const reason = `Unable to start a planning session: ${started.reason}`;
    if ((await dependencies.offerOpenInChat(reason)) === OPEN_IN_CHAT) {
      await dependencies.submitCommand("/agento start-session", primary);
    }
    return { kind: "failed", command: request.command, reason, reported: true };
  } catch (error) {
    const reason = `Unable to start a new plan: ${error instanceof Error ? error.message : String(error)}`;
    return { kind: "failed", command: request.command, reason };
  }
}