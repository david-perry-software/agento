import test from "node:test";
import assert from "node:assert/strict";

import probeVariants from "./dispatch-probe/variants.js";

const { CANONICAL_QUERY, buildVariants } = probeVariants;

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
