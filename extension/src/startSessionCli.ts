import { START_SESSION_TIMEOUT_MS, type CliClient } from "./cliClient.js";

export type StartSessionTarget = { kind: "folder" | "workspace"; path: string };

export type StartSessionOutcome =
  | { kind: "ok"; target: StartSessionTarget; outcome: string | null; warnings: string[] }
  | { kind: "error"; reason: string };

// Runs `agento.mjs start-session <args> --no-open` in `root` (the primary checkout);
// the caller opens the returned target itself so it can queue a pending command first.
export type StartSessionRunner = (args: string[], root: string) => Promise<unknown>;

export function cliStartSession(client: Pick<CliClient, "run">): StartSessionRunner {
  return async (args, root) => (await client.run(["start-session", ...args, "--no-open"], root, { timeoutMs: START_SESSION_TIMEOUT_MS })).json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function parseStartSessionResult(value: unknown): StartSessionOutcome {
  if (!isRecord(value)) return { kind: "error", reason: "start-session returned no result" };
  if (value.status === "ok") {
    const target = value.target;
    if (!isRecord(target) || (target.kind !== "folder" && target.kind !== "workspace") || !text(target.path)) {
      return { kind: "error", reason: "start-session reported no target to open" };
    }
    return {
      kind: "ok",
      target: { kind: target.kind, path: target.path as string },
      outcome: text(value.outcome),
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((w): w is string => typeof w === "string") : [],
    };
  }
  if (value.status === "rejected") {
    const fallback = text(value.fallback);
    return { kind: "error", reason: `${text(value.reason) ?? "start-session was rejected"}${fallback ? ` (${fallback})` : ""}` };
  }
  if (value.status === "failed") {
    const parts = [`${text(value.reason) ?? "failed"}: ${text(value.message) ?? "start-session failed"}`];
    const fix = text(value.fix);
    const reauth = text(value.reauth);
    if (fix) parts.push(`Fix: ${fix}`);
    if (reauth) parts.push(`Re-authenticate: ${reauth}`);
    return { kind: "error", reason: parts.join(". ") };
  }
  return { kind: "error", reason: text(value.message) ?? `start-session returned status ${String(value.status)}` };
}

// One call that never throws: CLI failures (spawn, timeout, invalid JSON) become errors too.
export async function runStartSession(runner: StartSessionRunner, args: string[], root: string): Promise<StartSessionOutcome> {
  try {
    return parseStartSessionResult(await runner(args, root));
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}
