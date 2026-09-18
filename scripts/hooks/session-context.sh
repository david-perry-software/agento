#!/usr/bin/env bash
# SessionStart context: surface the current branch, any resumable delivery work, the
# path of the Agento CLI (scripts/agento.mjs) so prompts can call it from the target
# repo, and a one-line `Session:` summary from `agento.mjs session` (role, worktree,
# delivery, lifecycle, allowed commands) when Node is available. Operates on the repo
# from the hook input's cwd; artifact roots come from the target repo's
# .github/agento.json (defaults: features/, issues/). When that config sets
# `artifacts.repo`, the roadmaps are read from the sibling companion checkout instead
# (resolved against the primary checkout) and an `Artifacts: <path> (branch <b>)` line
# names it directly after `Session:`. From a managed product worktree `<kind>-<id>`
# whose companion half `<companion>-worktrees/<kind>-<id>` exists, that half is the
# artifacts checkout named and walked instead of the companion clone.
set -u

input="$(cat)"
export DELIVERY_HOOK_INPUT="$input"
AGENTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AGENTO_ROOT

python3 - <<'PY'
import json, os, re, shutil, subprocess, sys

try:
    payload = json.loads(os.environ.get("DELIVERY_HOOK_INPUT") or "{}")
except json.JSONDecodeError:
    payload = {}

cwd = payload.get("cwd") or payload.get("workingDirectory") or os.getcwd()

def git(*args):
    return run_git(cwd, *args)


def run_git(directory, *args):
    try:
        return subprocess.run(["git", "-C", directory, *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

root = git("rev-parse", "--show-toplevel") or cwd
branch = git("branch", "--show-current") or "unknown"


# --- shared with scripts/hooks/delivery-guard.sh; keep both copies identical ---
CONFIG_DEFAULTS = {
    "artifacts": {"features": "features", "issues": "issues", "repo": {"name": None, "dir": None}},
    "branches": {"default": "main", "feature": "feature/", "issue": "issue/",
                 "freehand": "changes/", "postShip": "post-ship/"},
}


def load_config(root):
    # Merge .github/agento.json over defaults; every key is optional and null keeps
    # the default, matching scripts/agento-config.mjs. `artifacts.repo` merges nested.
    config = json.loads(json.dumps(CONFIG_DEFAULTS))
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
                target = config.get(section)
                if not isinstance(values, dict) or not isinstance(target, dict):
                    continue
                for key, value in values.items():
                    if value is None:
                        continue
                    if isinstance(value, dict) and isinstance(target.get(key), dict):
                        target[key].update({k: v for k, v in value.items() if v is not None})
                    else:
                        target[key] = value
        break
    return config


def resolve_artifacts(product_root):
    # Mirror scripts/agento.mjs resolveArtifacts(): the checkout decides, the primary
    # anchors. `artifacts.repo` unset (name and dir both null) in the checkout's own
    # config keeps the in-repo layout with no extra git call; else the companion path
    # resolves against the primary checkout (first `git worktree list` entry), using
    # the primary's `repo` when it sets one and the checkout's own otherwise, so
    # managed worktrees never point into worktrees.dir and a branch that introduces
    # the companion resolves it before the primary carries the config.
    # Returns (external, companion_path, name, companion_worktrees_dir, primary_root);
    # the companion's session halves live under `<companion_path>-worktrees/<kind>-<id>`.
    repo = load_config(product_root)["artifacts"]["repo"]
    if repo.get("name") is None and repo.get("dir") is None:
        return False, None, None, None, product_root
    primary_root = product_root
    for line in run_git(product_root, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            primary_root = line[len("worktree "):].strip()
            break
    if os.path.realpath(primary_root) != os.path.realpath(product_root):
        primary_repo = load_config(primary_root)["artifacts"]["repo"]
        if primary_repo.get("name") is not None or primary_repo.get("dir") is not None:
            repo = primary_repo
    path = os.path.abspath(os.path.join(primary_root, repo.get("dir") or os.path.join("..", repo["name"])))
    return True, path, repo.get("name") or os.path.basename(path), path + "-worktrees", primary_root
# --- end shared helpers ---


def session_summary(cli):
    # One `Session:` line from `agento.mjs session`; any failure (no node, nonzero
    # exit, timeout, bad JSON) returns None so the output stays exactly as before.
    node = shutil.which("node")
    if not node:
        return None
    try:
        result = subprocess.run([node, cli, "session", "--root", cwd], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("status") != "ok":
        return None
    worktree = data.get("worktree") or {}
    delivery = data.get("delivery")
    delivery_text = "none"
    if isinstance(delivery, dict) and delivery.get("slug"):
        delivery_text = f"{delivery.get('type')}/{delivery.get('slug')}"
    allowed = "; ".join(str(c) for c in (data.get("allowed") or []))
    elsewhere = "; ".join(
        f"{e.get('command')}@{e.get('window')}" for e in (data.get("elsewhere") or []) if isinstance(e, dict)
    )
    return (
        f"Session: role={data.get('role')} worktree={worktree.get('path')} "
        f"branch={worktree.get('branch') or 'detached'} delivery={delivery_text} "
        f"lifecycle={data.get('lifecycle')} allowed=[{allowed}] elsewhere=[{elsewhere}]"
    )

config = load_config(root)
roots = [config["artifacts"]["features"] or "features", config["artifacts"]["issues"] or "issues"]
external, companion, _, companion_worktrees, primary_root = resolve_artifacts(root)
# A managed product half `<kind>-<id>` pairs with `<companion>-worktrees/<kind>-<id>`;
# when that half exists it is the session's artifacts checkout, not the clone.
MANAGED_DIR = re.compile(r"^(plan|feature|issue|freehand)-(.+)$")
if external and os.path.realpath(root) != os.path.realpath(primary_root) and MANAGED_DIR.match(os.path.basename(root)):
    half = os.path.join(companion_worktrees, os.path.basename(root))
    if os.path.isdir(half):
        companion = half
# In companion mode the product's own features/ and issues/ are ignored.
walk_root = companion if external else root

lines = [f"Current git branch: {branch}"]
agento_root = os.environ.get("AGENTO_ROOT", "")
if agento_root and os.path.isfile(os.path.join(agento_root, "scripts", "agento.mjs")):
    cli = os.path.join(agento_root, "scripts", "agento.mjs")
    lines.append(f"Agento CLI: node {cli}")
    session_line = session_summary(cli)
    if session_line:
        lines.append(session_line)
if external:
    companion_branch = (run_git(companion, "branch", "--show-current") if os.path.isdir(companion) else "") or "detached"
    lines.append(f"Artifacts: {companion} (branch {companion_branch})")
found = False
for base in dict.fromkeys(roots):
    base_path = os.path.join(walk_root, base)
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
        rel = os.path.relpath(dirpath, walk_root)
        lines.append(f"Delivery work: {rel} [status: {status_value}] next-step: {next_value}")
        found = True

if not found:
    lines.append(f"No in-progress delivery work in {roots[0]}/ or {roots[-1]}/.")

print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}))
PY
exit 0
