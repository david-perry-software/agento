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
# payload from stdin. Without node on PATH the hook is silent and exits 0 (allow).
set -u
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "${BASH_SOURCE[0]}")/delivery-guard.mjs"
