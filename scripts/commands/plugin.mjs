// The `plugin` command family: export a clean plugin tree for VS Code to stage,
// and list/prune the staged snapshots VS Code keeps under `agentPlugins/`.
// Subcommands: export | snapshots | prune-snapshots.

import { emit, rest, usage } from "../lib/context.mjs";

function runExport(args) {
  emit({ status: "ok", subcommand: "export", stage: "registered" });
}

function runSnapshots(args) {
  emit({ status: "ok", subcommand: "snapshots", stage: "registered" });
}

function runPruneSnapshots(args) {
  emit({ status: "ok", subcommand: "prune-snapshots", stage: "registered" });
}

const SUBCOMMANDS = {
  export: runExport,
  snapshots: runSnapshots,
  "prune-snapshots": runPruneSnapshots,
};

export const commands = {
  plugin() {
    const [sub] = rest;
    const handler = SUBCOMMANDS[sub];
    if (!handler) usage(`plugin: unknown subcommand ${JSON.stringify(sub)}; known: export, snapshots, prune-snapshots`);
    handler(rest.slice(1));
  },
};
