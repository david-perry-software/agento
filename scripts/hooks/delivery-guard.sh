#!/usr/bin/env bash
# PreToolUse guard: protects the default branch, forbids force-push and hook bypasses,
# nudges roadmap updates, checks worktree occupants, and gates hook-file edits behind
# approval. Branch names and artifact roots come from the target repo's
# .github/agento.json.
#
# This is a slip guard for an LLM operator, not an enforcement boundary: it pattern
# matches shell text and can be worked around. GitHub rulesets on the default branch
# are the real enforcement layer; keep both.
set -u

input="$(cat)"
export DELIVERY_HOOK_INPUT="$input"

python3 - <<'PY'
import json, os, re, shlex, subprocess, sys


def decide(verdict, reason=""):
    # Silent stdout means allow; anything else is a JSON decision.
    if verdict != "allow":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": verdict,
            "permissionDecisionReason": reason,
        }}))
    sys.exit(0)


try:
    payload = json.loads(os.environ.get("DELIVERY_HOOK_INPUT") or "{}")
except json.JSONDecodeError:
    decide("allow")

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
hook_cwd = payload.get("cwd") or payload.get("workingDirectory") or os.getcwd()

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
    return os.path.abspath(os.path.join(hook_cwd, target))

target = worktree_remove_target()
if target:
    occupants = []
    prefix = target + os.sep
    try:  # Linux only; other platforms skip the process scan.
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
        decide("ask", "Active worktree occupants detected - " + ", ".join(details)
               + ". Close their terminals or VS Code window before removal. Proceed anyway?")

# ---------------------------------------------------------------------------
# Hook self-protection: edits need per-change approval; shell writes are denied.
# ---------------------------------------------------------------------------

PROTECTED = re.compile(r"(\.github/hooks/|scripts/hooks/)")
WRITE_TOOL = re.compile(r"edit|create|write|replace|patch|apply|insert|notebook")
if file_path and PROTECTED.search(file_path) and WRITE_TOOL.search(tool):
    decide("ask", "Modifying a protected hook file; approve this specific change?")

# Shell segments: split on control operators so branch state and command words are
# evaluated per command rather than across the whole line.
SEGMENT_SPLIT = re.compile(r"\|\||&&|[;|&\n]|\bthen\b|\bdo\b|\belse\b")
segments = [s.strip() for s in SEGMENT_SPLIT.split(command or "") if s.strip()]

# Commands that only read a hook file. Anything else naming a hook path is treated as
# a write however it is spelled (rm, mv, cp, install, truncate, tee, perl -pi, ...).
READ_ONLY = {
    "cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "diff",
    "shellcheck", "ls", "stat", "file", "wc", "md5sum", "sha256sum", "shasum", "bat",
    "bash", "sh", "zsh", "source", ".", "node", "python3", "python", "echo", "printf",
    "test", "[", "which", "type", "realpath", "readlink", "basename", "dirname", "find",
    "awk", "sed", "perl", "cut", "sort", "uniq", "tr", "od", "hexdump", "strings", "cd",
    "pushd", "code",
}
GIT_SAFE_SUBCOMMANDS = {
    "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "grep", "cat-file",
    "add", "commit", "push", "stash", "rev-parse", "mv",
}
PREFIXES = {"env", "sudo", "nohup", "setsid", "exec", "time", "command", "builtin", "nice", "timeout"}
HOOK_WRITE_DENY = "Destructive shell changes to hook files are forbidden; use an edit tool so the change can be approved."

def tokens_of(segment):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()

def command_word(tokens):
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
            continue
        if tok in PREFIXES:
            i += 1
            if tok == "timeout" and i < len(tokens):
                i += 1  # skip the duration
            continue
        return tok, tokens[i + 1:]
    return "", []

for segment in segments:
    if not PROTECTED.search(segment):
        continue
    if re.search(r"(?<![<])>{1,2}\s*\S*(\.github/hooks/|scripts/hooks/)", segment):
        decide("deny", HOOK_WRITE_DENY)
    word, rest = command_word(tokens_of(segment))
    base = os.path.basename(word)
    if PROTECTED.search(word):
        continue  # running the hook script itself
    if base == "git":
        sub = next((t for t in rest if not t.startswith("-")), "")
        if sub in GIT_SAFE_SUBCOMMANDS:
            continue
        decide("deny", f"`git {sub}` against a hook file rewrites it from history; use an edit tool so the change can be approved.")
    if base in ("sed", "perl") and any(re.match(r"^-[a-zA-Z]*i|^--in-place", t) for t in rest):
        decide("deny", HOOK_WRITE_DENY)
    if base in READ_ONLY:
        continue
    if base in ("cp", "install", "rsync", "scp"):
        # Copying a hook file elsewhere is a read; only a hook destination is a write.
        positional = [t for t in rest if not t.startswith("-")]
        if positional and not PROTECTED.search(positional[-1]):
            continue
    if base in ("chmod", "chown", "touch"):
        decide("ask", f"`{base}` on a protected hook file; approve this specific change?")
    decide("deny", HOOK_WRITE_DENY)

# ---------------------------------------------------------------------------
# Open-ended watchers never return in an automation shell and idle the session.
# ---------------------------------------------------------------------------

WATCHER = re.compile(
    r"^(?:(?:env|sudo|nohup|setsid|exec|time|command|nice)\s+|timeout\s+\S+\s+)*(?:(?:-u\s+\S+|\S+=\S*)\s+)*"
    r"(?:gh\s+(?:pr\s+checks\b.*--watch|run\s+watch\b)|vercel\b.*\s--wait\b)"
)
for segment in segments:
    if WATCHER.search(segment):
        decide("deny", "Open-ended watchers idle the session; use scripts/wait-for-checks.sh pr <n> or run <id> (bounded, exit 2 = rerun).")

# ---------------------------------------------------------------------------
# GitHub merges that bypass the ruleset or rewrite history.
# ---------------------------------------------------------------------------

for segment in segments:
    if re.search(r"\bgh\s+pr\s+merge\b", segment):
        if re.search(r"\s--admin\b", segment):
            decide("deny", "Merging with --admin bypasses the repository ruleset; wait for required checks instead.")
        if re.search(r"\s(--squash|--rebase)\b", segment):
            decide("ask", "Repository policy merges with a normal merge commit; squash/rebase rewrites the branch history. Proceed anyway?")

if not command or not re.search(r"\bgit\b", command):
    decide("allow")

# ---------------------------------------------------------------------------
# Git policy: no force-push, no hook bypass, no history rewriting, nothing on main.
# ---------------------------------------------------------------------------

def target_dir():
    # Honour an explicit `git -C <path>` or a leading `cd <path> &&`; hooks do not
    # necessarily run inside the target repo.
    match = re.search(r"\bgit\s+-C\s+(\S+)", command)
    if not match:
        match = re.match(r"\s*cd\s+(\S+)\s*&&", command)
    if match:
        return os.path.expanduser(match.group(1).strip("'\""))
    return hook_cwd if isinstance(hook_cwd, str) and hook_cwd else "."

workdir = target_dir()

def git(*args):
    try:
        return subprocess.run(["git", "-C", workdir, *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

def agento_config():
    # Merge .github/agento.json over defaults; every key is optional and null keeps
    # the default, matching scripts/agento-config.mjs.
    defaults = {
        "artifacts": {"features": "features", "issues": "issues"},
        "branches": {"default": "main", "feature": "feature/", "issue": "issue/",
                     "freehand": "changes/", "postShip": "post-ship/"},
    }
    root = git("rev-parse", "--show-toplevel") or workdir
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
                    defaults[section].update({k: v for k, v in values.items() if v is not None})
        break
    return defaults

config = agento_config()
default_branch = config["branches"]["default"] or "main"
feature_prefix = config["branches"]["feature"] or "feature/"
issue_prefix = config["branches"]["issue"] or "issue/"
DEFAULT = re.escape(default_branch)
GIT = r"\bgit\b(?:\s+-[Cc]\s+\S+)*"

def commit_files(segment):
    # Files a `git commit` segment would record: explicit pathspecs, else the index,
    # plus tracked modifications when -a/--all is present.
    toks = tokens_of(segment)
    try:
        after = toks[toks.index("commit") + 1:]
    except ValueError:
        after = []
    pathspecs, all_tracked, skip = [], False, False
    for tok in after:
        if skip:
            skip = False
            continue
        if tok.startswith("--"):
            if tok in ("--message", "--file", "--author", "--date", "--fixup", "--squash",
                       "--reuse-message", "--reedit-message", "--trailer", "--template"):
                skip = True
            all_tracked = all_tracked or tok == "--all"
            continue
        if tok.startswith("-") and len(tok) > 1:
            if tok[-1] in "mFcCt":
                skip = True  # -m <msg>, -am <msg>, -F <file>, -c/-C <commit>, -t <file>
            all_tracked = all_tracked or "a" in tok[1:]
            continue
        pathspecs.append(tok)
    if pathspecs:
        return pathspecs
    files = [f for f in git("diff", "--cached", "--name-only").splitlines() if f]
    if all_tracked:
        files += [f for f in git("diff", "--name-only").splitlines() if f]
    return files

branch = git("branch", "--show-current")

for segment in segments:
    if not re.search(r"\bgit\b", segment):
        continue
    is_push = re.search(GIT + r"\s+push\b", segment) is not None
    is_commit = re.search(GIT + r"\s+commit\b", segment) is not None

    if is_push:
        if re.search(r"\s(--force(?:-with-lease|-if-includes)?(?:=\S*)?|-f)\b", segment) or re.search(r"\spush\b.*\s\+\S", segment):
            decide("deny", "Force-push is forbidden by repository policy.")
        if re.search(r"\s--no-verify\b", segment):
            decide("deny", "Bypassing pre-push hooks is forbidden by repository policy.")
        if re.search(r"\s(?:--delete\s+" + DEFAULT + r"|:" + DEFAULT + r")\b", segment):
            decide("deny", f"Deleting {default_branch} on the remote is forbidden.")
    if is_commit:
        if re.search(r"\s(--no-verify|-n)\b", segment):
            decide("deny", "Bypassing commit hooks is forbidden by repository policy.")
        if re.search(r"\s--amend\b", segment):
            decide("ask", "Amending rewrites the last commit, which is forbidden once pushed. Is this commit still local-only?")
    if re.search(GIT + r"\s+rebase\b", segment):
        decide("ask", f"Repository policy never rebases; merge origin/{default_branch} instead. Proceed anyway?")
    if re.search(GIT + r"\s+reset\b.*\s--hard\b", segment):
        decide("ask", "`git reset --hard` discards working-tree changes that may be in-progress work. Proceed anyway?")
    if re.search(GIT + r"\s+branch\b.*\s(-D|--delete\s+--force|--force\s+--delete)\b", segment):
        decide("ask", "Force-deleting a branch discards unmerged commits. Proceed anyway?")

    # Chain-aware branch tracking: a switch/checkout earlier in the same command line
    # is the effective branch for everything after it.
    created = re.search(GIT + r"\s+(?:switch\s+(?:-c|--create)\s+|checkout\s+-b\s+)([\w./-]+)", segment)
    if created:
        branch = created.group(1)
    else:
        switched = re.search(GIT + r"\s+(?:switch|checkout)\s+((?!-)[\w./-]+)\s*$", segment)
        if switched and " -- " not in segment:
            branch = switched.group(1)

    is_merge = (re.search(GIT + r"\s+(merge|cherry-pick|revert)\b", segment) is not None
                and "--ff-only" not in segment and "--abort" not in segment)
    push_to_default = re.search(r"\spush\b.*(?:\s|:)" + DEFAULT + r"\b", segment) is not None
    if (branch == default_branch and (is_commit or is_push or is_merge)) or (is_push and push_to_default):
        decide("deny", f"Direct commits/pushes to {default_branch} are forbidden; use a work branch and a pull request.")

    if is_commit and (branch.startswith(feature_prefix) or branch.startswith(issue_prefix)):
        files = commit_files(segment)
        if files and not any(f.endswith("roadmap.md") for f in files):
            decide("ask", "Committing delivery work without a roadmap.md update; progress may be lost on resume. Proceed?")

decide("allow")
PY
exit 0
