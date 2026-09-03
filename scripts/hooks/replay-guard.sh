#!/usr/bin/env bash
# Replay delivery-guard decisions for a list of shell commands (one per line on stdin).
cd "$(dirname "$0")/../.." || exit 1
while IFS= read -r cmd; do
  [[ -z "$cmd" || "$cmd" == '#'* ]] && { echo "$cmd"; continue; }
  json=$(python3 -c 'import json,sys;print(json.dumps({"tool_name":"run_in_terminal","tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2]}))' "$cmd" "$PWD")
  out=$(printf '%s' "$json" | ./scripts/hooks/delivery-guard.sh)
  verdict=$(python3 -c 'import sys,json;d=sys.stdin.read().strip();print(json.loads(d)["hookSpecificOutput"]["permissionDecision"] if d else "allow")' <<<"$out")
  printf '%-75s -> %s\n' "$cmd" "$verdict"
done
