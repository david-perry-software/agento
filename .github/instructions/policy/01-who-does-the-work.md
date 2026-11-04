## 1. Who does the work

- The agent runs everything executable from its shell with an available CLI (`gh`,
  `git`, the project's CLIs declared in AGENTS.md, deploy and test commands) and
  everything verifiable by driving a browser itself (load a URL, sign in with test
  credentials, click through a flow, assert rendered state, capture a screenshot).
  Needing a CLI or a browser is never grounds to hand work to the user or to mark a
  step `(manual)`.
- Only the user can: enter secrets, act in dashboards, accounts, or vaults the agent
  cannot reach, grant approvals, operate physical devices. Those steps — and only
  those — are `(manual)`.
- Authentication failure: stop, name the exact reauth command (per AGENTS.md), wait.
  Never ask the user to run the command on your behalf.
- Never print, request, or log secrets; screenshots must not show them.
- Capabilities are checked before work starts, not discovered mid-command: every
  command opens with `agento.mjs preflight <command>`, which runs the command's
  `doctor` checks before its first write (§10). For a CLI `doctor` does not cover,
  check it with `command -v` (or the project's documented presence check) before the
  first invocation; report a missing prerequisite instead of producing exit 127.

