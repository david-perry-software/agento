import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const extensionRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
const vsixPath = path.join(extensionRoot, `${manifest.name}-${manifest.version}.vsix`);
const entries = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" }).trim().split("\n");
const entrySet = new Set(entries);

const requiredEntries = [
  "extension/LICENSE.txt",
  "extension/cli/agento-config.mjs",
  "extension/cli/agento.mjs",
  "extension/cli/delivery-roadmap-resolver.mjs",
  "extension/cli/session-state.mjs",
  "extension/media/agento.svg",
  "extension/out/cliClient.js",
  "extension/out/extension.js",
  "extension/out/filePendingDispatchStore.js",
  "extension/out/gitDir.js",
  "extension/out/refreshScheduler.js",
  "extension/out/watchers.js",
  "extension/package.json",
  "extension/readme.md",
];
for (const entry of requiredEntries) {
  assert.ok(entrySet.has(entry), `VSIX is missing ${entry}`);
}

const forbiddenEntries = entries.filter(
  (entry) =>
    entry.startsWith("extension/src/") ||
    entry.startsWith("extension/test/") ||
    entry.startsWith("extension/node_modules/") ||
    entry.startsWith("extension/out/src/") ||
    entry.endsWith(".map"),
);
assert.deepEqual(forbiddenEntries, [], `VSIX contains excluded entries: ${forbiddenEntries.join(", ")}`);

const packagedLicense = execFileSync("unzip", ["-p", vsixPath, "extension/LICENSE.txt"]);
const sourceLicense = fs.readFileSync(path.join(extensionRoot, "LICENSE"));
assert.ok(packagedLicense.equals(sourceLicense), "extension/LICENSE.txt differs from extension/LICENSE");

console.log(`VSIX archive assertion passed: ${requiredEntries.length} required entries, license bytes preserved, exclusions clean`);