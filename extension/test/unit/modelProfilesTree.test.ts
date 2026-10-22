import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelProfilesModel,
  effectiveProfile,
  modelProfilesChildren,
  modelProfilesItemSpec,
  profileItemSpec,
  roleItemSpec,
  suggestCopyName,
  summarizePins,
  validateProfileName,
  windowProfileRole,
} from "../../src/modelProfilesTree.js";

const TARGETS = (overrides: Record<string, string | string[] | null> = {}) => [
  { file: ".github/agents/delivery-planner.agent.md", value: overrides.planner ?? "Planner (copilot)" },
  { file: ".github/agents/delivery-builder.agent.md", value: overrides.builder ?? null },
  { file: ".github/agents/delivery-reviewer.agent.md", value: overrides.reviewer ?? ["A (copilot)", "B (copilot)"] },
  { file: ".github/prompts/new-feature.prompt.md", value: overrides["new-feature"] ?? "Planner (copilot)" },
  { file: "skills/agento/commands/new-feature.md", value: overrides["new-feature"] ?? "Planner (copilot)" },
  { file: ".github/prompts/doctor.prompt.md", value: overrides.doctor ?? "Cheap (copilot)" },
  { file: "skills/agento/commands/doctor.md", value: overrides.doctor ?? "Cheap (copilot)" },
  { file: ".github/prompts/start-session.prompt.md", value: overrides["start-session"] ?? "Cheap (copilot)" },
  { file: "skills/agento/commands/start-session.md", value: overrides["start-session"] ?? "Cheap (copilot)" },
];

const LIST = (overrides: Record<string, unknown> = {}) => ({
  status: "ok",
  verb: "list",
  profiles: [
    { name: "mixed", description: "strong planning", errors: [], warnings: [], targets: TARGETS() },
    { name: "broken", description: null, errors: ["profiles.broken.default: placeholder"], warnings: [], targets: [] },
    { name: "warny", description: "bare names", errors: [], warnings: ["model values without a (vendor) suffix"], targets: TARGETS() },
  ],
  copilotModels: {},
  errors: [],
  profilesFile: { path: "/home/u/.config/agento/model-profiles.json", exists: true, hash: "a".repeat(64) },
  pluginRoot: "/home/u/DP/agento",
  active: "mixed",
  ...overrides,
});

test("createModelProfilesModel is no-plugin-root when the root is missing", () => {
  const model = createModelProfilesModel({ pluginRoot: null, listResult: LIST() });
  assert.equal(model.state, "no-plugin-root");
  assert.deepEqual(model.profiles, []);
  assert.deepEqual(model.messages, []);
  assert.equal(model.active, null);
  assert.equal(model.profilesFile, null);
});

test("createModelProfilesModel is error on a CLI failure", () => {
  const model = createModelProfilesModel({ pluginRoot: "/p", listError: "spawn ENOENT" });
  assert.equal(model.state, "error");
  assert.deepEqual(model.messages, ["spawn ENOENT"]);
});

test("createModelProfilesModel prefers listError over a non-zero list result without profilesFile", () => {
  const model = createModelProfilesModel({
    pluginRoot: "/p",
    listError: "--plugin-root /nope is not an Agento plugin clone (no .github/agents)",
    listResult: { status: "usage-error", message: "--plugin-root /nope is not an Agento plugin clone (no .github/agents)" },
  });
  assert.equal(model.state, "error");
  assert.deepEqual(model.messages, ["--plugin-root /nope is not an Agento plugin clone (no .github/agents)"]);
});

test("createModelProfilesModel is error on a missing or file-errored result", () => {
  assert.equal(createModelProfilesModel({ pluginRoot: "/p" }).state, "error");
  assert.equal(createModelProfilesModel({ pluginRoot: "/p", listResult: "nope" }).state, "error");
  assert.equal(createModelProfilesModel({ pluginRoot: "/p", listResult: { profiles: [] } }).state, "error");
  const fileError = createModelProfilesModel({
    pluginRoot: "/p",
    listResult: LIST({ errors: ["invalid JSON: nope"], profilesFile: { path: "/f", exists: true, hash: null } }),
  });
  assert.equal(fileError.state, "error");
  assert.deepEqual(fileError.messages, ["invalid JSON: nope"]);
  assert.equal(fileError.profilesFile?.path, "/f");
});

test("createModelProfilesModel is no-file when the profiles file does not exist", () => {
  const model = createModelProfilesModel({
    pluginRoot: "/p",
    listResult: LIST({ profiles: [], active: null, profilesFile: { path: "/f", exists: false, hash: null } }),
  });
  assert.equal(model.state, "no-file");
  assert.deepEqual(model.profiles, []);
  assert.equal(model.active, null);
  assert.equal(model.profilesFile?.exists, false);
});

test("createModelProfilesModel parses ready profiles, active, and drops malformed rows", () => {
  const model = createModelProfilesModel({
    pluginRoot: "/p",
    listResult: LIST({ profiles: [...(LIST().profiles as unknown[]), { name: 7 }, { description: "no name" }] }),
  });
  assert.equal(model.state, "ready");
  assert.equal(model.active, "mixed");
  assert.equal(model.profilesFile?.hash, "a".repeat(64));
  assert.equal(model.profiles.length, 3);
  const mixed = model.profiles.find((p) => p.name === "mixed");
  assert.equal(mixed?.description, "strong planning");
  assert.deepEqual(mixed?.targets, TARGETS());
  assert.equal(model.profiles.find((p) => p.name === "broken")?.errors.length, 1);
});

test("modelProfilesChildren returns [] for no-plugin-root and no-file, message rows for error", () => {
  assert.deepEqual(
    modelProfilesChildren({ state: "no-plugin-root", profiles: [], messages: [], active: null, profilesFile: null, windowRole: "primary", roles: null }),
    [],
  );
  assert.deepEqual(
    modelProfilesChildren({ state: "no-file", profiles: [], messages: [], active: null, profilesFile: null, windowRole: "primary", roles: null }),
    [],
  );
  const error = modelProfilesChildren({ state: "error", profiles: [], messages: ["bad"], active: null, profilesFile: null, windowRole: "primary", roles: null });
  assert.deepEqual(error, [{ kind: "message", label: "bad" }]);
});

test("modelProfilesChildren puts the two role rows first, then the custom info row, then profiles", () => {
  const ready = createModelProfilesModel({ pluginRoot: "/p", listResult: LIST({ active: "custom" }) });
  const children = modelProfilesChildren(ready);
  assert.deepEqual(children.slice(0, 2).map((child) => (child.kind === "role" ? child.role : child.kind)), ["primary", "secondary"]);
  assert.equal(children[2]?.kind, "info");
  assert.equal(children[2]?.label, "Custom pins — no profile matches");
  const profiles = children.filter((child) => child.kind === "profile");
  assert.equal(profiles.length, 3);

  const named = modelProfilesChildren(createModelProfilesModel({ pluginRoot: "/p", listResult: LIST() }));
  assert.deepEqual(named.slice(0, 2).map((child) => (child.kind === "role" ? child.role : child.kind)), ["primary", "secondary"]);
});

test("roleItemSpec renders the primary and secondary pinned rows", () => {
  const model = (roles: unknown, windowRole: "primary" | "secondary" = "primary", rolesErrors: unknown = []) =>
    createModelProfilesModel({ pluginRoot: "/p", windowRole, listResult: LIST({ roles, rolesErrors }) });

  const primaryOn = roleItemSpec("primary", model({ primary: "mixed", secondary: null }));
  assert.equal(primaryOn.label, "Primary windows");
  assert.equal(primaryOn.description, "mixed · this window");
  assert.equal(primaryOn.icon, "pass-filled");
  assert.equal(primaryOn.contextValue, "agento.modelRole.primary.on");

  const primaryCustom = roleItemSpec("primary", model({ primary: "custom", secondary: null }));
  assert.equal(primaryCustom.description, "custom pins · this window");
  assert.equal(primaryCustom.icon, "circle-slash");
  assert.equal(primaryCustom.contextValue, "agento.modelRole.primary.off");

  const primaryOff = roleItemSpec("primary", model({ primary: null, secondary: null }));
  assert.equal(primaryOff.description, "off · this window");
  assert.equal(primaryOff.contextValue, "agento.modelRole.primary.off");

  const secondaryOff = roleItemSpec("secondary", model({ primary: "mixed", secondary: null }, "secondary"));
  assert.equal(secondaryOff.label, "Secondary windows");
  assert.equal(secondaryOff.description, "off · this window");
  assert.equal(secondaryOff.icon, "circle-slash");
  assert.equal(secondaryOff.contextValue, "agento.modelRole.secondary.off");

  const secondaryOn = roleItemSpec("secondary", model({ primary: "mixed", secondary: "mixed" }, "secondary"));
  assert.equal(secondaryOn.description, "mixed · this window");
  assert.equal(secondaryOn.icon, "pass-filled");
  assert.equal(secondaryOn.contextValue, "agento.modelRole.secondary.on");

  const secondaryDangling = roleItemSpec("secondary", model({ primary: "mixed", secondary: "ghost" }, "secondary"));
  assert.equal(secondaryDangling.description, "ghost (missing) → primary pins · this window");
  assert.equal(secondaryDangling.icon, "warning");
  assert.equal(secondaryDangling.contextValue, "agento.modelRole.secondary.off");
  assert.match(secondaryDangling.tooltip!, /ghost/);

  const secondaryInvalid = roleItemSpec("secondary", model({ primary: "mixed", secondary: null }, "secondary", ["invalid JSON: nope"]));
  assert.equal(secondaryInvalid.description, "invalid roles file → primary pins · this window");
  assert.equal(secondaryInvalid.icon, "warning");
  assert.equal(secondaryInvalid.contextValue, "agento.modelRole.secondary.off");
  assert.match(secondaryInvalid.tooltip!, /invalid/);
});

test("profileItemSpec renders role labels, the here icon, and every contextValue token", () => {
  const model = createModelProfilesModel({ pluginRoot: "/p", listResult: LIST() });
  const mixed = model.profiles.find((p) => p.name === "mixed")!;
  const applied = profileItemSpec(mixed, model);
  assert.equal(applied.label, "mixed");
  assert.equal(applied.description, "primary · strong planning");
  assert.equal(applied.icon, "pass-filled");
  assert.equal(applied.contextValue, "agento.modelProfile.primary.here");
  assert.match(applied.tooltip!, /strong planning/);
  assert.match(applied.tooltip!, /delivery-planner: Planner \(copilot\)/);
  assert.match(applied.tooltip!, /Planner \(copilot\) — 1 command/);
  assert.match(applied.tooltip!, /Cheap \(copilot\) — 2 commands/);
  assert.match(applied.tooltip!, /delivery-reviewer: A \(copilot\) → B \(copilot\)/);
  assert.match(applied.tooltip!, /- Used by primary windows/);
  assert.match(applied.tooltip!, /- In effect in this window/);

  const broken = model.profiles.find((p) => p.name === "broken")!;
  const invalid = profileItemSpec(broken, model);
  assert.equal(invalid.icon, "error");
  assert.equal(invalid.contextValue, "agento.modelProfile.invalid");
  assert.match(invalid.tooltip!, /profiles\.broken\.default: placeholder/);

  const warny = model.profiles.find((p) => p.name === "warny")!;
  const warning = profileItemSpec(warny, model);
  assert.equal(warning.icon, "warning");
  assert.equal(warning.contextValue, "agento.modelProfile");
  assert.match(warning.tooltip!, /model values without a \(vendor\) suffix/);

  const defaultSpec = profileItemSpec({ name: "plain", description: null, errors: [], warnings: [], targets: [] }, model);
  assert.equal(defaultSpec.icon, "symbol-misc");
  assert.equal(defaultSpec.contextValue, "agento.modelProfile");
  assert.equal(defaultSpec.description, undefined);
  assert.equal(defaultSpec.tooltip, undefined);
});

test("profileItemSpec marks the secondary profile in a secondary window", () => {
  const model = createModelProfilesModel({
    pluginRoot: "/p",
    windowRole: "secondary",
    listResult: LIST({ roles: { primary: "mixed", secondary: "mixed" } }),
  });
  const mixed = model.profiles.find((p) => p.name === "mixed")!;
  const spec = profileItemSpec(mixed, model);
  assert.equal(spec.description, "primary · secondary · strong planning");
  assert.equal(spec.icon, "pass-filled");
  assert.equal(spec.contextValue, "agento.modelProfile.primary.secondary.here");
  assert.match(spec.tooltip!, /- Used by primary windows/);
  assert.match(spec.tooltip!, /- Used by secondary windows/);
  assert.match(spec.tooltip!, /- In effect in this window/);
});

test("modelProfilesItemSpec renders role, info, and message elements", () => {
  const model = createModelProfilesModel({ pluginRoot: "/p", listResult: LIST() });
  const role = modelProfilesItemSpec({ kind: "role", role: "primary" }, model);
  assert.equal(role.label, "Primary windows");
  assert.equal(role.contextValue, "agento.modelRole.primary.on");

  const info = modelProfilesItemSpec({ kind: "info", label: "Custom pins — no profile matches", tooltip: "t" }, model);
  assert.equal(info.icon, "info");
  assert.equal(info.contextValue, "agento.modelProfileInfo");
  const message = modelProfilesItemSpec({ kind: "message", label: "boom" }, model);
  assert.equal(message.icon, "error");
  assert.equal(message.contextValue, "agento.modelProfileMessage");
});

test("summarizePins skips null values and groups commands by distinct value", () => {
  const lines = summarizePins(TARGETS());
  assert.deepEqual(lines, [
    "delivery-planner: Planner (copilot)",
    "delivery-reviewer: A (copilot) → B (copilot)",
    "Planner (copilot) — 1 command",
    "Cheap (copilot) — 2 commands",
  ]);
});

test("validateProfileName enforces [a-z0-9-]+ and uniqueness", () => {
  assert.equal(validateProfileName("good-name-1", []), null);
  assert.match(validateProfileName("Bad_Name", [])!, /lowercase letters, digits, and hyphens/);
  assert.match(validateProfileName("", [])!, /lowercase letters, digits, and hyphens/);
  assert.match(validateProfileName("dup", ["dup"])!, /already exists/);
  assert.equal(validateProfileName("dup", new Set(["other"])), null);
});

test("suggestCopyName appends -copy, then -copy-2, …", () => {
  assert.equal(suggestCopyName("mixed", []), "mixed-copy");
  assert.equal(suggestCopyName("mixed", ["mixed-copy"]), "mixed-copy-2");
  assert.equal(suggestCopyName("mixed", new Set(["mixed-copy", "mixed-copy-2"])), "mixed-copy-3");
});

test("windowProfileRole buckets plan, build, and freehand to secondary and everything else to primary", () => {
  for (const role of ["plan", "build", "freehand"]) {
    assert.equal(windowProfileRole(role), "secondary");
  }
  for (const role of ["primary", "unmanaged", "observer", "copilot", "", null]) {
    assert.equal(windowProfileRole(role), "primary");
  }
});

test("createModelProfilesModel parses roles, rolesFile, and every secondaryState", () => {
  const withRoles = (roles: unknown, rolesErrors: unknown = []) =>
    createModelProfilesModel({
      pluginRoot: "/p",
      windowRole: "secondary",
      listResult: LIST({ roles, rolesFile: { path: "/home/u/.config/agento/model-roles.json", exists: true, hash: "b".repeat(64) }, rolesErrors }),
    });

  const on = withRoles({ primary: "mixed", secondary: "mixed" });
  assert.equal(on.windowRole, "secondary");
  assert.deepEqual(on.roles, {
    primary: "mixed",
    secondary: "mixed",
    secondaryState: "on",
    rolesFile: { path: "/home/u/.config/agento/model-roles.json", exists: true, hash: "b".repeat(64) },
    rolesErrors: [],
  });

  const off = withRoles({ primary: "mixed", secondary: null });
  assert.equal(off.roles?.secondaryState, "off");

  const dangling = withRoles({ primary: null, secondary: "ghost" });
  assert.equal(dangling.roles?.secondaryState, "dangling");

  const invalid = withRoles({ primary: null, secondary: null }, ["invalid JSON: nope"]);
  assert.equal(invalid.roles?.secondaryState, "invalid");
  assert.deepEqual(invalid.roles?.rolesErrors, ["invalid JSON: nope"]);

  const primary = createModelProfilesModel({
    pluginRoot: "/p",
    listResult: LIST({ roles: { primary: "custom", secondary: "ghost" } }),
  });
  assert.equal(primary.windowRole, "primary");
  assert.equal(primary.roles?.primary, "custom");
  assert.equal(primary.roles?.secondary, "ghost");
  assert.equal(primary.roles?.secondaryState, "dangling");
});

test("createModelProfilesModel leaves roles null outside the ready state", () => {
  assert.equal(createModelProfilesModel({ pluginRoot: null }).roles, null);
  assert.equal(createModelProfilesModel({ pluginRoot: "/p", listError: "boom" }).roles, null);
  assert.equal(
    createModelProfilesModel({ pluginRoot: "/p", listResult: LIST({ profiles: [], profilesFile: { path: "/f", exists: false, hash: null } }) }).roles,
    null,
  );
});

test("effectiveProfile resolves the secondary profile only when the window is secondary and the role is on", () => {
  const model = (overrides: Record<string, unknown> = {}, windowRole: "primary" | "secondary" = "primary") =>
    createModelProfilesModel({
      pluginRoot: "/p",
      windowRole,
      listResult: LIST({ roles: { primary: "mixed", secondary: "mixed" }, ...overrides }),
    });

  assert.deepEqual(effectiveProfile(model()), { role: "primary", name: "mixed", source: "file-pins", label: "mixed" });
  assert.deepEqual(effectiveProfile(model({}, "secondary")), { role: "secondary", name: "mixed", source: "role-profile", label: "mixed" });

  const off = effectiveProfile(model({ roles: { primary: "mixed", secondary: null } }, "secondary"));
  assert.deepEqual(off, { role: "primary", name: "mixed", source: "file-pins", label: "mixed" });

  assert.deepEqual(effectiveProfile(model({ roles: { primary: "custom", secondary: null } })), {
    role: "primary",
    name: null,
    source: "file-pins",
    label: "custom pins",
  });
  assert.deepEqual(effectiveProfile(model({ roles: { primary: null, secondary: null } })), {
    role: "primary",
    name: null,
    source: "file-pins",
    label: "picker default",
  });
});
