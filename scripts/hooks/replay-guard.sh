#!/usr/bin/env bash
# Replay delivery-guard decisions for shell commands read from stdin, one per line.
# A line may be prefixed with its expected verdict (`allow`, `ask`, or `deny`) followed
# by whitespace; mismatches are reported and make the script exit 1. Blank lines and
# `#` comments pass through. Commands run against a throwaway git repo checked out on
# a feature branch (override with REPLAY_CWD=<dir>) so verdicts reflect the command,
# not the caller's branch.
#
# REPLAY_FORMAT=copilot replays the same fixture lines as Copilot `Bash` payloads,
# reads the top-level `permissionDecision`, and reports a MISMATCH when the nested
# `hookSpecificOutput.permissionDecision` disagrees with it. A file-tool payload is
# spelled `<verdict> @<Tool> <path>` (e.g. `ask @Write .github/hooks/x.json`) and
# builds `{tool_name: <Tool>, tool_input: {path}}`.
#
# REPLAY_COMPANION=1 additionally creates a sibling companion repo `<cwd>-docs` (on
# feature/replay), commits `.github/agento.json` pointing `artifacts.repo.dir` at it
# with `branches.default` set to `trunk` (so companion-default-branch verdicts prove
# the product config governs, not the guard's built-in `main`), and replaces the
# literal token `{companion}` in each command with the companion's absolute path —
# the setup for tests/guard-fixtures-companion.txt. It only applies to the throwaway
# repo, never to a caller-supplied REPLAY_CWD.
set -u
cd "$(dirname "$0")/../.." || exit 1
guard="$PWD/scripts/hooks/delivery-guard.sh"
format="${REPLAY_FORMAT:-local}"
if [[ "$format" != "local" && "$format" != "copilot" ]]; then
  echo "REPLAY_FORMAT must be local or copilot, got: $format" >&2
  exit 1
fi

companion=""
if [[ -n "${REPLAY_CWD:-}" ]]; then
  if [[ -n "${REPLAY_COMPANION:-}" ]]; then
    echo "REPLAY_COMPANION=1 needs the throwaway repo; unset REPLAY_CWD" >&2
    exit 1
  fi
  cwd="$REPLAY_CWD"
else
  cwd="$(mktemp -d)"
  trap 'rm -rf "$cwd" "${cwd}-docs"' EXIT
  git -C "$cwd" init -q -b main
  git -C "$cwd" -c user.email=replay@example.com -c user.name=replay commit -q --allow-empty -m init
  git -C "$cwd" switch -q -c feature/replay
  if [[ -n "${REPLAY_COMPANION:-}" ]]; then
    companion="${cwd}-docs"
    git init -q -b trunk "$companion"
    git -C "$companion" -c user.email=replay@example.com -c user.name=replay commit -q --allow-empty -m init
    git -C "$companion" switch -q -c feature/replay
    mkdir -p "$cwd/.github"
    printf '{"artifacts":{"repo":{"dir":"../%s-docs"}},"branches":{"default":"trunk"}}\n' "$(basename "$cwd")" > "$cwd/.github/agento.json"
    git -C "$cwd" add .github/agento.json
    git -C "$cwd" -c user.email=replay@example.com -c user.name=replay commit -q -m "companion config"
  fi
fi

failures=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" == '#'* ]] && { echo "$line"; continue; }
  expected=""
  is_file_tool=0
  file_tool=""
  file_path=""
  cmd="$line"
  if [[ "$line" =~ ^(allow|ask|deny)[[:space:]]+@([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+(.*)$ ]]; then
    expected="${BASH_REMATCH[1]}"
    file_tool="${BASH_REMATCH[2]}"
    file_path="${BASH_REMATCH[3]}"
    is_file_tool=1
  elif [[ "$line" =~ ^(allow|ask|deny)[[:space:]]+(.*)$ ]]; then
    expected="${BASH_REMATCH[1]}"
    cmd="${BASH_REMATCH[2]}"
  fi
  if [[ -n "$companion" ]]; then
    cmd="${cmd//\{companion\}/$companion}"
    file_path="${file_path//\{companion\}/$companion}"
  fi
  tool_name="run_in_terminal"
  if [[ "$format" == "copilot" ]]; then
    tool_name="Bash"
  fi
  if [[ "$is_file_tool" == 1 ]]; then
    json=$(REPLAY_TOOL="$file_tool" REPLAY_PATH="$file_path" REPLAY_DIR="$cwd" node -e 'console.log(JSON.stringify({tool_name:process.env.REPLAY_TOOL,tool_input:{path:process.env.REPLAY_PATH},cwd:process.env.REPLAY_DIR}))')
  else
    json=$(REPLAY_TOOL="$tool_name" REPLAY_CMD="$cmd" REPLAY_DIR="$cwd" node -e 'console.log(JSON.stringify({tool_name:process.env.REPLAY_TOOL,tool_input:{command:process.env.REPLAY_CMD},cwd:process.env.REPLAY_DIR}))')
  fi
  out=$(printf '%s' "$json" | "$guard")
  if [[ "$format" == "copilot" ]]; then
    verdict=$(printf '%s' "$out" | node -e 'const d=require("fs").readFileSync(0,"utf8").trim();if(!d){console.log("allow")}else{const o=JSON.parse(d);const top=o.permissionDecision;const nested=o.hookSpecificOutput&&o.hookSpecificOutput.permissionDecision;console.log(top===nested?top:"MISMATCH")}')
  else
    verdict=$(printf '%s' "$out" | node -e 'const d=require("fs").readFileSync(0,"utf8").trim();console.log(d?JSON.parse(d).hookSpecificOutput.permissionDecision:"allow")')
  fi
  display="$cmd"
  if [[ "$is_file_tool" == 1 ]]; then
    display="@$file_tool $file_path"
  fi
  if [[ -n "$expected" && "$verdict" != "$expected" ]]; then
    printf '%-75s -> %s  (expected %s) MISMATCH\n' "$display" "$verdict" "$expected"
    failures=$((failures + 1))
  else
    printf '%-75s -> %s\n' "$display" "$verdict"
  fi
done

if ((failures > 0)); then
  echo "$failures fixture(s) did not match their expected verdict" >&2
  exit 1
fi
