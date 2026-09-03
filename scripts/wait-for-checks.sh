#!/usr/bin/env bash
# Bounded, foreground poller for GitHub PR checks or an Actions run.
# Replaces open-ended `gh pr checks --watch` / `gh run watch`, which never return in an
# automation shell and leave the agent idle. Every invocation terminates within
# --max-seconds and reports one status line per poll.
#
# Usage:
#   scripts/wait-for-checks.sh pr  <number> [--max-seconds N] [--interval N] [--repo OWNER/NAME]
#   scripts/wait-for-checks.sh run <run-id> [--max-seconds N] [--interval N] [--repo OWNER/NAME]
#
# Exit codes:
#   0  every check / the run completed successfully
#   1  a check or the run failed, errored, timed out, or was cancelled
#   2  still pending when --max-seconds elapsed — inspect the last line and rerun
#   3  usage error, or gh unavailable / not authenticated (do not retry; reauth)
set -uo pipefail

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}"; }

kind="${1:-}"; target="${2:-}"; shift 2 2>/dev/null || { usage; exit 3; }
max_seconds=300; interval=15; repo_args=()
while (($# > 0)); do
  case "$1" in
    --max-seconds) max_seconds="${2:-}"; shift 2 ;;
    --interval) interval="${2:-}"; shift 2 ;;
    --repo) repo_args=(--repo "${2:-}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 3 ;;
  esac
done
[[ "$kind" == "pr" || "$kind" == "run" ]] || { usage; exit 3; }
[[ "$target" =~ ^[0-9]+$ ]] || { echo "target must be a numeric PR number or run id" >&2; exit 3; }
[[ "$max_seconds" =~ ^[0-9]+$ && "$interval" =~ ^[1-9][0-9]*$ ]] || { echo "--max-seconds and --interval must be integers" >&2; exit 3; }
command -v gh >/dev/null 2>&1 || { echo "gh is not installed" >&2; exit 3; }

export GH_PAGER=cat NO_COLOR=1
unset GH_FORCE_TTY

# Prints: "<pass> <fail> <pending> <skipped> <mergeState> | <detail>" for a PR.
# shellcheck disable=SC2016 # jq program, not shell expansion
pr_snapshot() {
  gh pr view "$target" "${repo_args[@]}" --json statusCheckRollup,mergeStateStatus --jq '
    def bucket:
      if .__typename == "StatusContext" then
        (if .state == "SUCCESS" then "pass"
         elif .state == "PENDING" or .state == "EXPECTED" then "pending"
         else "fail" end)
      else
        (if .status != "COMPLETED" then "pending"
         elif .conclusion == "SUCCESS" or .conclusion == "NEUTRAL" then "pass"
         elif .conclusion == "SKIPPED" then "skipped"
         else "fail" end)
      end;
    (.statusCheckRollup // []) as $checks
    | ($checks | map({name: (.name // .context), bucket: bucket})) as $rows
    | [
        ($rows | map(select(.bucket == "pass")) | length),
        ($rows | map(select(.bucket == "fail")) | length),
        ($rows | map(select(.bucket == "pending")) | length),
        ($rows | map(select(.bucket == "skipped")) | length),
        (.mergeStateStatus // "UNKNOWN")
      ] | map(tostring) | join(" ")
      + " | "
      + ($rows | map(select(.bucket != "pass") | "\(.name)=\(.bucket)") | join(", "))
  '
}

# Prints: "<status> <conclusion> <url>" for an Actions run.
run_snapshot() {
  gh run view "$target" "${repo_args[@]}" --json status,conclusion,url \
    --jq '"\(.status) \(.conclusion // "-") \(.url)"'
}

deadline=$((SECONDS + max_seconds))
poll=0
while :; do
  poll=$((poll + 1))
  if ! snapshot=$("${kind}_snapshot" 2>&1); then
    echo "gh error: $snapshot" >&2
    if grep -qiE 'HTTP 401|HTTP 403|not logged in|authentication|gh auth login' <<<"$snapshot"; then
      echo "auth failure — run: gh auth login" >&2; exit 3
    fi
    if grep -qiE 'could not resolve|HTTP 404' <<<"$snapshot"; then
      echo "no such ${kind} $target" >&2; exit 3
    fi
    verdict=error
  elif [[ "$kind" == "pr" ]]; then
    read -r pass fail pending skipped merge_state _ <<<"$snapshot"
    detail="${snapshot#* | }"
    echo "poll $poll pr #$target: pass=$pass fail=$fail pending=$pending skipped=$skipped merge=$merge_state${detail:+ | $detail}"
    if ((fail > 0)); then verdict=fail
    elif ((pending > 0)) || ((pass + skipped == 0)); then verdict=pending
    else verdict=pass; fi
  else
    read -r status conclusion url <<<"$snapshot"
    echo "poll $poll run $target: status=$status conclusion=$conclusion $url"
    if [[ "$status" != "completed" ]]; then verdict=pending
    elif [[ "$conclusion" == "success" ]]; then verdict=pass
    else verdict=fail; fi
  fi

  case "$verdict" in
    pass) echo "RESULT: success"; exit 0 ;;
    fail) echo "RESULT: failed"; exit 1 ;;
  esac
  if ((SECONDS + interval > deadline)); then
    echo "RESULT: still pending after ${max_seconds}s — rerun this command to keep waiting"
    exit 2
  fi
  sleep "$interval"
done
