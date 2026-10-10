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
#
# The logic lives in session-context.mjs beside this wrapper, which reads the hook
# payload from stdin. Without node on PATH the hook is silent and exits 0 (no context).
set -u
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "${BASH_SOURCE[0]}")/session-context.mjs"
