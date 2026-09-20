import { projectCommandActions, type CommandAction } from "./commandActions.js";

export interface SessionSummary {
  role: string;
  lifecycle: string;
  worktreePath: string;
  branch: string;
  workspace: string;
}

export interface CompanionSummary {
  path: string;
  branch: string;
  state: string;
  sync: string;
}

export interface DoctorCheck {
  id: string;
  status: string;
  detail: string;
  fallback: string | null;
}

export type SessionDoctorModel =
  | {
      kind: "ready";
      session: SessionSummary;
      companion: CompanionSummary | null;
      warnings: string[];
      checks: DoctorCheck[];
      actions: CommandAction[];
      statusBarText: string;
    }
  | { kind: "error"; message: string; statusBarText: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function optionalRecord(record: UnknownRecord, key: string): UnknownRecord | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object or null`);
  }
  return value;
}

function requiredString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringValue(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requiredBoolean(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requiredNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function nullableString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function parseWorkspace(session: UnknownRecord): string {
  const workspace = optionalRecord(session, "workspace");
  if (!workspace) {
    return "none";
  }
  const path = requiredString(workspace, "path");
  return `${path} (${requiredBoolean(workspace, "exists") ? "exists" : "missing"})`;
}

function parseCompanion(session: UnknownRecord): CompanionSummary | null {
  const companion = optionalRecord(session, "companion");
  if (!companion) {
    return null;
  }
  return {
    path: requiredString(companion, "path"),
    branch: requiredString(companion, "branch"),
    state: [
      requiredBoolean(companion, "registered") ? "registered" : "unregistered",
      requiredBoolean(companion, "detached") ? "detached" : "attached",
      requiredBoolean(companion, "dirty") ? "dirty" : "clean",
    ].join(", "),
    sync: `ahead ${requiredNumber(companion, "ahead")}, behind ${requiredNumber(companion, "behind")}`,
  };
}

function parseChecks(doctor: UnknownRecord): DoctorCheck[] {
  if (!Array.isArray(doctor.checks)) {
    throw new Error("checks must be an array");
  }
  return doctor.checks.map((value) => {
    if (!isRecord(value)) {
      throw new Error("each check must be an object");
    }
    return {
      id: requiredString(value, "id"),
      status: requiredString(value, "status"),
      detail: stringValue(value, "detail"),
      fallback: nullableString(value, "fallback"),
    };
  });
}

export function createSessionDoctorModel(
  sessionValue: unknown,
  doctorValue: unknown,
  statusValue: unknown,
): SessionDoctorModel {
  try {
    if (!isRecord(sessionValue) || sessionValue.status !== "ok") {
      throw new Error("session.status must be ok");
    }
    if (!isRecord(doctorValue) || typeof doctorValue.status !== "string") {
      throw new Error("doctor.status must be a string");
    }
    if (!isRecord(statusValue) || statusValue.status !== "ok") {
      throw new Error("status.status must be ok");
    }
    if (!Array.isArray(sessionValue.warnings) || !sessionValue.warnings.every((entry) => typeof entry === "string")) {
      throw new Error("session.warnings must be an array of strings");
    }
    if (!Array.isArray(statusValue.resumable)) {
      throw new Error("status.resumable must be an array");
    }

    const worktree = requiredRecord(sessionValue, "worktree");
    const branch = nullableString(worktree, "branch");
    const role = requiredString(sessionValue, "role");
    return {
      kind: "ready",
      session: {
        role,
        lifecycle: requiredString(sessionValue, "lifecycle"),
        worktreePath: requiredString(worktree, "path"),
        branch: branch ?? "detached",
        workspace: parseWorkspace(sessionValue),
      },
      companion: parseCompanion(sessionValue),
      warnings: [...sessionValue.warnings],
      checks: parseChecks(doctorValue),
      actions: projectCommandActions(sessionValue),
      statusBarText: `Agento: ${role} · ${statusValue.resumable.length} active`,
    };
  } catch (error) {
    return createSessionDoctorError(error, "Invalid Session & Doctor response");
  }
}

export function createSessionDoctorError(error: unknown, prefix = "Unable to load Session & Doctor"): SessionDoctorModel {
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "error", message: `${prefix}: ${detail}`, statusBarText: "Agento: unavailable" };
}