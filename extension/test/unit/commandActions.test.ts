import assert from "node:assert/strict";
import test from "node:test";

import { projectCommandActions } from "../../src/commandActions.js";

test("projects allowed and elsewhere actions in CLI order", () => {
  assert.deepEqual(
    projectCommandActions({
      allowed: ["/agento continue", "/agento build-feature widget", "/agento ap widget"],
      elsewhere: [
        { command: "/agento ship widget", window: "primary", reason: "ship from the primary window" },
        { command: "/agento review-feature widget", window: "secondary", reason: "review in the owning worktree" },
      ],
    }),
    [
      { command: "/agento continue", window: "here", reason: null },
      { command: "/agento build-feature widget", window: "here", reason: null },
      { command: "/agento ap widget", window: "here", reason: null },
      { command: "/agento ship widget", window: "primary", reason: "ship from the primary window" },
      { command: "/agento review-feature widget", window: "secondary", reason: "review in the owning worktree" },
    ],
  );
});

test("projects empty action arrays", () => {
  assert.deepEqual(projectCommandActions({ allowed: [], elsewhere: [] }), []);
});

test("rejects malformed action records without a lifecycle command allowlist", () => {
  for (const value of [
    null,
    {},
    { allowed: ["/build-feature widget"], elsewhere: [] },
    { allowed: ["/agento build-feature.prompt widget"], elsewhere: [] },
    { allowed: [], elsewhere: ["/agento ship widget"] },
    { allowed: [], elsewhere: [{ command: "/agento ship widget", window: "other", reason: "wrong" }] },
    { allowed: [], elsewhere: [{ command: "/agento ship widget", window: "primary", reason: "" }] },
  ]) {
    assert.throws(() => projectCommandActions(value));
  }
});