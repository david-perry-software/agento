import { randomUUID } from "node:crypto";

export type TreeIdScope = (...parts: string[]) => string;

// The nonce is fresh per activation so a new or reloaded window never matches remembered expansion state.
export function createTreeIdScope(nonce: string = randomUUID()): TreeIdScope {
  return (...parts) => `agento:${nonce}:${parts.join("/")}`;
}
