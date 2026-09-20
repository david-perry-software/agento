import assert from "node:assert/strict";
import test from "node:test";

import { createSessionDoctorError, createSessionDoctorModel } from "../../src/sessionDoctorModel.js";

const session = {
  status: "ok",
  role: "build",
  lifecycle: "building",
  delivery: { type: "feature", slug: "session-doctor-panel" },
  worktree: { path: "/repo/worktree", branch: "feature/session-doctor-panel", detached: false },
  workspace: { path: "/repo/session.code-workspace", exists: true },
  companion: {
    path: "/repo/docs-worktree",
    branch: "feature/session-doctor-panel",
    detached: false,
    dirty: false,
    ahead: 2,
    behind: 1,
    registered: true,
  },
  warnings: ["pr: gh unavailable"],
  allowed: ["/agento continue", "/agento build-feature session-doctor-panel", "/agento ap session-doctor-panel"],
  elsewhere: [{ command: "/agento ship session-doctor-panel", window: "primary", reason: "ship from primary" }],
};

const doctor = {
  status: "warn",
  checks: [
    { id: "node", status: "ok", detail: "node v22.22.3", fallback: null },
    { id: "browser", status: "warn", detail: "browser unavailable", fallback: "run headless verification" },
    { id: "gh", status: "fail", detail: "not authenticated", fallback: "run gh auth login" },
  ],
};

const status = { status: "ok", resumable: [{ slug: "one" }, { slug: "two" }] };

test("session doctor model preserves complete CLI state and derives status text", () => {
  const model = createSessionDoctorModel(session, doctor, status);

  assert.equal(model.kind, "ready");
  if (model.kind !== "ready") {
    return;
  }
  assert.deepEqual(model.session, {
    role: "build",
    lifecycle: "building",
    deliverySlug: "session-doctor-panel",
    worktreePath: "/repo/worktree",
    branch: "feature/session-doctor-panel",
    workspace: "/repo/session.code-workspace (exists)",
  });
  assert.deepEqual(model.companion, {
    path: "/repo/docs-worktree",
    branch: "feature/session-doctor-panel",
    state: "registered, attached, clean",
    sync: "ahead 2, behind 1",
  });
  assert.deepEqual(model.warnings, ["pr: gh unavailable"]);
  assert.deepEqual(model.checks, doctor.checks);
  assert.deepEqual(model.actions.map((action) => action.command), [
    "/agento continue",
    "/agento build-feature session-doctor-panel",
    "/agento ap session-doctor-panel",
    "/agento ship session-doctor-panel",
  ]);
  assert.equal(model.statusBarText, "Agento: build · 2 active");
});

test("session doctor model represents absent optional state explicitly", () => {
  const model = createSessionDoctorModel(
    { ...session, delivery: null, worktree: { ...session.worktree, branch: null, detached: true }, workspace: null, companion: null, warnings: [] },
    { status: "ok", checks: [{ id: "node", status: "ok", detail: "", fallback: null }] },
    { status: "ok", resumable: [] },
  );

  assert.equal(model.kind, "ready");
  if (model.kind !== "ready") {
    return;
  }
  assert.equal(model.session.branch, "detached");
  assert.equal(model.session.deliverySlug, null);
  assert.equal(model.session.workspace, "none");
  assert.equal(model.companion, null);
  assert.equal(model.checks[0]?.detail, "");
  assert.equal(model.checks[0]?.fallback, null);
  assert.equal(model.statusBarText, "Agento: build · 0 active");
});

test("session doctor model rejects malformed required response fields", () => {
  const malformedSession = createSessionDoctorModel({ ...session, role: "" }, doctor, status);
  const malformedDoctor = createSessionDoctorModel(session, { status: "ok", checks: [{ id: "node" }] }, status);
  const malformedStatus = createSessionDoctorModel(session, doctor, { status: "ok", resumable: "two" });

  for (const model of [malformedSession, malformedDoctor, malformedStatus]) {
    assert.equal(model.kind, "error");
    if (model.kind === "error") {
      assert.match(model.message, /^Invalid Session & Doctor response:/);
      assert.equal(model.statusBarText, "Agento: unavailable");
    }
  }
});

test("session doctor model returns an explicit transport error", () => {
  assert.deepEqual(createSessionDoctorError(new Error("exit 3")), {
    kind: "error",
    message: "Unable to load Session & Doctor: exit 3",
    statusBarText: "Agento: unavailable",
  });
});