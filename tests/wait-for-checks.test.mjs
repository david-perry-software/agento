import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repoRoot, "scripts", "wait-for-checks.sh");

// Installs a fake `gh` whose successive invocations return the given JSON payloads
// (the last one repeats); it applies the --jq program with real jq if available,
// otherwise it emits pre-rendered lines.
function fakeGh(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-gh-"));
  fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -u
dir="$(dirname "$0")"
n=$(cat "$dir/count" 2>/dev/null || echo 0); echo $((n + 1)) > "$dir/count"
python3 - "$dir/responses.json" "$n" "$@" <<'PY'
import json, sys
responses = json.load(open(sys.argv[1])); n = int(sys.argv[2]); args = sys.argv[3:]
r = responses[min(n, len(responses) - 1)]
if r.get("error"):
    sys.stderr.write(r["error"] + "\\n"); sys.exit(1)
print(r["line"])
PY
`,
  );
  fs.chmodSync(gh, 0o755);
  return dir;
}

function run(args, ghDir) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` },
    timeout: 30000,
  });
}

test("usage errors exit 3 before touching gh", () => {
  const dir = fakeGh([{ line: "" }]);
  assert.equal(run(["pr"], dir).status, 3);
  assert.equal(run(["pr", "abc"], dir).status, 3);
  assert.equal(run(["nope", "1"], dir).status, 3);
  assert.equal(run(["pr", "1", "--bogus"], dir).status, 3);
});

test("pr: all checks passing exits 0", () => {
  const dir = fakeGh([{ line: "2 0 0 0 CLEAN | " }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "5"], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT: success/);
});

test("pr: a failing check exits 1 and names it", () => {
  const dir = fakeGh([{ line: "1 1 0 0 BLOCKED | lint=fail" }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "5"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lint=fail/);
  assert.match(result.stdout, /RESULT: failed/);
});

test("pr: pending until the deadline exits 2", () => {
  const dir = fakeGh([{ line: "0 0 1 0 BLOCKED | test=pending" }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "2"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /still pending/);
});

test("pr: pending then passing exits 0 after polling", () => {
  const dir = fakeGh([{ line: "0 0 1 0 BLOCKED | test=pending" }, { line: "1 0 0 0 CLEAN | " }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "10"], dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /poll 2 /);
});

test("pr: zero checks with a CLEAN merge state succeeds immediately", () => {
  const dir = fakeGh([{ line: "0 0 0 0 CLEAN | " }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "5"], dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /no checks reported/);
});

test("pr: zero checks succeeds once the no-checks grace period elapses", () => {
  const dir = fakeGh([{ line: "0 0 0 0 BLOCKED | " }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "10", "--no-checks-grace", "2"], dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /no checks reported/);
  assert.match(result.stdout, /poll 2/);
});

test("run: completed success exits 0, failure exits 1", () => {
  const ok = run(["run", "42", "--interval", "1"], fakeGh([{ line: "completed success https://x" }]));
  assert.equal(ok.status, 0, ok.stdout);
  const bad = run(["run", "42", "--interval", "1"], fakeGh([{ line: "completed failure https://x" }]));
  assert.equal(bad.status, 1);
});

test("auth failures exit 3 without retrying", () => {
  const dir = fakeGh([{ error: "HTTP 401: Bad credentials — run gh auth login" }]);
  const result = run(["pr", "7", "--interval", "1", "--max-seconds", "5"], dir);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /gh auth login/);
});
