"use strict";

// The model-variant table for the Agento Dispatch Probe's "Dispatch with model"
// command. `buildModelVariants(file, target)` is pure and deterministic: given the
// same `file` (the attachFiles element — a vscode.Uri in the extension host, a
// sentinel object in node:test) and a target `{ id, vendor, family }`, it returns
// the M1–M5 table from plan.md `## Approach` §1. The module has no VS Code
// dependency so node:test can assert it.

// The canonical dispatch query every model variant uses.
const CANONICAL_QUERY = "/agento delivery-status";

// Returns [{ id, payload, modelChangeCommand? }] for the five model variants, in
// order. M5's `modelChangeCommand` is `null` here — the extension host fills it
// with the first discovered `/chat.*model/i` command id (or leaves it `null`, which
// the host logs as `n/a`).
function buildModelVariants(file, target) {
  const base = { query: CANONICAL_QUERY, mode: "agent", attachFiles: [file] };
  return [
    {
      id: "M1",
      payload: { ...base, modelSelector: { vendor: target.vendor, id: target.id } },
    },
    {
      id: "M2",
      payload: { ...base, modelSelector: { vendor: target.vendor, family: target.family } },
    },
    {
      id: "M3",
      payload: { ...base, modelSelector: { id: target.id } },
    },
    {
      id: "M4",
      payload: { ...base, mode: "📋 Agento Planner", modelSelector: { vendor: target.vendor, id: target.id } },
    },
    {
      id: "M5",
      payload: { ...base },
      modelChangeCommand: null,
    },
  ];
}

module.exports = { CANONICAL_QUERY, buildModelVariants };
