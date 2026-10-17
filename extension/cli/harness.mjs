// Pure helpers for `agento.mjs harness install|status|uninstall` and the doctor
// `harness` check. Kept in a module so tests can unit-test the link-type choice
// without running the CLI.

import fs from "node:fs";

// The filesystem link type for the router-skill link: a directory junction on
// Windows, a plain directory symlink everywhere else.
export function linkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

// The link state at `link` relative to the expected target directory `expected`:
// absent | installed | foreign | dangling | not-a-link. `target` is the raw symlink
// target for the three symlink states, else null.
export function linkState(link, expected) {
  let st;
  try {
    st = fs.lstatSync(link);
  } catch {
    return { state: "absent", target: null };
  }
  if (!st.isSymbolicLink()) return { state: "not-a-link", target: null };
  let target;
  try {
    target = fs.readlinkSync(link);
  } catch {
    return { state: "dangling", target: null };
  }
  let real;
  try {
    real = fs.realpathSync(link);
  } catch {
    return { state: "dangling", target };
  }
  let expectedReal;
  try {
    expectedReal = fs.realpathSync(expected);
  } catch {
    expectedReal = null;
  }
  if (expectedReal && real === expectedReal) return { state: "installed", target };
  return { state: "foreign", target };
}
