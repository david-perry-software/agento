## 6. Shell hygiene

- No early-closing pipeline consumers (`| head`) when `pipefail` may be active; use a
  bounded producer, the tool's own limit option, or `sed -n` — an upstream SIGPIPE
  exits the automation shell with 141.
- Run diagnostics, environment doctors, builds, and tests in a wrapper that captures
  and reports their status while leaving the shell at 0. Interpret the captured
  status: an exposing test must be nonzero when expected; every unexpected nonzero is a
  real failure. Surface stderr once; do not blindly rerun the same command.
- CI and deploy waits are bounded foreground polls, each call returning within 60 s:
  CI waits use `scripts/wait-for-checks.sh pr <n>` or `run <id>`; deploy waits use
  `node <agento-root>/scripts/agento.mjs release <merge-sha> --wait N` (N ≤ 60). Exit
  2 = still pending: rerun. Never `--watch`, background terminals, VS Code tasks, or
  ending the turn to "wait". `agento.mjs ship` and `agento.mjs publish-pr --merge`
  run their waits internally under the same ≤ 60 s bound and return `status:
  pending` (exit 2) for the re-send.

