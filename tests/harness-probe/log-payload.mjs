#!/usr/bin/env node
// harness-probe hook logger.
//
// Writes one JSON file per invocation to $AGENTO_PROBE_LOG_DIR (default
// ~/.cache/agento-harness-probe/logs) recording the source, event, argv, cwd,
// the *names* (never values) of matching environment variables, and the raw
// stdin. It then answers based on markers in the stdin so the harness's honored
// output shapes can be told apart. Any internal error is caught: it exits 0 with
// no output, so a crashing probe hook can never wedge a session.
//
// Usage: node log-payload.mjs <source> <event>   (stdin = the hook payload)

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const [, , source = "unknown", event = "unknown"] = process.argv;

const logDir =
  process.env.AGENTO_PROBE_LOG_DIR ||
  path.join(homedir(), ".cache", "agento-harness-probe", "logs");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    if (process.stdin.readableEnded) resolve(data);
  });
}

function envVarNames() {
  return Object.keys(process.env)
    .filter((key) => /PLUGIN_ROOT|CLAUDE_|COPILOT_|VSCODE_/i.test(key))
    .sort();
}

async function writeLog(raw) {
  const record = {
    source,
    event,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    envVarNames: envVarNames(),
    stdin: raw,
  };
  try {
    record.parsedStdin = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    record.parsedStdin = null;
  }
  try {
    await mkdir(logDir, { recursive: true });
    const nonce = createHash("sha1")
      .update(`${process.pid}-${Date.now()}-${Math.random()}`)
      .digest("hex")
      .slice(0, 12);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(logDir, `${source}-${event}-${stamp}-${nonce}.json`);
    await writeFile(file, JSON.stringify(record, null, 2) + "\n");
  } catch {
    // Logging must never fail the hook.
  }
  return record;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  await writeLog(raw);

  if (event === "SessionStart") {
    // One object with both the nested and the top-level context slots, so the
    // user can ask the model which PROBE_CTX_* token it actually sees.
    emit({
      hookSpecificOutput: { additionalContext: "PROBE_CTX_NESTED" },
      additionalContext: "PROBE_CTX_TOPLEVEL",
    });
    return;
  }

  if (event === "PreToolUse") {
    if (raw.includes("AGENTO_PROBE_DENY_NESTED")) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "probe: AGENTO_PROBE_DENY_NESTED",
        },
      });
      return;
    }
    if (raw.includes("AGENTO_PROBE_DENY_TOPLEVEL")) {
      emit({ permissionDecision: "deny" });
      return;
    }
    if (raw.includes("AGENTO_PROBE_ASK_TOPLEVEL")) {
      emit({ permissionDecision: "ask" });
      return;
    }
    if (raw.includes("AGENTO_PROBE_EXIT2")) {
      process.exitCode = 2;
      return;
    }
  }

  // Otherwise silent, exit 0.
}

main().catch(() => {
  // Never let an internal error wedge the session.
  process.exitCode = 0;
});
