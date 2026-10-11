import { initiativeSlugs } from "./initiativeTreeModel.js";

type UnknownRecord = Record<string, unknown>;

export interface DashboardSections {
  session: unknown;
  doctor: unknown;
  deliveries: unknown;
  initiatives: { list: unknown; details: ReadonlyMap<string, unknown> } | Error;
  metrics: unknown;
  timings: Readonly<Record<string, number>> | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A section the CLI reports as { status: "error", message } becomes an Error for the view's error creator.
function section(document: UnknownRecord, name: string): unknown {
  const value = document[name];
  if (!isRecord(value)) {
    throw new Error(`dashboard.${name} must be an object`);
  }
  if (value.status === "error") {
    return new Error(typeof value.message === "string" ? value.message : `dashboard.${name} failed`);
  }
  return value;
}

function parseTimings(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

// Splits `agento.mjs dashboard` output into the documents the tree models consume.
export function splitDashboardDocument(json: unknown): DashboardSections {
  if (!isRecord(json) || json.status !== "ok") {
    throw new Error("Invalid dashboard response: status must be ok");
  }
  const session = section(json, "session");
  const doctor = section(json, "doctor");
  const deliveries = section(json, "deliveries");
  const initiativesSection = section(json, "initiatives");
  let initiatives: DashboardSections["initiatives"];
  if (initiativesSection instanceof Error) {
    initiatives = initiativesSection;
  } else {
    const { list, details } = initiativesSection as UnknownRecord;
    if (!isRecord(details)) {
      throw new Error("Invalid dashboard response: initiatives.details must be an object");
    }
    initiatives = {
      list,
      details: new Map(initiativeSlugs(list).filter((slug) => Object.hasOwn(details, slug)).map((slug) => [slug, details[slug]])),
    };
  }
  return { session, doctor, deliveries, initiatives, metrics: json.metrics === undefined ? null : section(json, "metrics"), timings: parseTimings(json.timings) };
}

export function formatDashboardTimings(timings: Readonly<Record<string, number>> | null): string | null {
  if (!timings) {
    return null;
  }
  const parts = Object.entries(timings).map(([name, ms]) => `${name} ${ms} ms`);
  return parts.length ? `dashboard timings: ${parts.join(", ")}` : null;
}
