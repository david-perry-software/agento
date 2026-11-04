import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { policyIndex, policySections } from "./policy.mjs";

// The policy file has not changed since the plan baseline commit `3f14f7f`; these
// hashes pin the exact bytes agents receive, so the split in step 1.2 (and any
// later edit) cannot silently change the policy output.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

const PINNED_SECTIONS = {
  "1": "c7e1cf0ca82d1a0e8b7f5ae879af85b4cb8c509c1d4d0981ace2ab9fdb752613",
  "2": "c5f06b9cbf30c0de8e28a931040c1c5dd7268ae66aa5fe3cec9f0efc481c5d35",
  "3": "339e6effc2be45db8d7d6f623a172d20ad2feb2016ca2b82fef0cb9b26bcaa0c",
  "4": "a2af465413c2886af6ce963e8a24f836df546fb79558f8b91fa899bf3026a26f",
  "5": "99907356ee3f7b9e8c7efc834dffa956b3d758b343909f55ec63f9858834e27f",
  "6": "cbf4ee4ac2d472351c41a8471636326312dfd67774e9b544ecc300883234ea48",
  "7": "346b235beb91d650f0d5435f0897c59f20c966380556d35d6bcbd6b790fce1c4",
  "8": "963e32b8c66ba7c7f7cb64e8723d3b6ad8f247bd5983862a70c0feb085234fde",
  "9": "89e0ee5b8eb90a37faabd01e4548c54995c1a654f41a6c7889b10104309eb082",
  "10": "52e076db0167907e455794736308b425beac892d11b08120972032b69c4fff62",
  "11": "c3776385b0eab5a949867f97308991d0b2ad870f43563ac8a62898696001158f",
  "12": "a057fb26699d8374d1167538fe0cecd5d8e72bc33862a1188edf7b22f07e53df",
};

const FULL_POLICY_SHA = "0f772405bab7945b39ba37ab05853a766b51bb7aa3bb85dff998a499ee483aa5";

test("policySections reads every ## N. section with the pinned raw bytes", () => {
  const sections = policySections(repoRoot);
  assert.deepEqual(sections.map((s) => s.n), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.equal(sections[0].title, "Who does the work");
  for (const section of sections) {
    assert.equal(sha256(section.raw), PINNED_SECTIONS[section.n], `section §${section.n} bytes changed`);
    assert.equal(section.bytes, Buffer.byteLength(section.raw, "utf8"), `section §${section.n} byte length is stale`);
  }
});

test("policyIndex reports the section source file for policy --list and brief", () => {
  const index = policyIndex(repoRoot);
  assert.equal(index.length, 12);
  for (const entry of index) {
    assert.deepEqual(Object.keys(entry).sort(), ["bytes", "file", "n", "title"]);
    assert.equal(entry.file, path.join(".github", "instructions", "delivery-policy.instructions.md"));
    assert.ok(entry.bytes > 0);
    assert.match(entry.title, /.+/);
  }
});

test("the full `policy 1 2 … 12` output is byte-for-byte pinned", () => {
  const output = execFileSync(
    "node",
    ["scripts/agento.mjs", "policy", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(sha256(output), FULL_POLICY_SHA, "full policy output changed");
});
