import test from "node:test";
import assert from "node:assert/strict";

import probeVariants from "./dispatch-probe/variants.js";
import modelVariants from "./dispatch-probe/model-variants.js";

const { CANONICAL_QUERY, buildVariants } = probeVariants;
const { buildModelVariants } = modelVariants;

// A target model for the model-variant table, in the shape the extension host
// derives from the picked vscode.lm entry.
const target = { id: "gpt-5.6-luna", vendor: "copilot", family: "gpt-5.6" };

// A stand-in for the vscode.Uri the extension host passes as the attachFiles
// element; the variant table is pure and must pass it through untouched.
const sentinel = { $uri: "/plugin/skills/agento/commands/delivery-status.md" };

test("every variant id is unique", () => {
  const ids = buildVariants(sentinel).map((variant) => variant.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"]);
});

test("every variant query is the canonical /agento delivery-status (V8 keeps its trailing space)", () => {
  for (const variant of buildVariants(sentinel)) {
    const expected = variant.id === "V8" ? "/agento delivery-status " : CANONICAL_QUERY;
    assert.equal(variant.payload.query, expected, `${variant.id} query`);
  }
});

test("V1 equals today's chat.open payload shape {query, mode: 'agent', attachFiles}", () => {
  const [v1] = buildVariants(sentinel);
  assert.deepEqual(v1.payload, { query: CANONICAL_QUERY, mode: "agent", attachFiles: [sentinel] });
});

test("V5 carries no attachFiles", () => {
  const v5 = buildVariants(sentinel).find((variant) => variant.id === "V5");
  assert.ok(v5, "V5 is present");
  assert.ok(!("attachFiles" in v5.payload), "V5 must not carry attachFiles");
});

test("V6 is the only variant with a submit follow-up", () => {
  for (const variant of buildVariants(sentinel)) {
    if (variant.id === "V6") {
      assert.equal(variant.followUp, "workbench.action.chat.submit");
    } else {
      assert.ok(!("followUp" in variant), `${variant.id} must not carry a follow-up`);
    }
  }
});

test("every model variant id is unique", () => {
  const ids = buildModelVariants(sentinel, target).map((variant) => variant.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["M1", "M2", "M3", "M4", "M5"]);
});

test("M1–M4 carry V1's query, attachFiles, and the canonical /agento delivery-status", () => {
  for (const variant of buildModelVariants(sentinel, target).filter((entry) => entry.id !== "M5")) {
    assert.equal(variant.payload.query, CANONICAL_QUERY, `${variant.id} query`);
    assert.deepEqual(variant.payload.attachFiles, [sentinel], `${variant.id} attachFiles`);
  }
});

test("M1 has modelSelector { vendor, id }", () => {
  const [m1] = buildModelVariants(sentinel, target);
  assert.deepEqual(m1.payload.modelSelector, { vendor: "copilot", id: "gpt-5.6-luna" });
});

test("M2 has modelSelector { vendor, family }", () => {
  const m2 = buildModelVariants(sentinel, target).find((variant) => variant.id === "M2");
  assert.deepEqual(m2.payload.modelSelector, { vendor: "copilot", family: "gpt-5.6" });
});

test("M3 has modelSelector { id }", () => {
  const m3 = buildModelVariants(sentinel, target).find((variant) => variant.id === "M3");
  assert.deepEqual(m3.payload.modelSelector, { id: "gpt-5.6-luna" });
});

test("M4 has mode '📋 Agento Planner'", () => {
  const m4 = buildModelVariants(sentinel, target).find((variant) => variant.id === "M4");
  assert.equal(m4.payload.mode, "📋 Agento Planner");
});

test("M5 carries V1's payload and a null model-change command until the host fills it", () => {
  const m5 = buildModelVariants(sentinel, target).find((variant) => variant.id === "M5");
  assert.deepEqual(m5.payload, { query: CANONICAL_QUERY, mode: "agent", attachFiles: [sentinel] });
  assert.equal(m5.modelChangeCommand, null);
});
