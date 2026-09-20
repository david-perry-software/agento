export type InitiativeGroupKind = "ready" | "in-flight" | "blocked" | "complete";

export interface InitiativeMemberItem {
  slug: string;
  state: string;
  roadmap: string | null;
  branch: string;
  wave: number | null;
  computedWave: number | null;
  blockedBy: string[];
  ready: boolean;
  description: string;
  tooltip: string;
}

export interface InitiativeMemberGroup {
  kind: InitiativeGroupKind;
  label: string;
  items: InitiativeMemberItem[];
}

export interface InitiativeDiagnostic {
  kind: "error" | "anomaly";
  message: string;
}

export interface InitiativeTreeItem {
  slug: string;
  dir: string;
  breakdown?: string;
  valid: boolean;
  done: boolean;
  description: string;
  tooltip: string;
  groups: InitiativeMemberGroup[];
  diagnostics: InitiativeDiagnostic[];
}

export type InitiativeTreeModel =
  | { kind: "ready"; items: InitiativeTreeItem[] }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

type UnknownRecord = Record<string, unknown>;

interface InitiativeListItem {
  slug: string;
  dir: string;
  total: number;
  complete: number;
  inFlight: number;
  ready: number;
  done: boolean;
  valid: boolean;
}

interface InitiativeDetail {
  status: "ok" | "invalid";
  breakdown: string;
  next: string | null;
  features: InitiativeMemberItem[];
  diagnostics: InitiativeDiagnostic[];
}

const GROUPS: ReadonlyArray<{ kind: InitiativeGroupKind; label: string }> = [
  { kind: "ready", label: "Ready" },
  { kind: "in-flight", label: "In flight" },
  { kind: "blocked", label: "Blocked" },
  { kind: "complete", label: "Complete" },
];

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

function requiredNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
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

function nullableString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function nullableNumber(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${key} must be a number or null`);
  }
  return value;
}

function stringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return [...value];
}

function parseListItem(value: unknown): InitiativeListItem {
  if (!isRecord(value)) {
    throw new Error("each list item must be an object");
  }
  return {
    slug: requiredString(value, "slug"),
    dir: requiredString(value, "dir"),
    total: requiredNumber(value, "total"),
    complete: requiredNumber(value, "complete"),
    inFlight: requiredNumber(value, "inFlight"),
    ready: requiredNumber(value, "ready"),
    done: requiredBoolean(value, "done"),
    valid: requiredBoolean(value, "valid"),
  };
}

function groupFor(member: InitiativeMemberItem): InitiativeGroupKind {
  if (member.state === "complete") {
    return "complete";
  }
  if (member.state !== "unplanned") {
    return "in-flight";
  }
  return member.ready ? "ready" : "blocked";
}

function parseMember(value: unknown, next: string | null): InitiativeMemberItem {
  if (!isRecord(value)) {
    throw new Error("each feature must be an object");
  }
  const slug = requiredString(value, "slug");
  const state = requiredString(value, "state");
  const roadmap = nullableString(value, "roadmap");
  const branch = requiredString(value, "branch");
  const wave = nullableNumber(value, "wave");
  const computedWave = nullableNumber(value, "computedWave");
  const blockedBy = stringArray(value, "blockedBy");
  const ready = requiredBoolean(value, "ready");
  const displayWave = wave ?? computedWave;
  const description = [state, displayWave === null ? "wave ?" : `wave ${displayWave}`, blockedBy.length ? `blocked by ${blockedBy.join(", ")}` : ready ? "ready" : undefined]
    .filter((part) => part !== undefined)
    .join(" | ");
  return {
    slug,
    state,
    roadmap,
    branch,
    wave,
    computedWave,
    blockedBy,
    ready,
    description,
    tooltip: [
      `State: ${state}`,
      `Wave: ${wave ?? "none"}`,
      `Computed wave: ${computedWave ?? "none"}`,
      `Blocked by: ${blockedBy.length ? blockedBy.join(", ") : "none"}`,
      `Ready: ${ready ? "yes" : "no"}`,
      `Next: ${next === slug ? "yes" : "no"}`,
      `Roadmap: ${roadmap ?? "none"}`,
    ].join("\n"),
  };
}

function parseDetail(value: unknown, expectedSlug: string): InitiativeDetail {
  if (value instanceof Error) {
    throw value;
  }
  if (!isRecord(value) || (value.status !== "ok" && value.status !== "invalid")) {
    throw new Error("status must be ok or invalid");
  }
  if (!isRecord(value.initiative)) {
    throw new Error("initiative must be an object");
  }
  const slug = requiredString(value.initiative, "slug");
  if (slug !== expectedSlug) {
    throw new Error(`initiative.slug must be ${expectedSlug}`);
  }
  const breakdown = requiredString(value.initiative, "breakdown");
  const next = nullableString(value, "next");
  if (!Array.isArray(value.features)) {
    throw new Error("features must be an array");
  }
  const errors = stringArray(value, "errors");
  if (!Array.isArray(value.anomalies)) {
    throw new Error("anomalies must be an array");
  }
  const anomalies = value.anomalies.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("each anomaly must be an object");
    }
    const anomalySlug = requiredString(entry, "slug");
    const anomalyKind = requiredString(entry, "kind");
    const anomalyBranch = requiredString(entry, "branch");
    return { kind: "anomaly" as const, message: `${anomalySlug}: ${anomalyKind} (${anomalyBranch})` };
  });
  return {
    status: value.status,
    breakdown,
    next,
    features: value.features.map((feature) => parseMember(feature, next)),
    diagnostics: [
      ...errors.map((message) => ({ kind: "error" as const, message })),
      ...anomalies,
    ],
  };
}

function initiativeDescription(item: InitiativeListItem): string {
  const parts = [`${item.complete}/${item.total} complete`, `${item.inFlight} in flight`, `${item.ready} ready`];
  if (item.done) {
    parts.push("done");
  }
  if (!item.valid) {
    parts.push("invalid");
  }
  return parts.join(" | ");
}

export function createInitiativeTreeModel(listValue: unknown, detailValues: ReadonlyMap<string, unknown>): InitiativeTreeModel {
  try {
    if (!isRecord(listValue) || listValue.status !== "ok") {
      throw new Error("status must be ok");
    }
    if (!Array.isArray(listValue.items)) {
      throw new Error("items must be an array");
    }
    const listItems = listValue.items.map(parseListItem);
    if (listItems.length === 0) {
      return { kind: "empty", message: "No initiatives found." };
    }
    const items = listItems.map((listItem): InitiativeTreeItem => {
      try {
        if (!detailValues.has(listItem.slug)) {
          throw new Error("detail response is missing");
        }
        const detail = parseDetail(detailValues.get(listItem.slug), listItem.slug);
        const groups = GROUPS.flatMap(({ kind, label }) => {
          const groupedItems = detail.features.filter((member) => groupFor(member) === kind);
          return groupedItems.length === 0 ? [] : [{ kind, label, items: groupedItems }];
        });
        const valid = listItem.valid && detail.status === "ok";
        return {
          slug: listItem.slug,
          dir: listItem.dir,
          breakdown: detail.breakdown,
          valid,
          done: listItem.done,
          description: initiativeDescription({ ...listItem, valid }),
          tooltip: [
            `Progress: ${listItem.complete}/${listItem.total}`,
            `In flight: ${listItem.inFlight}`,
            `Ready: ${listItem.ready}`,
            `Done: ${listItem.done ? "yes" : "no"}`,
            `Valid: ${valid ? "yes" : "no"}`,
            `Next: ${detail.next ?? "none"}`,
            `Breakdown: ${detail.breakdown}`,
          ].join("\n"),
          groups,
          diagnostics: detail.diagnostics,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          slug: listItem.slug,
          dir: listItem.dir,
          valid: false,
          done: listItem.done,
          description: initiativeDescription({ ...listItem, valid: false }),
          tooltip: `Unable to load detail: ${detail}`,
          groups: [],
          diagnostics: [{ kind: "error", message: `Unable to load detail: ${detail}` }],
        };
      }
    });
    return { kind: "ready", items };
  } catch (error) {
    return createInitiativeTreeError(error, "Invalid initiative list response");
  }
}

export function initiativeSlugs(listValue: unknown): string[] {
  if (!isRecord(listValue) || listValue.status !== "ok" || !Array.isArray(listValue.items)) {
    return [];
  }
  return listValue.items.flatMap((item) => isRecord(item) && typeof item.slug === "string" ? [item.slug] : []);
}

export function createInitiativeTreeError(error: unknown, prefix = "Unable to load initiatives"): InitiativeTreeModel {
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "error", message: `${prefix}: ${detail}` };
}