#!/usr/bin/env bash
# SessionStart context: surface the current branch, any resumable delivery work, and
# the path of the Agento CLI (scripts/agento.mjs) so prompts can call it from the
# target repo. Operates on the repo from the hook input's cwd; artifact roots come
# from the target repo's .github/agento.json (defaults: features/, issues/).
set -u

input="$(cat)"
export DELIVERY_HOOK_INPUT="$input"
AGENTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AGENTO_ROOT

python3 - <<'PY'
import json, os, re, subprocess, sys

try:
    payload = json.loads(os.environ.get("DELIVERY_HOOK_INPUT") or "{}")
except json.JSONDecodeError:
    payload = {}

cwd = payload.get("cwd") or payload.get("workingDirectory") or os.getcwd()

def git(*args):
    try:
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

root = git("rev-parse", "--show-toplevel") or cwd
branch = git("branch", "--show-current") or "unknown"

roots = ["features", "issues"]
for rel in (".github/agento.json", "agento.json"):
    candidate = os.path.join(root, rel)
    if not os.path.isfile(candidate):
        continue
    try:
        with open(candidate, encoding="utf-8") as handle:
            config = json.load(handle)
        artifacts = config.get("artifacts") or {}
        # null means "keep the default", matching scripts/agento-config.mjs.
        roots = [artifacts.get("features") or "features", artifacts.get("issues") or "issues"]
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    break

lines = [f"Current git branch: {branch}"]
agento_root = os.environ.get("AGENTO_ROOT", "")
if agento_root and os.path.isfile(os.path.join(agento_root, "scripts", "agento.mjs")):
    lines.append(f"Agento CLI: node {os.path.join(agento_root, 'scripts', 'agento.mjs')}")
found = False
for base in dict.fromkeys(roots):
    base_path = os.path.join(root, base)
    for dirpath, _dirnames, filenames in os.walk(base_path):
        if "roadmap.md" not in filenames:
            continue
        roadmap = os.path.join(dirpath, "roadmap.md")
        try:
            with open(roadmap, encoding="utf-8") as handle:
                content = handle.read()
        except OSError:
            continue
        status = re.search(r"^status:\s*([^\n#]+)", content, re.MULTILINE)
        status_value = status.group(1).strip() if status else ""
        if status_value not in ("in-progress", "paused", "in-review"):
            continue
        next_step = re.search(r"^next-step:\s*([^\n#]+)", content, re.MULTILINE)
        next_value = next_step.group(1).strip() if next_step else ""
        rel = os.path.relpath(dirpath, root)
        lines.append(f"Delivery work: {rel} [status: {status_value}] next-step: {next_value}")
        found = True

if not found:
    lines.append(f"No in-progress delivery work in {roots[0]}/ or {roots[-1]}/.")

print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}))
PY
exit 0
