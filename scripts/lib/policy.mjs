// The single source for reading `<root>/.github/instructions/
// delivery-policy.instructions.md` (and, after the policy split, the per-section
// files under `.github/instructions/policy/`). Every reader — `commands.policy`,
// `brief`, and the tests — goes through this module so the split cannot change one
// byte of what agents receive.

import fs from "node:fs";
import path from "node:path";

// Parses `<root>/.github/instructions/delivery-policy.instructions.md` into its
// `## N.` sections. Each entry carries the section number (the heading's digits),
// the heading title, the section's byte length, and its raw Markdown (heading line
// through the line before the next heading, or EOF for the last section).
function policySections(root) {
  const file = path.join(root, ".github", "instructions", "delivery-policy.instructions.md");
  const text = fs.readFileSync(file, "utf8");
  const heading = /^## (\d+)\. (.+)$/gm;
  const starts = [];
  let match;
  while ((match = heading.exec(text)) !== null) {
    starts.push({ n: match[1], title: match[2].trim(), offset: match.index });
  }
  return starts.map((section, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].offset : text.length;
    const raw = text.slice(section.offset, end);
    return { n: section.n, title: section.title, bytes: Buffer.byteLength(raw, "utf8"), raw };
  });
}

// The same sections as index entries — `n`, `title`, `bytes`, and the source file
// under `.github/instructions/` — for `policy --list` and the `brief` footer.
function policyIndex(root) {
  return policySections(root).map(({ n, title, bytes }) => ({
    n,
    title,
    bytes,
    file: path.join(".github", "instructions", "delivery-policy.instructions.md"),
  }));
}

export { policySections, policyIndex };
