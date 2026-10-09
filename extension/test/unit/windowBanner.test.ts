import assert from "node:assert/strict";
import test from "node:test";

import { createSessionDoctorError, createSessionDoctorModel } from "../../src/sessionDoctorModel.js";
import { createWindowBannerModel, escapeHtml, renderWindowBannerHtml } from "../../src/windowBanner.js";

const doctor = { status: "ok", checks: [] };
const status = { status: "ok", resumable: [] };

function sessionModel(overrides: Record<string, unknown> = {}) {
  return createSessionDoctorModel(
    {
      status: "ok",
      role: "build",
      lifecycle: "building",
      delivery: { type: "feature", slug: "window-type-banner" },
      worktree: { path: "/repo/worktrees/plan-1", branch: "feature/window-type-banner", detached: false },
      workspace: null,
      companion: null,
      warnings: [],
      allowed: [],
      elsewhere: [],
      ...overrides,
    },
    doctor,
    status,
  );
}

test("window banner titles and colors every session role", () => {
  const cases = [
    ["primary", "PRIMARY WINDOW"],
    ["plan", "PLAN WINDOW"],
    ["build", "BUILD WINDOW"],
    ["freehand", "FREEHAND WINDOW"],
    ["unmanaged", "UNMANAGED WINDOW"],
  ] as const;
  for (const [role, title] of cases) {
    const banner = createWindowBannerModel(sessionModel({ role }));
    assert.equal(banner.title, title);
    assert.equal(banner.tone, role);
    assert.equal(banner.colorId, `agento.role.${role}`);
  }
});

test("window banner detail joins slug, branch, and lifecycle for a delivery", () => {
  assert.deepEqual(createWindowBannerModel(sessionModel()), {
    tone: "build",
    title: "BUILD WINDOW",
    detail: "window-type-banner · feature/window-type-banner · building",
    tooltip: "/repo/worktrees/plan-1\nClick to open Session & Doctor",
    colorId: "agento.role.build",
  });
});

test("window banner omits the slug and the no-delivery lifecycle without a delivery", () => {
  const banner = createWindowBannerModel(
    sessionModel({
      role: "primary",
      lifecycle: "no-delivery",
      delivery: null,
      worktree: { path: "/repo", branch: "main", detached: false },
    }),
  );
  assert.equal(banner.title, "PRIMARY WINDOW");
  assert.equal(banner.detail, "main");
  assert.equal(banner.tooltip, "/repo\nClick to open Session & Doctor");
});

test("window banner shows detached for a fresh plan window", () => {
  const banner = createWindowBannerModel(
    sessionModel({
      role: "plan",
      lifecycle: "no-delivery",
      delivery: null,
      worktree: { path: "/repo/worktrees/plan-2", branch: null, detached: true },
    }),
  );
  assert.equal(banner.title, "PLAN WINDOW");
  assert.equal(banner.tone, "plan");
  assert.equal(banner.detail, "detached");
});

test("window banner appends hosted for hosted sessions", () => {
  assert.equal(
    createWindowBannerModel(sessionModel({ hosted: true })).detail,
    "window-type-banner · feature/window-type-banner · building · hosted",
  );
  assert.equal(
    createWindowBannerModel(sessionModel({ role: "unmanaged", hosted: true })).detail,
    "Agento commands are disabled here — open the primary checkout · hosted",
  );
});

test("unmanaged windows get a red banner telling the user to open the primary checkout", () => {
  const banner = createWindowBannerModel(sessionModel({ role: "unmanaged", lifecycle: "no-delivery", delivery: null }));
  assert.equal(banner.title, "UNMANAGED WINDOW");
  assert.equal(banner.colorId, "agento.role.unmanaged");
  assert.equal(banner.detail, "Agento commands are disabled here — open the primary checkout");
});

test("an unknown role falls back to the grey unavailable color", () => {
  const banner = createWindowBannerModel(sessionModel({ role: "observer" }));
  assert.equal(banner.title, "OBSERVER WINDOW");
  assert.equal(banner.tone, "unavailable");
  assert.equal(banner.colorId, "agento.role.unavailable");
});

test("load errors render a grey AGENTO UNAVAILABLE banner with the message", () => {
  assert.deepEqual(createWindowBannerModel(createSessionDoctorError(new Error("exit 3"))), {
    tone: "unavailable",
    title: "AGENTO UNAVAILABLE",
    detail: "Unable to load Session & Doctor: exit 3",
    tooltip: "Unable to load Session & Doctor: exit 3\nClick to open Session & Doctor",
    colorId: "agento.role.unavailable",
  });
});

test("banner HTML is script-free, nonce-scoped, clickable, and uses the role color variables", () => {
  const html = renderWindowBannerHtml(createWindowBannerModel(sessionModel()), "abc123");

  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-abc123';">/,
  );
  assert.match(html, /<style nonce="abc123">/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.match(html, /<a class="banner" href="command:agento\.sessionDoctor\.focus" title="\/repo\/worktrees\/plan-1\nClick to open Session &amp; Doctor">/);
  assert.match(html, /background: var\(--vscode-agento-role-build\);/);
  assert.match(html, /color: var\(--vscode-agento-role-foreground\);/);
  assert.match(html, /<span class="title">BUILD WINDOW<\/span>/);
  assert.match(html, /<span class="detail">window-type-banner · feature\/window-type-banner · building<\/span>/);
  assert.equal(html.match(/href=/g)?.length, 1);
});

test("hostile branch names and error messages are HTML-escaped", () => {
  const hostile = `<script>alert("x")</script>'&`;
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;";
  assert.equal(escapeHtml(hostile), escaped);

  const branchHtml = renderWindowBannerHtml(
    createWindowBannerModel(sessionModel({ worktree: { path: `/repo/${hostile}`, branch: hostile, detached: false } })),
    "n1",
  );
  const errorHtml = renderWindowBannerHtml(createWindowBannerModel(createSessionDoctorError(new Error(hostile))), "n2");

  for (const html of [branchHtml, errorHtml]) {
    assert.doesNotMatch(html, /<script/i);
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(hostile));
  }
  assert.match(branchHtml, /title="\/repo\/&lt;script&gt;/);
  assert.match(errorHtml, /<span class="title">AGENTO UNAVAILABLE<\/span>/);
  assert.match(errorHtml, /var\(--vscode-agento-role-unavailable\)/);
});
