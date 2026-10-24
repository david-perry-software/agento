// Pure summary of the current window for the banner at the top of Mission
// Control: which kind of Agento window this is, what it is for, and what it
// holds. No DOM, so node:test imports it directly.

export const WINDOW_KINDS = Object.freeze({
  primary: { label: "Primary window", purpose: "The main checkout: plan, start sessions, and ship." },
  plan: { label: "Plan window", purpose: "A plan worktree: shape a new feature or issue here." },
  build: { label: "Build window", purpose: "A delivery worktree: build and review its delivery here." },
  freehand: { label: "Freehand window", purpose: "A freehand worktree: ad-hoc changes, wrapped up with finish-freehand." },
  unmanaged: { label: "Not an Agento window", purpose: "Open the primary checkout or a managed worktree to run delivery commands." },
});

const UNKNOWN = { label: "Window unknown", purpose: "Waiting for the session record." };

export function windowSummary(session) {
  const role = session?.role ?? null;
  const kind = (role && WINDOW_KINDS[role]) || UNKNOWN;
  const worktree = session?.worktree ?? null;
  const delivery = session?.delivery ?? null;

  const details = [];
  if (worktree) {
    const branch = worktree.detached || !worktree.branch ? "detached HEAD" : worktree.branch;
    details.push({ label: "Branch", value: branch });
  }
  if (delivery?.slug) {
    const status = session?.lifecycle && session.lifecycle !== "no-delivery" ? ` (${session.lifecycle})` : "";
    details.push({ label: "Delivery", value: `${delivery.type ?? "feature"} ${delivery.slug}${status}` });
  } else if (role === "freehand" && worktree?.id) {
    details.push({ label: "Session", value: worktree.id });
  }
  if (worktree?.path) details.push({ label: "Worktree", value: worktree.path });

  return {
    role: role && WINDOW_KINDS[role] ? role : "unavailable",
    label: kind.label,
    purpose: kind.purpose,
    hosted: Boolean(session?.hosted),
    details,
  };
}
