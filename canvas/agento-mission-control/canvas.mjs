// Mission Control canvas definition. `defineMissionControl({ createCanvas,
// CanvasError, deps })` returns the SDK canvas declaration with the four agent
// actions (refresh, get_snapshot, focus, post_note), an idempotent `open` per
// instanceId, and an `onClose` that stops the instance's server and watcher.
//
// All logic lives here without importing the SDK, so node:test can exercise it
// with a fake `createCanvas` and `CanvasError`. The real wiring is
// extension.mjs, which joins the session and passes `send`/`log` through `deps`.

import path from "node:path";

import * as cli from "./cli.mjs";
import { startServer } from "./server.mjs";
import { diff, normalize } from "./snapshot.mjs";
import * as store from "./store.mjs";
import { startWatcher } from "./watch.mjs";

export const TITLE = "Mission Control";

const DESCRIPTION =
  "The Agento delivery kanban, initiative wave graph, timeline, worktree map, and live activity feed, with buttons that dispatch only the commands the CLI allows in this window.";

const DEFAULT_DEPS = {
  runDashboard: cli.runDashboard,
  normalize,
  diff,
  startServer,
  startWatcher,
  cloneRoot: cli.cloneRoot,
  send: async () => {},
  log: () => {},
  load: store.load,
  save: store.save,
  appendFeed: store.appendFeed,
  appendNote: store.appendNote,
  emptyStore: store.emptyStore,
  repoKeyFor: store.repoKeyFor,
  copilotHome: store.copilotHome,
};

function cliFailure(CanvasError, err) {
  const message = err?.message ?? String(err);
  return new CanvasError("cli", message);
}

function primaryClonePath(dashboard, fallback) {
  const worktrees = dashboard?.session?.worktrees ?? [];
  const primary = worktrees.find((wt) => wt?.isPrimary && (wt.repo === "product" || wt.repo === undefined));
  return primary?.path ?? dashboard?.root ?? dashboard?.session?.worktree?.path ?? fallback;
}

function watchPathsFor(dashboard) {
  const session = dashboard?.session ?? {};
  const worktrees = session.worktrees ?? [];
  const primary = worktrees.find((wt) => wt?.isPrimary && (wt.repo === "product" || wt.repo === undefined));
  const companion = session.companion;
  const paths = [];
  const productPath = primary?.path ?? session.worktree?.path;
  if (productPath) {
    paths.push(path.join(productPath, ".git", "refs"), path.join(productPath, ".git", "worktrees"));
  }
  const companionPath = companion?.path;
  if (companionPath) {
    for (const kind of ["features", "issues", "initiatives"]) {
      paths.push(path.join(companionPath, kind));
    }
    paths.push(path.join(companionPath, ".git", "refs"), path.join(companionPath, ".git", "worktrees"));
  }
  return paths;
}

function feedFor(stored) {
  const feed = Array.isArray(stored?.feed) ? stored.feed : [];
  const notes = Array.isArray(stored?.notes) ? stored.notes : [];
  return [...feed, ...notes].sort((a, b) => String(a?.at ?? "").localeCompare(String(b?.at ?? "")));
}

export function defineMissionControl({ createCanvas, CanvasError, deps = {} }) {
  const D = { ...DEFAULT_DEPS, ...deps };
  const instances = new Map();

  function requireInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError("not-found", `canvas instance ${instanceId} is not open`);
    return instance;
  }

  async function runDashboardSafe(instance, { pr }) {
    try {
      return await D.runDashboard({ pr, cwd: instance.cwd });
    } catch (err) {
      throw cliFailure(CanvasError, err);
    }
  }

  async function persistFeed(instance, events) {
    const loaded = D.load(instance.repoKey, { copilotHome: instance.copilotHome });
    if (!loaded.ok) throw new CanvasError("storage", loaded.message);
    let stored = loaded.store ?? D.emptyStore();
    for (const event of events) stored = D.appendFeed(stored, event);
    const saved = D.save(instance.repoKey, stored, { copilotHome: instance.copilotHome });
    if (!saved.ok) throw new CanvasError("storage", saved.message);
    return stored;
  }

  async function refresh(instance, { pr = false } = {}) {
    const dashboard = await runDashboardSafe(instance, { pr });
    const next = D.normalize(dashboard);
    const events = D.diff(instance.snapshot, next);
    const stored = await persistFeed(instance, events);
    instance.snapshot = next;
    instance.server.setState({ ...next, feed: feedFor(stored) });
    return next;
  }

  function laneCounts(snapshot) {
    return (snapshot?.lanes ?? []).map((lane) => ({ id: lane.id, label: lane.label, count: lane.cards?.length ?? 0 }));
  }

  return createCanvas({
    id: "agento-mission-control",
    displayName: "Agento Mission Control",
    description: DESCRIPTION,

    actions: [
      {
        name: "refresh",
        description: "Re-run the Agento dashboard and push the fresh state to the canvas, returning the lane counts.",
        inputSchema: {
          type: "object",
          properties: { pr: { type: "boolean", description: "Refresh pull-request state too." } },
          additionalProperties: false,
        },
        handler: async (ctx) => {
          const instance = requireInstance(ctx.instanceId);
          const snapshot = await refresh(instance, { pr: Boolean(ctx.input?.pr) });
          return { lanes: laneCounts(snapshot) };
        },
      },
      {
        name: "get_snapshot",
        description: "Return lane counts, in-flight deliveries with their steps and allowed commands, and each initiative's next member.",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async (ctx) => {
          const instance = requireInstance(ctx.instanceId);
          const snapshot = instance.snapshot ?? { lanes: [], cards: [], initiatives: [] };
          return {
            lanes: laneCounts(snapshot),
            inFlight: (snapshot.cards ?? [])
              .filter((card) => card.lane === "building" || card.lane === "in-review")
              .map((card) => ({
                slug: card.slug,
                status: card.status,
                steps: card.steps,
                allowed: card.allowed,
                nextStep: card.nextStep,
              })),
            initiatives: (snapshot.initiatives ?? []).map((initiative) => ({
              slug: initiative.slug,
              next: initiative.next,
            })),
          };
        },
      },
      {
        name: "focus",
        description: "Scroll to and highlight a delivery card, an initiative member node, or a worktree entry in the canvas.",
        inputSchema: {
          type: "object",
          required: ["kind", "id"],
          properties: {
            kind: { type: "string", enum: ["delivery", "initiative", "worktree"] },
            id: { type: "string" },
          },
          additionalProperties: false,
        },
        handler: async (ctx) => {
          const instance = requireInstance(ctx.instanceId);
          const kind = ctx.input?.kind;
          const id = String(ctx.input?.id ?? "");
          const snapshot = instance.snapshot ?? { cards: [], initiatives: [], worktrees: { entries: [] } };
          let found = false;
          if (kind === "delivery") found = (snapshot.cards ?? []).some((card) => card.slug === id);
          else if (kind === "initiative") found = (snapshot.initiatives ?? []).some((initiative) => (initiative.nodes ?? []).some((node) => node.slug === id));
          else if (kind === "worktree") found = (snapshot.worktrees?.entries ?? []).some((entry) => entry.path === id);
          if (!found) throw new CanvasError("not-found", `no ${kind} with id ${id}`);
          instance.server.broadcast("focus", { kind, id });
          return { ok: true, kind, id };
        },
      },
      {
        name: "post_note",
        description: "Append an escaped agent note to the persisted activity feed and push it to the canvas.",
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", maxLength: 500 },
            slug: { type: "string" },
            level: { type: "string", enum: ["info", "success", "warn"] },
          },
          additionalProperties: false,
        },
        handler: async (ctx) => {
          const instance = requireInstance(ctx.instanceId);
          const text = typeof ctx.input?.text === "string" ? ctx.input.text.trim() : "";
          if (!text) throw new CanvasError("invalid-note", "note text is required");
          if (text.length > 500) throw new CanvasError("invalid-note", "note text must be 500 characters or fewer");
          const note = {
            text,
            slug: typeof ctx.input?.slug === "string" ? ctx.input.slug : null,
            level: ctx.input?.level ?? "info",
          };
          const loaded = D.load(instance.repoKey, { copilotHome: instance.copilotHome });
          if (!loaded.ok) throw new CanvasError("storage", loaded.message);
          let stored = loaded.store ?? D.emptyStore();
          stored = D.appendNote(stored, note);
          const saved = D.save(instance.repoKey, stored, { copilotHome: instance.copilotHome });
          if (!saved.ok) throw new CanvasError("storage", saved.message);
          const stamped = stored.notes[stored.notes.length - 1];
          instance.server.broadcast("note", { ...note, at: stamped?.at ?? new Date().toISOString() });
          instance.server.setState({ ...(instance.snapshot ?? {}), feed: feedFor(stored) });
          return { ok: true };
        },
      },
    ],

    async open(ctx) {
      const instanceId = ctx.instanceId;
      const existing = instances.get(instanceId);
      if (existing) return { title: TITLE, status: "reopened", url: existing.url };

      const cwd = ctx.session?.workingDirectory ?? process.cwd();
      const instance = { cwd, repoKey: null, copilotHome: D.copilotHome(), snapshot: null, server: null, watcher: null, url: null };
      instances.set(instanceId, instance);

      try {
        const dashboard = await runDashboardSafe(instance, { pr: false });
        instance.repoKey = D.repoKeyFor(primaryClonePath(dashboard, D.cloneRoot?.() ?? cwd));
        const loaded = D.load(instance.repoKey, { copilotHome: instance.copilotHome });
        if (!loaded.ok) throw new CanvasError("storage", loaded.message);
        const stored = loaded.store ?? D.emptyStore();
        instance.snapshot = D.normalize(dashboard);

        instance.server = await D.startServer({
          send: async ({ prompt }) => {
            await D.send({ prompt });
          },
          onRefresh: async () => {
            await refresh(instance, { pr: false });
          },
          log: (line) => D.log(line),
        });
        instance.url = instance.server.url;
        instance.server.setState({ ...instance.snapshot, feed: feedFor(stored) });

        instance.watcher = D.startWatcher({
          watchPaths: watchPathsFor(dashboard),
          onChange: async ({ pr }) => {
            await refresh(instance, { pr: Boolean(pr) });
          },
          onError: (err) => {
            D.log(`Mission Control background refresh failed: ${err?.message ?? err}`);
          },
          pr: true,
        });

        await D.log(`Mission Control opened at ${instance.url} (instance ${instanceId})`);
        return { title: TITLE, status: "live", url: instance.url };
      } catch (err) {
        if (instance.watcher) instance.watcher.stop();
        if (instance.server) await instance.server.close();
        instances.delete(instanceId);
        throw err;
      }
    },

    async onClose(ctx) {
      const instance = instances.get(ctx.instanceId);
      if (!instance) return;
      if (instance.watcher) instance.watcher.stop();
      if (instance.server) await instance.server.close();
      instances.delete(ctx.instanceId);
    },
  });
}
