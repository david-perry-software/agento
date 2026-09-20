import type { CommandAction } from "./commandActions.js";

export type CurrentWindow = "primary" | "secondary";

export type DispatchRoute =
  | { kind: "submit"; command: string }
  | {
      kind: "open";
      command: string;
      window: CurrentWindow;
      target: { kind: "folder" | "workspace"; path: string };
      reason: string;
    }
  | { kind: "reject"; reason: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejection(value: unknown): DispatchRoute {
  const reason = isRecord(value) && typeof value.reason === "string" && value.reason.length > 0 ? value.reason : "The command is no longer available.";
  return { kind: "reject", reason };
}

export function routeCommandAction(
  action: CommandAction,
  options: { currentWindow: CurrentWindow; slug?: string; next?: unknown },
): DispatchRoute {
  const isShip = action.command.startsWith("/agento ship ");
  if (!options.slug) {
    if (action.window !== "here") {
      return { kind: "reject", reason: action.reason ?? "A delivery slug is required for cross-window dispatch." };
    }
    if (isShip && options.currentWindow !== "primary") {
      return { kind: "reject", reason: "Ship commands run only in the primary window." };
    }
    return { kind: "submit", command: action.command };
  }

  if (!isRecord(options.next) || options.next.status !== "ok" || !isRecord(options.next.next)) {
    return rejection(options.next);
  }
  const next = options.next.next;
  if (next.window !== "here" && next.window !== "primary" && next.window !== "secondary") {
    return { kind: "reject", reason: "The refreshed command has an invalid target window." };
  }
  if (isShip && (next.window === "secondary" || (next.window === "here" && options.currentWindow !== "primary"))) {
    return { kind: "reject", reason: "Ship commands run only in the primary window." };
  }

  const continueCommand = `/agento continue ${options.slug}`;
  if (next.window === "here") {
    return { kind: "submit", command: action.window === "here" ? action.command : continueCommand };
  }
  if (!isRecord(next.target) || typeof next.target.path !== "string" || next.target.path.length === 0) {
    return { kind: "reject", reason: typeof next.reason === "string" ? next.reason : "The refreshed command has no target checkout." };
  }

  const workspace = isRecord(next.target.workspace) ? next.target.workspace : null;
  const target =
    workspace && workspace.exists === true && typeof workspace.path === "string" && workspace.path.length > 0
      ? { kind: "workspace" as const, path: workspace.path }
      : { kind: "folder" as const, path: next.target.path };
  return {
    kind: "open",
    command: continueCommand,
    window: next.window,
    target,
    reason: typeof next.reason === "string" && next.reason.length > 0 ? next.reason : action.reason ?? "Continue in the target window.",
  };
}