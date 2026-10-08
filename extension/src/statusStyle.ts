export interface StatusStyle {
  icon: string;
  color?: string;
}

const LIFECYCLE_STYLES: Record<string, StatusStyle> = {
  planned: { icon: "circle-large-outline", color: "agento.status.planned" },
  building: { icon: "sync", color: "agento.status.building" },
  paused: { icon: "debug-pause", color: "agento.status.paused" },
  "in-review": { icon: "eye", color: "agento.status.inReview" },
  approved: { icon: "check", color: "agento.status.approved" },
  shipped: { icon: "pass-filled", color: "agento.status.shipped" },
  "post-ship-pending": { icon: "clock", color: "agento.status.postShipPending" },
};

const INITIATIVE_GROUP_STYLES: Record<"ready" | "in-flight" | "blocked" | "complete", StatusStyle> = {
  ready: { icon: "play-circle", color: "agento.status.ready" },
  "in-flight": { icon: "sync", color: "agento.status.inFlight" },
  blocked: { icon: "lock", color: "agento.status.blocked" },
  complete: { icon: "pass-filled", color: "agento.status.complete" },
};

const HEALTH_STYLES = {
  ok: { icon: "pass", color: "agento.health.ok" },
  warn: { icon: "warning", color: "agento.health.warn" },
  fail: { icon: "error", color: "agento.health.fail" },
} satisfies Record<string, StatusStyle>;

export function lifecycleStyle(lifecycle: string): StatusStyle {
  return Object.hasOwn(LIFECYCLE_STYLES, lifecycle) ? { ...LIFECYCLE_STYLES[lifecycle]! } : { icon: "folder" };
}

export function initiativeGroupStyle(kind: keyof typeof INITIATIVE_GROUP_STYLES): StatusStyle {
  return { ...INITIATIVE_GROUP_STYLES[kind] };
}

export function healthStyle(status: string): StatusStyle {
  if (status === "ok") return { ...HEALTH_STYLES.ok };
  if (status === "warn") return { ...HEALTH_STYLES.warn };
  return { ...HEALTH_STYLES.fail };
}

export const STATUS_COLOR_IDS: readonly string[] = [
  ...new Set(
    [...Object.values(LIFECYCLE_STYLES), ...Object.values(INITIATIVE_GROUP_STYLES), ...Object.values(HEALTH_STYLES)]
      .map((style) => style.color)
      .filter((color): color is string => color !== undefined),
  ),
];
