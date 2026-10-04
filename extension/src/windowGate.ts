export interface WindowGate {
  primary: boolean;
  canPlan: boolean;
}

export const CLOSED_GATE: WindowGate = { primary: false, canPlan: false };

export type GatedCommand = "agento.newPlan" | "agento.newInitiative" | "agento.planInitiativeMember";

const REJECTIONS: Record<GatedCommand, string> = {
  "agento.newInitiative": "New Initiative runs only in the primary window: switch to the primary window and run it there.",
  "agento.newPlan": "New Plan runs only in the primary window or an unpromoted plan window: switch to the primary window and run it there.",
  "agento.planInitiativeMember": "Plan runs only in the primary window or an unpromoted plan window: switch to the primary window and run it there.",
};

// `hosted` is ignored: the CLI has already derived `role` from the branch.
export function windowGate(session: unknown): WindowGate {
  if (typeof session !== "object" || session === null) return CLOSED_GATE;
  const record = session as { status?: unknown; role?: unknown; worktree?: unknown };
  if (record.status !== "ok" || typeof record.role !== "string") return CLOSED_GATE;
  const primary = record.role === "primary";
  const worktree = record.worktree;
  const detached = typeof worktree === "object" && worktree !== null && (worktree as { detached?: unknown }).detached === true;
  return { primary, canPlan: primary || (record.role === "plan" && detached) };
}

export function gateRejection(command: GatedCommand, gate: WindowGate): string | undefined {
  const open = command === "agento.newInitiative" ? gate.primary : gate.canPlan;
  return open ? undefined : REJECTIONS[command];
}
