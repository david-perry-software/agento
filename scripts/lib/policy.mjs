// The single source for reading `<root>/.github/instructions/
// delivery-policy.instructions.md` (and, after the policy split, the per-section
// files under `.github/instructions/policy/`). Every reader — `commands.policy`,
// `brief`, and the tests — goes through this module so the split cannot change one
// byte of what agents receive.

import fs from "node:fs";
import path from "node:path";

// Lists the per-section files under `.github/instructions/policy/` in numeric order.
// Each file starts with its `## N. Title` heading and holds exactly the bytes the
// old monolithic file carried for that section, so `policy N` output is unchanged.
function policyFiles(root) {
  const dir = path.join(root, ".github", "instructions", "policy");
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{2}-.+\.md$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// Reads the per-section files into `## N.` sections. Each entry carries the section
// number (the heading's digits), the heading title, the section's byte length, and
// its raw Markdown — the full file content, byte for byte.
function policySections(root) {
  const heading = /^## (\d+)\. (.+)$/;
  return policyFiles(root).map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const first = raw.split(/\r?\n/, 1)[0];
    const match = first.match(heading);
    if (!match) throw new Error(`${file}: first line must be a "## N. Title" heading`);
    return { n: match[1], title: match[2].trim(), bytes: Buffer.byteLength(raw, "utf8"), raw };
  });
}

// The same sections as index entries — `n`, `title`, `bytes`, and the source file
// under `.github/instructions/` — for `policy --list` and the `brief` footer.
function policyIndex(root) {
  return policyFiles(root).map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const first = raw.split(/\r?\n/, 1)[0];
    const match = first.match(/^## (\d+)\. (.+)$/);
    if (!match) throw new Error(`${file}: first line must be a "## N. Title" heading`);
    return {
      n: match[1],
      title: match[2].trim(),
      bytes: Buffer.byteLength(raw, "utf8"),
      file: path.join(".github", "instructions", "policy", path.basename(file)),
    };
  });
}

export { policySections, policyIndex };
