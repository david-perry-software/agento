import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { expandHome, resolvePluginRoot, selectionToArgs, summarizeModelsResult, toQuickPickItems, type PluginRootSources } from "../../src/modelProfiles.js";

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

test("toQuickPickItems lists profiles, marks the applied one, and ends with Clear", () => {
  const items = toQuickPickItems({
    active: "mixed",
    profiles: [
      { name: "mixed", description: "strong planning", errors: [] },
      { name: "draft", description: null, errors: ["profiles.draft.default: placeholder"] },
      { name: 7 },
    ],
  });
  assert.deepEqual(items, [
    { label: "mixed", description: "applied · strong planning", selection: { kind: "apply", profile: "mixed" } },
    { label: "draft", description: "", detail: "1 error(s): profiles.draft.default: placeholder", selection: { kind: "apply", profile: "draft" } },
    { label: "Clear", description: "use the picker's model", selection: { kind: "clear" } },
  ]);
  assert.deepEqual(toQuickPickItems(undefined).map((i) => i.label), ["Clear"]);
});

test("selectionToArgs always passes --plugin-root", () => {
  assert.deepEqual(selectionToArgs({ kind: "apply", profile: "mixed" }, "/p"), ["models", "apply", "mixed", "--plugin-root", "/p"]);
  assert.deepEqual(selectionToArgs({ kind: "clear" }, "/p"), ["models", "clear", "--plugin-root", "/p"]);
});

test("summarizeModelsResult reports changes, the reload hint, and failures", () => {
  assert.deepEqual(summarizeModelsResult({ status: "ok", profile: "mixed", changed: ["a", "b"] }), {
    ok: true,
    message: "Applied model profile mixed: 2 file(s) changed. Run Developer: Reload Window if the model picker does not update.",
  });
  assert.match(summarizeModelsResult({ status: "ok", profile: null, changed: [] }).message, /^Cleared the model profile: 0 file\(s\) changed/);
  assert.deepEqual(summarizeModelsResult({ status: "invalid", errors: ["e1", "e2"] }), { ok: false, message: "models invalid: e1; e2" });
  assert.deepEqual(summarizeModelsResult({ status: "dirty", message: "edited", dirty: ["x.md"] }), { ok: false, message: "edited: x.md" });
});
