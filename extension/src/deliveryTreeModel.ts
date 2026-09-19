interface DeliverySteps {
  ticked: number;
  total: number;
}

interface PullRequest {
  number?: number;
  state?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  url?: string;
}

interface Owner {
  path?: string;
  role?: string;
  dirPrefix?: string | null;
  id?: string | null;
}

interface Workspace {
  path?: string;
  exists?: boolean;
}

interface Companion {
  path?: string;
  branch?: string;
  detached?: boolean;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  registered?: boolean;
}

export interface DeliveryTreeItem {
  type: string;
  slug: string;
  lifecycle: string;
  status: string;
  roadmap: string;
  description: string;
  tooltip: string;
}

export interface DeliveryTreeGroup {
  lifecycle: string;
  label: string;
  items: DeliveryTreeItem[];
}

export type DeliveryTreeModel =
  | { kind: "ready"; groups: DeliveryTreeGroup[]; warnings: string[] }
  | { kind: "empty"; message: string; warnings: string[] }
  | { kind: "error"; message: string; warnings: string[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
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

function optionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseSteps(record: UnknownRecord): DeliverySteps | null {
  const steps = optionalRecord(record, "steps");
  if (!steps) {
    return null;
  }
  const ticked = optionalNumber(steps, "ticked");
  const total = optionalNumber(steps, "total");
  if (ticked === undefined || total === undefined) {
    throw new Error("steps.ticked and steps.total must be numbers");
  }
  return { ticked, total };
}

function parsePullRequest(record: UnknownRecord, key: string): PullRequest | null {
  const pullRequest = optionalRecord(record, key);
  return pullRequest
    ? {
        number: optionalNumber(pullRequest, "number"),
        state: optionalString(pullRequest, "state"),
        isDraft: optionalBoolean(pullRequest, "isDraft"),
        mergeStateStatus: optionalString(pullRequest, "mergeStateStatus"),
        url: optionalString(pullRequest, "url"),
      }
    : null;
}

function formatPullRequest(pullRequest: PullRequest | null): string {
  if (!pullRequest) {
    return "none";
  }
  const parts = [pullRequest.number === undefined ? "PR" : `#${pullRequest.number}`];
  if (pullRequest.state) {
    parts.push(pullRequest.state);
  }
  if (pullRequest.isDraft) {
    parts.push("draft");
  }
  if (pullRequest.mergeStateStatus) {
    parts.push(pullRequest.mergeStateStatus);
  }
  if (pullRequest.url) {
    parts.push(pullRequest.url);
  }
  return parts.join(" ");
}

function formatOwner(owner: Owner | null): string {
  if (!owner) {
    return "none";
  }
  const identity = [owner.role, owner.dirPrefix, owner.id].filter((value) => value).join("/");
  return [identity, owner.path].filter((value) => value).join(" at ") || "present";
}

function formatWorkspace(workspace: Workspace | null): string {
  if (!workspace) {
    return "none";
  }
  return `${workspace.path ?? "unknown"} (${workspace.exists === false ? "missing" : "exists"})`;
}

function formatCompanion(companion: Companion | null): string {
  if (!companion) {
    return "none";
  }
  const state = [
    companion.registered === false ? "unregistered" : "registered",
    companion.detached ? "detached" : "attached",
    companion.dirty ? "dirty" : "clean",
    `ahead ${companion.ahead ?? "?"}`,
    `behind ${companion.behind ?? "?"}`,
  ];
  return `${companion.branch ?? "unknown"} at ${companion.path ?? "unknown"} (${state.join(", ")})`;
}

function lifecycleLabel(lifecycle: string): string {
  return lifecycle
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseItem(value: unknown): DeliveryTreeItem {
  if (!isRecord(value)) {
    throw new Error("each item must be an object");
  }
  const type = requiredString(value, "type");
  const slug = requiredString(value, "slug");
  const lifecycle = requiredString(value, "lifecycle");
  const status = requiredString(value, "status");
  const roadmap = requiredString(value, "roadmap");
  const steps = parseSteps(value);
  const pullRequest = parsePullRequest(value, "pr");
  const companionPullRequest = parsePullRequest(value, "companionPr");
  const ownerRecord = optionalRecord(value, "owner");
  const workspaceRecord = optionalRecord(value, "workspace");
  const companionRecord = optionalRecord(value, "companion");
  const owner: Owner | null = ownerRecord
    ? {
        path: optionalString(ownerRecord, "path"),
        role: optionalString(ownerRecord, "role"),
        dirPrefix: optionalString(ownerRecord, "dirPrefix") ?? null,
        id: optionalString(ownerRecord, "id") ?? null,
      }
    : null;
  const workspace: Workspace | null = workspaceRecord
    ? { path: optionalString(workspaceRecord, "path"), exists: optionalBoolean(workspaceRecord, "exists") }
    : null;
  const companion: Companion | null = companionRecord
    ? {
        path: optionalString(companionRecord, "path"),
        branch: optionalString(companionRecord, "branch"),
        detached: optionalBoolean(companionRecord, "detached"),
        dirty: optionalBoolean(companionRecord, "dirty"),
        ahead: optionalNumber(companionRecord, "ahead"),
        behind: optionalNumber(companionRecord, "behind"),
        registered: optionalBoolean(companionRecord, "registered"),
      }
    : null;
  const initiative = optionalString(value, "initiative");
  const progress = steps ? `${steps.ticked}/${steps.total}` : "no steps";
  const compactPullRequest = pullRequest
    ? `PR #${pullRequest.number ?? "?"}${pullRequest.isDraft ? " draft" : ""}`
    : "PR none";

  return {
    type,
    slug,
    lifecycle,
    status,
    roadmap,
    description: `${type} | ${progress} | ${status} | ${compactPullRequest}`,
    tooltip: [
      `Type: ${type}`,
      `Status: ${status}`,
      `Progress: ${progress}`,
      `Roadmap: ${roadmap}`,
      `PR: ${formatPullRequest(pullRequest)}`,
      `Companion PR: ${formatPullRequest(companionPullRequest)}`,
      `Owner: ${formatOwner(owner)}`,
      `Workspace: ${formatWorkspace(workspace)}`,
      `Companion: ${formatCompanion(companion)}`,
      `Initiative: ${initiative ?? "none"}`,
    ].join("\n"),
  };
}

export function createDeliveryTreeModel(value: unknown): DeliveryTreeModel {
  try {
    if (!isRecord(value) || value.status !== "ok") {
      throw new Error("status must be ok");
    }
    if (!Array.isArray(value.lifecycles) || !value.lifecycles.every((entry) => typeof entry === "string")) {
      throw new Error("lifecycles must be an array of strings");
    }
    if (!Array.isArray(value.items)) {
      throw new Error("items must be an array");
    }
    if (!Array.isArray(value.warnings) || !value.warnings.every((entry) => typeof entry === "string")) {
      throw new Error("warnings must be an array of strings");
    }

    const warnings = [...value.warnings];
    const items = value.items.map(parseItem);
    const groups = value.lifecycles.flatMap((lifecycle) => {
      const groupedItems = items.filter((item) => item.lifecycle === lifecycle);
      return groupedItems.length === 0 ? [] : [{ lifecycle, label: lifecycleLabel(lifecycle), items: groupedItems }];
    });
    if (items.length === 0) {
      return { kind: "empty", message: "No deliveries found.", warnings };
    }
    if (groups.reduce((count, group) => count + group.items.length, 0) !== items.length) {
      throw new Error("each item lifecycle must appear in lifecycles");
    }
    return { kind: "ready", groups, warnings };
  } catch (error) {
    return createDeliveryTreeError(error, "Invalid status --pr response");
  }
}

export function createDeliveryTreeError(error: unknown, prefix = "Unable to load deliveries"): DeliveryTreeModel {
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "error", message: `${prefix}: ${detail}`, warnings: [] };
}