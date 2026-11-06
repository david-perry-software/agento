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
# payload from stdin. Without node on PATH — or with node below the required 20 —
# the hook fails open visibly: it prints a static dual-shape JSON warning on stdout
# (so the model sees and relays it) and a one-line stderr notice, then exits 0.
set -u

if ! command -v node >/dev/null 2>&1; then
  reason="node not found on PATH"
else
  version="$(node --version 2>/dev/null || true)"
  rest="${version#v}"
  parts_valid="yes"
  case "$rest" in
    ''|*[!0-9.]*) parts_valid="no" ;;
  esac
  if [ "$parts_valid" = "yes" ]; then
    IFS='.' read -r -a parts <<< "$rest"
    for part in "${parts[@]}"; do
      case "$part" in ''|*[!0-9]*) parts_valid="no" ;; esac
    done
  fi
  if [ "$parts_valid" = "yes" ]; then
    if [ "${parts[0]}" -ge 20 ]; then
      exec node "$(dirname "${BASH_SOURCE[0]}")/session-context.mjs"
    fi
    reason="node $version is below the required 20"
  else
    reason="node --version printed an unexpected value"
  fi
fi

msg="Agento hooks inactive: $reason (Node >= 20 required). The delivery guard allows every tool call unchecked and no Agento session context is available — tell the user before doing any delivery work."
printf '%s\n' "{\"additionalContext\":\"$msg\",\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"$msg\"}}"
printf '%s\n' "Agento: session context unavailable — $reason (install Node >= 20; see agento.mjs doctor hook-runtime)." >&2
exit 0
