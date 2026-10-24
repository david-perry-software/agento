// Parity test between the canvas's vanilla-JS role colors (public/roles.js) and
// the `agento.role.*` color defaults the extension declares in
// extension/package.json. The canvas cannot import the extension's TypeScript, so
// this test keeps the two copies equal.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ROLE_COLORS, roleColor } from "./public/roles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.join(here, "..", "..", "extension", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

const roleDefaults = new Map();
for (const color of packageJson.contributes.colors) {
  if (typeof color?.id === "string" && color.id.startsWith("agento.role.")) {
    roleDefaults.set(color.id.slice("agento.role.".length), color.defaults);
  }
}

test("every agento.role.* color has a matching canvas role (foreground excluded)", () => {
  const extensionRoles = [...roleDefaults.keys()]
    .filter((role) => role !== "foreground")
    .sort();
  const canvasRoles = Object.keys(ROLE_COLORS).sort();
  assert.deepEqual(canvasRoles, extensionRoles);
});

test("canvas role backgrounds equal the extension dark defaults", () => {
  for (const [role, defaults] of roleDefaults) {
    if (role === "foreground") continue;
    assert.ok(ROLE_COLORS[role], `missing canvas role ${role}`);
    assert.equal(ROLE_COLORS[role].background, defaults.dark, `background mismatch for ${role}`);
  }
});

test("canvas role foregrounds equal the extension foreground default", () => {
  const foreground = roleDefaults.get("foreground")?.dark;
  assert.ok(foreground, "extension foreground default missing");
  for (const [role, colors] of Object.entries(ROLE_COLORS)) {
    assert.equal(colors.foreground, foreground, `foreground mismatch for ${role}`);
  }
});

test("roleColor resolves known roles and falls back to unavailable", () => {
  assert.equal(roleColor("primary"), ROLE_COLORS.primary);
  assert.equal(roleColor("build"), ROLE_COLORS.build);
  assert.equal(roleColor("unknown-role"), ROLE_COLORS.unavailable);
});
