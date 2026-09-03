#!/usr/bin/env bash
# PreToolUse guard: protects the default branch, forbids force-push, nudges roadmap
# updates, checks worktree occupants, and gates hook-file edits behind approval.
# Branch names and artifact roots come from the target repo's .github/agento.json.
set -u

input="$(cat)"
export DELIVERY_HOOK_INPUT="$input"

decision="$(python3 - <<'PY'
import json, os, re, subprocess, sys

try:
    payload = json.loads(os.environ.get("DELIVERY_HOOK_INPUT") or "{}")
except json.JSONDecodeError:
    print("allow::"); sys.exit(0)

tool = (payload.get("tool_name") or payload.get("toolName") or "").lower()
tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
if not isinstance(tool_input, dict):
    tool_input = {}

def first(*keys):
    for key in keys:
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return ""

command = first("command", "commandLine", "text")
file_path = first("filePath", "file_path", "path", "uri")

def worktree_remove_target():
    match = re.search(
        r"\bgit(?:\s+-C\s+(?:\"[^\"]+\"|'[^']+'|\S+))?\s+worktree\s+remove"
        r"(?:\s+--[^\s]+)*\s+(\"[^\"]+\"|'[^']+'|[^\s;&|]+)",
        command,
    )
    if not match:
        return ""
    target = match.group(1).strip("'\"")
    if not target or target.startswith("$"):
        return ""
    cwd = payload.get("cwd") or payload.get("workingDirectory") or os.getcwd()
    return os.path.abspath(os.path.join(cwd, target))

target = worktree_remove_target()
if target:
    occupants = []
    prefix = target + os.sep
    try:
        with os.scandir("/proc") as proc_entries:
            for entry in proc_entries:
                if not entry.name.isdigit():
                    continue
                try:
                    process_cwd = os.readlink(f"/proc/{entry.name}/cwd")
                    if process_cwd != target and not process_cwd.startswith(prefix):
                        continue
                    with open(f"/proc/{entry.name}/comm", encoding="utf-8") as handle:
                        process_name = handle.read().strip()
                    process_name = re.sub(r"[^A-Za-z0-9_.+-]", "?", process_name)
                    occupants.append(f"PID {entry.name} ({process_name})")
                except (FileNotFoundError, PermissionError, OSError):
                    continue
    except OSError:
        pass

    window_open = False
    try:
        status = subprocess.run(
            ["code", "--status"], capture_output=True, text=True, timeout=5
        ).stdout
        folder_names = re.findall(r"^\|\s+Folder \(([^)]+)\):", status, re.MULTILINE)
        window_open = os.path.basename(target) in folder_names
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass

    if occupants or window_open:
        details = occupants[:3]
        if len(occupants) > 3:
            details.append(f"and {len(occupants) - 3} more processes")
        if window_open:
            details.append("a matching VS Code folder")
        summary = ", ".join(details)
        print(
            "ask:Active worktree occupants detected - " + summary
            + ". Close their terminals or VS Code window before removal. Proceed anyway?:"
        )
        sys.exit(0)

# Hook self-protection: writes need per-edit user approval; reads pass freely.
protected = re.compile(r"(\.github/hooks/|scripts/hooks/)")
write_tool = re.compile(r"edit|create|write|replace|patch|apply|insert|notebook")
if file_path and protected.search(file_path) and write_tool.search(tool):
    print("ask:Modifying a protected hook file; approve this specific change?:")
    sys.exit(0)
# Destructive only when a hook path is the TARGET of the destructive token.
hook_target = r"[^|;&]*\S*(\.github/hooks/|scripts/hooks/)"
destructive = re.compile(
    r"(\brm\b" + hook_target + r")|(\bmv\b" + hook_target + r")|(>\s*\S*(\.github/hooks/|scripts/hooks/))"
    r"|(\btee\b" + hook_target + r")|(\bsed\b[^|;&]*-i" + hook_target + r")"
)
if command and destructive.search(command):
    print("deny:Destructive shell changes to hook files are forbidden; use an edit tool so the change can be approved.:")
    sys.exit(0)

# Open-ended CI/deploy watchers never return in an automation shell and idle the
# session; anchor on the executed command so `pkill -f '... --watch'` still passes.
watcher = re.compile(
    r"(?:^|[|;&(]|\bthen\b|\bdo\b)\s*(?:env\s+)?(?:(?:-u\s+\S+|\S+=\S*)\s+)*"
    r"(?:gh\s+(?:pr\s+checks\b[^|;&]*--watch|run\s+watch\b)|vercel\b[^|;&]*\s--wait\b)"
)
if command and watcher.search(command):
    print("deny:Open-ended watchers idle the session; use scripts/wait-for-checks.sh pr <n> or run <id> (bounded, exit 2 = rerun).:")
    sys.exit(0)

if not command or not re.search(r"\bgit\b", command):
    print("allow::"); sys.exit(0)

if re.search(r"\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)", command):
    print("deny:Force-push is forbidden by repository policy.:")
    sys.exit(0)

is_commit = re.search(r"\bgit\b[^|;&]*\bcommit\b", command) is not None
is_push = re.search(r"\bgit\b[^|;&]*\bpush\b", command) is not None
if not (is_commit or is_push):
    print("allow::"); sys.exit(0)

def target_dir():
    # Honour an explicit `git -C <path>` or a leading `cd <path> &&` before
    # reading branch state; hooks do not necessarily run in the target repo.
    match = re.search(r"\bgit\s+-C\s+(\S+)", command)
    if not match:
        match = re.match(r"\s*cd\s+(\S+)\s*&&", command)
    if match:
        return os.path.expanduser(match.group(1).strip("'\""))
    cwd = payload.get("cwd") or payload.get("workingDirectory")
    return cwd if isinstance(cwd, str) and cwd else "."

workdir = target_dir()

def git(*args):
    try:
        return subprocess.run(["git", "-C", workdir, *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

def repo_root():
    top = git("rev-parse", "--show-toplevel")
    return top if top else workdir

def agento_config():
    # Merge .github/agento.json over defaults; every key is optional.
    defaults = {
        "artifacts": {"features": "features", "issues": "issues"},
        "branches": {
            "default": "main",
            "feature": "feature/",
            "issue": "issue/",
            "freehand": "changes/",
            "postShip": "post-ship/",
        },
    }
    root = repo_root()
    for rel in (".github/agento.json", "agento.json"):
        candidate = os.path.join(root, rel)
        if not os.path.isfile(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8") as handle:
                loaded = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(loaded, dict):
            for section, values in loaded.items():
                if isinstance(values, dict) and isinstance(defaults.get(section), dict):
                    defaults[section].update(values)
        break
    return defaults

config = agento_config()
default_branch = config["branches"]["default"] or "main"
feature_prefix = config["branches"]["feature"] or "feature/"
issue_prefix = config["branches"]["issue"] or "issue/"

branch = git("branch", "--show-current")
# Chain-aware: a branch created earlier in the same command is the effective branch.
for match in re.finditer(r"\bgit\s+(?:switch\s+(?:-c|--create)\s+|checkout\s+-b\s+)([\w./-]+)", command):
    branch = match.group(1)
push_to_default = re.search(
    r"\bpush\b[^|;&]*\b(?:origin\s+)?" + re.escape(default_branch) + r"\b", command
)
if branch == default_branch or push_to_default:
    print(f"deny:Direct commits/pushes to {default_branch} are forbidden; use a work branch and a pull request.:")
    sys.exit(0)

if is_commit and (branch.startswith(feature_prefix) or branch.startswith(issue_prefix)):
    staged = git("diff", "--cached", "--name-only")
    files = [line for line in staged.splitlines() if line]
    if files and not any(f.endswith("roadmap.md") for f in files):
        print("ask:Committing delivery work without a roadmap.md update; progress may be lost on resume. Proceed?:")
        sys.exit(0)

print("allow::")
PY
)"

verdict="${decision%%:*}"
rest="${decision#*:}"
reason="${rest%%:*}"

if [ "$verdict" = "allow" ]; then
  exit 0
fi

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
  "$verdict" "$reason"
exit 0
