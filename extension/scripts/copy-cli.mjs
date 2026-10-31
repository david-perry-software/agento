import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(extensionRoot);
const cliDirectory = path.join(extensionRoot, "cli");
const scriptsDirectory = path.join(repositoryRoot, "scripts");

// The curated flat modules plus the recursive lib/ and commands/ trees (plan
// Approach rule 6). Test files and the test-helpers directory never ship.
const flatFiles = [
  "agento.mjs",
  "agento-config.mjs",
  "session-state.mjs",
  "delivery-roadmap-resolver.mjs",
  "harness.mjs",
  "delivery-metrics.mjs",
  "merge-state.mjs",
  "model-filter.mjs",
  "model-profiles.mjs",
  "pending-dispatch.mjs",
  "release-state.mjs",
  "vscode-windows.mjs",
  "worktree-occupants.mjs",
];

// Recursively collect non-test .mjs files under `dir`, as `prefix/…` relative
// paths. `test-helpers/` is skipped anywhere it appears.
async function collect(dir, prefix = "") {
  const entries = [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    if (name === "test-helpers") continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      entries.push(...(await collect(full, rel)));
    } else if (info.isFile() && name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
      entries.push(rel);
    }
  }
  return entries;
}

const treeFiles = [
  ...(await collect(path.join(scriptsDirectory, "lib"), "lib")),
  ...(await collect(path.join(scriptsDirectory, "commands"), "commands")),
];

const cliFiles = [...flatFiles, ...treeFiles];

await mkdir(cliDirectory, { recursive: true });

// Prune stale entries: every file not in the computed set, and every directory
// that is empty after its stale files are removed.
async function prune(dir, allowed, relDir = "") {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const rel = relDir ? `${relDir}/${name}` : name;
    const full = path.join(dir, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await prune(full, allowed, rel);
      const remaining = await readdir(full).catch(() => []);
      if (remaining.length === 0) await rm(full, { recursive: true, force: true });
    } else if (!allowed.has(rel)) {
      await rm(full, { force: true });
    }
  }
}
await prune(cliDirectory, new Set(cliFiles));

// Copy every entry, creating subdirectories as needed.
for (const file of cliFiles) {
  const target = path.join(cliDirectory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(scriptsDirectory, file), target);
}

await copyFile(path.join(repositoryRoot, "LICENSE"), path.join(extensionRoot, "LICENSE"));
console.log(`Copied ${cliFiles.join(", ")} and LICENSE`);