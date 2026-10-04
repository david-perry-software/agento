export interface WindowGate {
  primary: boolean;
  canPlan: boolean;
}

export const CLOSED_GATE: WindowGate = { primary: false, canPlan: false };

export type GatedCommand = "agento.newPlan" | "agento.newInitiative" | "agento.planInitiativeMember";

export function windowGate(_session: unknown): WindowGate {
  return { primary: true, canPlan: true };
}

export function gateRejection(_command: GatedCommand, _gate: WindowGate): string | undefined {
  return undefined;
}
