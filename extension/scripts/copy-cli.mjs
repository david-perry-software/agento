import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(extensionRoot);
const cliDirectory = path.join(extensionRoot, "cli");
const cliFiles = [
  "agento.mjs",
  "agento-config.mjs",
  "session-state.mjs",
  "delivery-roadmap-resolver.mjs",
];

await mkdir(cliDirectory, { recursive: true });

for (const entry of await readdir(cliDirectory)) {
  if (!cliFiles.includes(entry)) {
    await rm(path.join(cliDirectory, entry), { force: true, recursive: true });
  }
}

for (const file of cliFiles) {
  await copyFile(path.join(repositoryRoot, "scripts", file), path.join(cliDirectory, file));
}

await copyFile(path.join(repositoryRoot, "LICENSE"), path.join(extensionRoot, "LICENSE"));
console.log(`Copied ${cliFiles.join(", ")} and LICENSE`);