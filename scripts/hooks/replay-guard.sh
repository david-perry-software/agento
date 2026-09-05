#!/usr/bin/env bash
# Replay delivery-guard decisions for shell commands read from stdin, one per line.
# A line may be prefixed with its expected verdict (`allow`, `ask`, or `deny`) followed
# by whitespace; mismatches are reported and make the script exit 1. Blank lines and
# `#` comments pass through. Commands run against a throwaway git repo checked out on
# a feature branch (override with REPLAY_CWD=<dir>) so verdicts reflect the command,
# not the caller's branch.
set -u
cd "$(dirname "$0")/../.." || exit 1
guard="$PWD/scripts/hooks/delivery-guard.sh"

if [[ -n "${REPLAY_CWD:-}" ]]; then
  cwd="$REPLAY_CWD"
else
  cwd="$(mktemp -d)"
  trap 'rm -rf "$cwd"' EXIT
  git -C "$cwd" init -q -b main
  git -C "$cwd" -c user.email=replay@example.com -c user.name=replay commit -q --allow-empty -m init
  git -C "$cwd" switch -q -c feature/replay
fi

failures=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" == '#'* ]] && { echo "$line"; continue; }
  expected=""
  cmd="$line"
  if [[ "$line" =~ ^(allow|ask|deny)[[:space:]]+(.*)$ ]]; then
    expected="${BASH_REMATCH[1]}"
    cmd="${BASH_REMATCH[2]}"
  fi
  json=$(python3 -c 'import json,sys;print(json.dumps({"tool_name":"run_in_terminal","tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2]}))' "$cmd" "$cwd")
  out=$(printf '%s' "$json" | "$guard")
  verdict=$(python3 -c 'import sys,json;d=sys.stdin.read().strip();print(json.loads(d)["hookSpecificOutput"]["permissionDecision"] if d else "allow")' <<<"$out")
  if [[ -n "$expected" && "$verdict" != "$expected" ]]; then
    printf '%-75s -> %s  (expected %s) MISMATCH\n' "$cmd" "$verdict" "$expected"
    failures=$((failures + 1))
  else
    printf '%-75s -> %s\n' "$cmd" "$verdict"
  fi
done

if ((failures > 0)); then
  echo "$failures fixture(s) did not match their expected verdict" >&2
  exit 1
fi
