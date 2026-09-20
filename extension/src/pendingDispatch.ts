import { isCanonicalAgentoCommand } from "./commandActions.js";

export const PENDING_DISPATCH_TTL_MS = 5 * 60 * 1000;

export interface PendingDispatchRecord {
  target: string;
  command: string;
  createdAt: number;
}

export interface PendingDispatchStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type PendingDispatchResult =
  | { kind: "none" }
  | { kind: "ready"; command: string }
  | { kind: "discarded"; reason: "expired" | "malformed" | "target-mismatch" };

const KEY_PREFIX = "agento.pendingDispatch:";

export function pendingDispatchKey(target: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(target)}`;
}

export async function savePendingDispatch(store: PendingDispatchStore, record: PendingDispatchRecord): Promise<void> {
  if (!record.target || !isCanonicalAgentoCommand(record.command) || !Number.isFinite(record.createdAt)) {
    throw new Error("pending dispatch record is invalid");
  }
  await store.update(pendingDispatchKey(record.target), record);
}

export async function takePendingDispatch(
  store: PendingDispatchStore,
  target: string,
  now = Date.now(),
): Promise<PendingDispatchResult> {
  const key = pendingDispatchKey(target);
  const value = store.get<unknown>(key);
  if (value === undefined) {
    return { kind: "none" };
  }

  await store.update(key, undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "discarded", reason: "malformed" };
  }
  const record = value as Record<string, unknown>;
  if (record.target !== target) {
    return { kind: "discarded", reason: "target-mismatch" };
  }
  if (!isCanonicalAgentoCommand(record.command) || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    return { kind: "discarded", reason: "malformed" };
  }
  if (record.createdAt > now || now - record.createdAt > PENDING_DISPATCH_TTL_MS) {
    return { kind: "discarded", reason: "expired" };
  }
  return { kind: "ready", command: record.command };
}