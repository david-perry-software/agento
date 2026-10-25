import assert from "node:assert/strict";
import test from "node:test";

import { classifyMergeRefusal, missingRequired, requiredContexts } from "./merge-state.mjs";

test("classifyMergeRefusal matches gh v2.45.0's reason text and falls back to mergeStateStatus", () => {
  // gh's blockedReason wordings (pkg/cmd/pr/merge/merge.go).
  assert.equal(classifyMergeRefusal("X Pull request #15 is not mergeable: the base branch policy prohibits the merge.", "BLOCKED"), "blocked");
  assert.equal(classifyMergeRefusal("X Pull request #15 is not mergeable: the head branch is not up to date with the base branch.", "BEHIND"), "behind");
  assert.equal(classifyMergeRefusal("X Pull request #15 is not mergeable: the merge commit cannot be cleanly created.", "DIRTY"), "conflict");
  // A classic "merge conflict" reason also counts as a conflict.
  assert.equal(classifyMergeRefusal("Pull request #15 is not mergeable: merge conflict.", "DIRTY"), "conflict");
  // A draft refusal and an unrelated GraphQL failure are neither conflict nor blocked.
  assert.equal(classifyMergeRefusal("Pull request #15 is still a draft.", "CLEAN"), "other");
  assert.equal(classifyMergeRefusal("GraphQL: Something went wrong while executing your query (mergePullRequest)", null), "other");

  // The reason text wins over the status, and the status is the fallback when the
  // text is unrecognised.
  assert.equal(classifyMergeRefusal("the base branch policy prohibits the merge", "BEHIND"), "blocked");
  assert.equal(classifyMergeRefusal("some unknown wording", "DIRTY"), "conflict");
  assert.equal(classifyMergeRefusal("some unknown wording", "BEHIND"), "behind");
  assert.equal(classifyMergeRefusal("some unknown wording", "BLOCKED"), "blocked");
  assert.equal(classifyMergeRefusal("some unknown wording", "CLEAN"), "other");
  assert.equal(classifyMergeRefusal("", null), "other");
});

test("requiredContexts unions the ruleset and classic protection contexts; a 404 or empty result counts as none", () => {
  const ruleset = [
    { type: "deletion" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Vercel", integration_id: 1 }, { context: "Unit tests", integration_id: 2 }] } },
  ];
  const classic = { contexts: ["Unit tests", "Legacy CI"], checks: [{ context: "Docs build", app_id: 7 }] };

  // ruleset-only
  assert.deepEqual(requiredContexts(ruleset, null).sort(), ["Unit tests", "Vercel"].sort());
  // classic-only
  assert.deepEqual(requiredContexts(null, classic).sort(), ["Docs build", "Legacy CI", "Unit tests"].sort());
  // both: union, de-duplicated
  assert.deepEqual(requiredContexts(ruleset, classic).sort(), ["Docs build", "Legacy CI", "Unit tests", "Vercel"].sort());
  // 404 / empty / non-array: none
  assert.deepEqual(requiredContexts(null, null), []);
  assert.deepEqual(requiredContexts([], {}), []);
  assert.deepEqual(requiredContexts({}, { contexts: [] }), []);
  // Classic `contexts` of bare strings is accepted.
  assert.deepEqual(requiredContexts(null, { contexts: ["A", "B"], checks: [] }).sort(), ["A", "B"].sort());
});

test("missingRequired separates absent and pending contexts from failed ones, and passes are complete", () => {
  const required = ["Unit tests", "Vercel", "Deploy", "Lint"];
  const rollup = [
    { __typename: "CheckRun", name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "Vercel", status: "IN_PROGRESS", conclusion: null },
    { __typename: "CheckRun", name: "Deploy", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", context: "Lint", state: "SUCCESS" },
  ];
  assert.deepEqual(missingRequired(required, rollup), { absent: [], pending: ["Vercel"], failed: ["Deploy"] });

  // Absent contexts and a StatusContext that is pending.
  const required2 = ["Unit tests", "Vercel", "Deploy"];
  const rollup2 = [
    { __typename: "CheckRun", name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "Vercel", state: "PENDING" },
  ];
  assert.deepEqual(missingRequired(required2, rollup2), { absent: ["Deploy"], pending: ["Vercel"], failed: [] });

  // An empty rollup leaves every required context absent.
  assert.deepEqual(missingRequired(["A", "B"], []), { absent: ["A", "B"], pending: [], failed: [] });
  assert.deepEqual(missingRequired([], []), { absent: [], pending: [], failed: [] });
});
