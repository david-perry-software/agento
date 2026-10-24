// Pure split of Mission Control's commands into window-wide header actions and
// per-delivery card actions. No DOM, so node:test imports it directly.
//
// A command is delivery-specific when one of its arguments names a delivery or
// initiative (`ship widget`, `start-session feature/widget --resume`); those stay
// on the card. Everything else (`continue`, `delivery-status`, `new-feature`,
// `finish-freehand <session-id>`, …) acts on the window, so it lives in the header.
// Header actions come from this window's `session.allowed` / `session.elsewhere`
// only — a card's lists are computed for the window that owns that delivery.

// Window-wide actions the header always lists, enabled or not, in this order.
export const HEADER_CATALOG = Object.freeze([
  "continue",
  "delivery-status",
  "next-feature",
  "start-session",
  "start-freehand",
  "new-feature",
  "new-issue",
  "new-initiative",
]);

export function commandName(command) {
  const match = /^\/agento\s+([a-z0-9-]+)/.exec(String(command ?? ""));
  return match ? match[1] : null;
}

function commandArgs(command) {
  return String(command ?? "").trim().split(/\s+/).slice(2);
}

export function knownSlugs(state) {
  const slugs = new Set();
  for (const card of state?.cards ?? []) if (card?.slug) slugs.add(card.slug);
  for (const initiative of state?.initiatives ?? []) {
    if (initiative?.slug) slugs.add(initiative.slug);
    for (const node of initiative?.nodes ?? []) if (node?.slug) slugs.add(node.slug);
  }
  return slugs;
}

export function isDeliverySpecific(command, slugs) {
  return commandArgs(command).some((arg) => {
    if (slugs.has(arg)) return true;
    const slash = arg.lastIndexOf("/");
    return slash !== -1 && slugs.has(arg.slice(slash + 1));
  });
}

// Card buttons: only the commands that act on this delivery.
export function cardCommands(card, slugs) {
  const specific = (command) => isDeliverySpecific(command, slugs);
  return {
    allowed: (card?.allowed ?? []).filter(specific),
    elsewhere: (card?.elsewhere ?? []).filter((entry) => specific(entry?.command)),
  };
}

function baseName(p) {
  const parts = String(p ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// "the build window (plan-20261023-204459)" / "the primary window".
export function describeWindow(role, worktreePath = null) {
  const name = baseName(worktreePath);
  return `the ${role ?? "owning"} window${name ? ` (${name})` : ""}`;
}

// A card's lists are computed by the CLI for the window that owns the delivery:
// its worktree when it has one, otherwise the primary checkout. They are runnable
// here only when this canvas belongs to that window.
export function isOwningWindow(card, session) {
  const here = session?.worktree?.path ?? null;
  if (card?.owner?.path) return here != null && card.owner.path === here;
  return session?.role === "primary";
}

// The primary product checkout's path, from the snapshot's worktree map.
export function primaryCheckout(state) {
  const entries = state?.worktrees?.entries ?? [];
  const primary = entries.find((w) => w?.isPrimary && (w.repo ?? "product") === "product");
  return primary?.path ?? null;
}

// A handoff target is a registered checkout other than this window's own.
function otherCheckout(checkout, session) {
  return checkout && checkout !== (session?.worktree?.path ?? null) ? checkout : null;
}

// Card buttons with availability for *this* window:
// [{ command, enabled, reason, checkout, windowName }]. Allowed commands of a
// delivery another window owns, and every `elsewhere` entry, are listed disabled
// with the window they must run from; `checkout` names that window's checkout
// when Mission Control can open it (`agento.mjs handoff`), else null.
export function cardButtons(card, session, slugs, primary = null) {
  const { allowed, elsewhere } = cardCommands(card, slugs);
  const owned = Boolean(card?.owner?.path);
  const owningWindow = owned ? describeWindow(card.owner.role, card.owner.path) : describeWindow("primary");
  const owningCheckout = otherCheckout(owned ? card.owner.path : primary, session);
  const here = isOwningWindow(card, session);
  const buttons = allowed.map((command) => ({
    command,
    enabled: here,
    reason: here ? null : `Runs in ${owningWindow}`,
    checkout: here ? null : owningCheckout,
    windowName: here ? null : owningWindow,
  }));
  for (const entry of elsewhere) {
    const secondaryOwner = owned && card.owner.role !== "primary";
    const target = entry.window === "secondary"
      ? (secondaryOwner ? describeWindow(card.owner.role, card.owner.path) : "the delivery's plan or build window")
      : describeWindow(entry.window ?? "another");
    const checkout = entry.window === "primary" ? primary : entry.window === "secondary" && secondaryOwner ? card.owner.path : null;
    buttons.push({
      command: entry.command,
      enabled: false,
      reason: `Runs in ${target}${entry.reason ? ` — ${entry.reason}` : ""}`,
      checkout: otherCheckout(checkout, session),
      windowName: target,
    });
  }
  return buttons;
}

// Header actions: [{ command, label, enabled, reason, checkout, windowName }].
// Enabled entries are exactly the window-wide commands in `session.allowed` (so the
// server's allowlist accepts them); catalog entries this window does not allow are
// listed disabled, with the CLI's `elsewhere` reason when it gives one. The catalog
// is the primary window's create/status set, so outside the primary window a
// disabled entry hands off to the primary checkout.
export function headerActions(state) {
  const slugs = knownSlugs(state);
  const session = state?.session ?? {};
  const role = session.role ?? "this";
  const primary = primaryCheckout(state);
  const allowed = (session.allowed ?? []).filter((command) => typeof command === "string" && !isDeliverySpecific(command, slugs));
  const elsewhere = (session.elsewhere ?? []).filter((entry) => typeof entry?.command === "string" && !isDeliverySpecific(entry.command, slugs));

  const actions = [];
  const listed = new Set();
  const add = (action) => {
    if (listed.has(action.command)) return;
    listed.add(action.command);
    actions.push(action);
  };
  const label = (command) => String(command).replace(/^\/agento\s+/, "");
  const run = (command) => ({ command, label: label(command), enabled: true, reason: null, checkout: null, windowName: null });
  const away = (entry) => ({
    command: entry.command,
    label: label(entry.command),
    enabled: false,
    reason: `runs in ${entry.window ?? "another"} window${entry.reason ? ` — ${entry.reason}` : ""}`,
    checkout: entry.window === "primary" ? otherCheckout(primary, session) : null,
    windowName: describeWindow(entry.window ?? "another"),
  });

  for (const name of HEADER_CATALOG) {
    const enabled = allowed.filter((command) => commandName(command) === name);
    for (const command of enabled) add(run(command));
    if (enabled.length) continue;
    const elsewhereEntry = elsewhere.find((entry) => commandName(entry.command) === name);
    if (elsewhereEntry) add(away(elsewhereEntry));
    else {
      const checkout = role === "primary" ? null : otherCheckout(primary, session);
      add({
        command: `/agento ${name}`,
        label: name,
        enabled: false,
        reason: `not available in the ${role} window`,
        checkout,
        windowName: checkout ? describeWindow("primary") : null,
      });
    }
  }
  for (const command of allowed) add(run(command));
  for (const entry of elsewhere) add(away(entry));

  // Enabled first, keeping catalog order within each group.
  return [...actions.filter((a) => a.enabled), ...actions.filter((a) => !a.enabled)];
}

// Every command Mission Control may hand off from this window, mapped to the
// checkout whose window runs it: the greyed card commands of active deliveries
// and the greyed header actions. The server accepts POST /handoff only for these
// commands and derives the checkout from here, never from the request.
export function handoffTargets(state) {
  const slugs = knownSlugs(state);
  const session = state?.session ?? {};
  const primary = primaryCheckout(state);
  const targets = new Map();
  const add = (button) => {
    if (!button.enabled && button.checkout && !targets.has(button.command)) {
      targets.set(button.command, { checkout: button.checkout, windowName: button.windowName });
    }
  };
  for (const card of state?.cards ?? []) {
    if (card?.lane === "shipped") continue;
    for (const button of cardButtons(card, session, slugs, primary)) add(button);
  }
  for (const action of headerActions(state)) add(action);
  return targets;
}
