"use strict";

// The dispatch variant table for the Agento Dispatch Probe.
//
// `buildVariants(file)` is pure and deterministic: given the same `file` (the
// attachFiles element — a vscode.Uri in the extension host, a sentinel object in
// node:test), it returns the V1–V8 table from plan.md `## Approach` §1. The
// module has no VS Code dependency so node:test can assert it.

// The canonical dispatch query every variant uses, except V8 (trailing space).
const CANONICAL_QUERY = "/agento delivery-status";
// V8 keeps the same command with a trailing space, matching the plan.
const CANONICAL_QUERY_TRAILING = "/agento delivery-status ";

// Returns [{ id, payload, followUp? }] for the eight variants, in order. V6 is
// the only variant with a follow-up command (workbench.action.chat.submit).
function buildVariants(file) {
  return [
    { id: "V1", payload: { query: CANONICAL_QUERY, mode: "agent", attachFiles: [file] } },
    { id: "V2", payload: { query: CANONICAL_QUERY } },
    { id: "V3", payload: { query: CANONICAL_QUERY, mode: "agent" } },
    { id: "V4", payload: { query: CANONICAL_QUERY, attachFiles: [file] } },
    { id: "V5", payload: { query: CANONICAL_QUERY, preserveInput: true } },
    {
      id: "V6",
      payload: { query: CANONICAL_QUERY, mode: "agent", attachFiles: [file], isPartialQuery: true },
      followUp: "workbench.action.chat.submit",
    },
    { id: "V7", payload: { query: CANONICAL_QUERY, mode: "🔍 Agento Reviewer" } },
    { id: "V8", payload: { query: CANONICAL_QUERY_TRAILING, mode: "agent", attachFiles: [file] } },
  ];
}

module.exports = { CANONICAL_QUERY, CANONICAL_QUERY_TRAILING, buildVariants };
