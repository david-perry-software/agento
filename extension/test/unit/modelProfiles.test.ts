import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  aliasSetArgs,
  createProfileArgs,
  deleteProfileArgs,
  expandHome,
  initProfilesArgs,
  missingPluginRootMessage,
  needsPrimaryConfirm,
  renameProfileArgs,
  resolvePluginRoot,
  selectionToArgs,
  summarizeModelsResult,
  toQuickPickItems,
  updateProfileArgs,
  type PluginRootSources,
} from "../../src/modelProfiles.js";

const home = "/home/u";

function sources(overrides: Partial<PluginRootSources>, manifests: Record<string, unknown>): PluginRootSources {
  const manifestOf = (file: string) => path.dirname(path.dirname(file));
  return {
    configured: undefined,
    pluginLocations: undefined,
    homedir: home,
    exists: (file) => Object.hasOwn(manifests, manifestOf(file)),
    readJson: (file) => {
      const value = manifests[manifestOf(file)];
      if (value instanceof Error) throw value;
      return value;
    },
    ...overrides,
  };
}

test("expandHome expands ~ and ~/ only", () => {
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("~/DP/agento", home), path.join(home, "DP/agento"));
  assert.equal(expandHome("/abs/~/x", home), "/abs/~/x");
});

test("resolvePluginRoot prefers the agento.pluginRoot setting", () => {
  const manifests = { "/set/agento": { name: "agento" }, [path.join(home, "DP/agento")]: { name: "agento" } };
  assert.equal(resolvePluginRoot(sources({ configured: " /set/agento ", pluginLocations: { "~/DP/agento": true } }, manifests)), "/set/agento");
  assert.equal(resolvePluginRoot(sources({ configured: "/elsewhere", pluginLocations: { "~/DP/agento": true } }, manifests)), null);
});

test("resolvePluginRoot falls back to the first enabled chat.pluginLocations entry named agento", () => {
  const manifests = {
    "/other": { name: "other-plugin" },
    "/disabled": { name: "agento" },
    "/broken": new Error("bad json"),
    [path.join(home, "DP/agento")]: { name: "agento" },
  };
  const pluginLocations = { "/other": true, "/disabled": false, "/broken": true, "/missing": true, "~/DP/agento": true };
  assert.equal(resolvePluginRoot(sources({ configured: "", pluginLocations }, manifests)), path.join(home, "DP/agento"));
  assert.equal(resolvePluginRoot(sources({ pluginLocations: { "/other": true } }, manifests)), null);
  assert.equal(resolvePluginRoot(sources({}, manifests)), null);
});

test("missingPluginRootMessage names a set but invalid agento.pluginRoot", () => {
  assert.equal(
    missingPluginRootMessage(" ~/wrong/agento ", home),
    `agento.pluginRoot is set to ${path.join(home, "wrong/agento")}, which is not an Agento plugin clone (no .claude-plugin/plugin.json named "agento"): fix or clear the setting.`,
  );
  for (const unset of [undefined, "", "  "]) {
    assert.equal(missingPluginRootMessage(unset, home), "No Agento plugin clone found: set agento.pluginRoot or register the clone in chat.pluginLocations.");
  }
});

test("toQuickPickItems marks role labels and ends with a role-aware Turn off", () => {
  const items = toQuickPickItems(
    {
      roles: { primary: "mixed", secondary: "mixed" },
      profiles: [
        { name: "mixed", description: "strong planning", errors: [] },
        { name: "draft", description: null, errors: ["profiles.draft.default: placeholder"] },
        { name: 7 },
      ],
    },
    "secondary",
  );
  assert.deepEqual(items, [
    { label: "mixed", description: "primary · secondary · strong planning", selection: { kind: "use", role: "secondary", profile: "mixed" } },
    { label: "draft", description: "", detail: "1 error(s): profiles.draft.default: placeholder", selection: { kind: "use", role: "secondary", profile: "draft" } },
    { label: "Turn off", description: "use the primary windows' pins", selection: { kind: "off", role: "secondary" } },
  ]);
  assert.deepEqual(toQuickPickItems(undefined, "primary").map((i) => i.label), ["Turn off"]);
  assert.equal(toQuickPickItems(undefined, "primary")[0]?.description, "use the picker's model");
});

test("selectionToArgs maps use/off for each role and passes --expect on secondary writes", () => {
  const hash = "c".repeat(64);
  assert.deepEqual(selectionToArgs({ kind: "use", role: "primary", profile: "mixed" }, "/p"), ["models", "apply", "mixed", "--plugin-root", "/p"]);
  assert.deepEqual(selectionToArgs({ kind: "off", role: "primary" }, "/p"), ["models", "clear", "--plugin-root", "/p"]);
  assert.deepEqual(selectionToArgs({ kind: "use", role: "secondary", profile: "mixed" }, "/p", { rolesHash: hash }), [
    "models", "use", "mixed", "--role", "secondary", "--expect", hash, "--plugin-root", "/p",
  ]);
  assert.deepEqual(selectionToArgs({ kind: "use", role: "secondary", profile: "mixed" }, "/p"), [
    "models", "use", "mixed", "--role", "secondary", "--plugin-root", "/p",
  ]);
  assert.deepEqual(selectionToArgs({ kind: "off", role: "secondary" }, "/p", { rolesHash: hash }), [
    "models", "use", "none", "--role", "secondary", "--expect", hash, "--plugin-root", "/p",
  ]);
});

test("needsPrimaryConfirm is true only for a primary target in a secondary window", () => {
  assert.equal(needsPrimaryConfirm("primary", "secondary"), true);
  assert.equal(needsPrimaryConfirm("primary", "primary"), false);
  assert.equal(needsPrimaryConfirm("secondary", "secondary"), false);
  assert.equal(needsPrimaryConfirm("secondary", "primary"), false);
});

test("write arg builders pass --expect from the snapshot hash and --force on applied delete", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(createProfileArgs("new", "/p"), ["models", "create", "new", "--plugin-root", "/p"]);
  assert.deepEqual(createProfileArgs("new", "/p", { from: "mixed", description: "d", hash }), [
    "models", "create", "new", "--from", "mixed", "--description", "d", "--expect", hash, "--plugin-root", "/p",
  ]);
  assert.deepEqual(createProfileArgs("new", "/p", { description: "d", hash: null }), [
    "models", "create", "new", "--description", "d", "--plugin-root", "/p",
  ]);
  assert.deepEqual(renameProfileArgs("old", "new", "/p", { hash }), ["models", "rename", "old", "new", "--expect", hash, "--plugin-root", "/p"]);
  assert.deepEqual(renameProfileArgs("old", "new", "/p"), ["models", "rename", "old", "new", "--plugin-root", "/p"]);
  assert.deepEqual(deleteProfileArgs("mixed", "/p", { force: true, hash }), ["models", "delete", "mixed", "--force", "--expect", hash, "--plugin-root", "/p"]);
  assert.deepEqual(deleteProfileArgs("mixed", "/p"), ["models", "delete", "mixed", "--plugin-root", "/p"]);
  assert.deepEqual(updateProfileArgs("mixed", "/p", { dryRun: true }), ["models", "update", "mixed", "--dry-run", "--plugin-root", "/p"]);
  assert.deepEqual(updateProfileArgs("mixed", "/p", { expect: hash }), ["models", "update", "mixed", "--expect", hash, "--plugin-root", "/p"]);
  assert.deepEqual(updateProfileArgs("mixed", "/p"), ["models", "update", "mixed", "--plugin-root", "/p"]);
  assert.deepEqual(aliasSetArgs("Claude Opus (copilot)", "claude-opus-5", "/p", { expect: hash }), [
    "models", "alias", "set", "Claude Opus (copilot)", "claude-opus-5", "--expect", hash, "--plugin-root", "/p",
  ]);
  assert.deepEqual(aliasSetArgs("Claude Opus (copilot)", "claude-opus-5", "/p"), [
    "models", "alias", "set", "Claude Opus (copilot)", "claude-opus-5", "--plugin-root", "/p",
  ]);
  assert.deepEqual(initProfilesArgs("/p"), ["models", "init", "--plugin-root", "/p"]);
});

test("summarizeModelsResult reports changes, the reload hint, and failures", () => {
  assert.deepEqual(summarizeModelsResult({ status: "ok", profile: "mixed", changed: ["a", "b"] }), {
    ok: true,
    message: "Applied model profile mixed: 2 file(s) changed. Run Developer: Reload Window if the model picker does not update.",
    dirty: [],
    conflict: false,
  });
  assert.match(summarizeModelsResult({ status: "ok", profile: null, changed: [] }).message, /^Cleared the model profile: 0 file\(s\) changed/);
  assert.deepEqual(summarizeModelsResult({ status: "invalid", errors: ["e1", "e2"] }), {
    ok: false,
    message: "The profile is invalid: e1; e2",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "dirty", message: "edited", dirty: ["x.md"] }), {
    ok: false,
    message: "edited: x.md",
    dirty: ["x.md"],
    conflict: false,
  });
});

test("summarizeModelsResult reports the write verbs' success distinctly from apply/clear", () => {
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "create", profile: "new" }), {
    ok: true,
    message: "Created model profile new.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "rename", profile: "old" }), {
    ok: true,
    message: "Renamed the model profile.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "delete", profile: "new" }), {
    ok: true,
    message: "Deleted model profile new.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "init", created: true }), {
    ok: true,
    message: "Created the model profiles file.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "init", created: false }), {
    ok: true,
    message: "The model profiles file already exists.",
    dirty: [],
    conflict: false,
  });
});

test("summarizeModelsResult reports update (with reapply) and alias set successes", () => {
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "update", profile: "mixed" }), {
    ok: true,
    message: "Saved model profile mixed.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "update", profile: "mixed", reapply: "agento.mjs models apply mixed --plugin-root /p" }), {
    ok: true,
    message: "Saved model profile mixed. Run agento.mjs models apply mixed --plugin-root /p to update the active models.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "alias set", picker: "Claude Opus (copilot)" }), {
    ok: true,
    message: "Saved the Copilot model alias for Claude Opus (copilot).",
    dirty: [],
    conflict: false,
  });
});

test("summarizeModelsResult reports the secondary use verb distinctly", () => {
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "use", role: "secondary", profile: "review" }), {
    ok: true,
    message: "Secondary windows now use review.",
    dirty: [],
    conflict: false,
  });
  assert.deepEqual(summarizeModelsResult({ status: "ok", verb: "use", role: "secondary", profile: null }), {
    ok: true,
    message: "Turned off the secondary profile; secondary windows use the primary pins.",
    dirty: [],
    conflict: false,
  });
});

test("summarizeModelsResult exposes dirty files and the conflict flag, with clear messages", () => {
  const conflict = summarizeModelsResult({ status: "conflict", message: "stale", expected: "a", actual: "b" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.dirty, []);
  assert.equal(conflict.message, "stale");

  const bareConflict = summarizeModelsResult({ status: "conflict" });
  assert.equal(bareConflict.conflict, true);
  assert.match(bareConflict.message, /changed since it was read/);

  const dirty = summarizeModelsResult({ status: "dirty", dirty: ["a.md", 7, "b.md"] });
  assert.deepEqual(dirty.dirty, ["a.md", "b.md"]);
  assert.equal(dirty.conflict, false);
  assert.match(dirty.message, /a\.md; b\.md/);

  assert.match(summarizeModelsResult({ status: "exists" }).message, /already exists/);
  assert.match(summarizeModelsResult({ status: "not-found" }).message, /No profile with that name/);
  assert.match(summarizeModelsResult({ status: "active" }).message, /applied in this clone/);
  assert.match(summarizeModelsResult({ status: "assigned" }).message, /assigned to the secondary role/);
  assert.match(summarizeModelsResult({ status: "invalid" }).message, /The profile is invalid/);
});
