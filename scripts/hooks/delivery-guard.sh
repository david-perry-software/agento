#!/usr/bin/env bash
# PreToolUse guard: protects the default branch, forbids force-push and hook bypasses,
# nudges roadmap updates, checks worktree occupants, and gates hook-file edits behind
# approval. Branch names and artifact roots come from the target repo's
# .github/agento.json. When that config sets `artifacts.repo`, the sibling companion
# checkout — and every worktree of it, i.e. the companion halves of managed sessions —
# is governed by the product config too (its default branch is protected the same
# way) and the roadmap nudge on a product delivery-branch commit inspects the paired
# companion half's index and HEAD instead of the product commit.
#
# This is a slip guard for an LLM operator, not an enforcement boundary: it pattern
# matches shell text and can be worked around. GitHub rulesets on the default branch
# are the real enforcement layer; keep both.
#
# The policy lives in delivery-guard.mjs beside this wrapper, which reads the hook
# payload from stdin. Without node on PATH — or with node below the required 20 —
# the guard fails open visibly: it prints a one-line stderr notice, leaves stdout
# empty, and exits 0 (allow), so an unprotected session is never silent.
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
      exec node "$(dirname "${BASH_SOURCE[0]}")/delivery-guard.mjs"
    fi
    reason="node $version is below the required 20"
  else
    reason="node --version printed an unexpected value"
  fi
fi

printf '%s\n' "Agento: delivery guard inactive — $reason; tool calls are not checked (install Node >= 20; see agento.mjs doctor hook-runtime)." >&2
exit 0
