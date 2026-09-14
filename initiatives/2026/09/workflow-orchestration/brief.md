Source: inline argument — 2026-09-14

I asked the session that uses Agento what its biggest pain points are. We need to fix the follwoing issues:

I reviewed 33 indexed Agento-related chats from September 3–14, including Prismicon, Agento itself, and adoption work in adjacent repositories. The largest friction is orchestration, not implementation or CI.

**1. Worktree and window state confusion**

This is the biggest problem. Worktree/window concepts appeared in 18 sessions, and several required explicit corrections:

- The agent twice mistook the primary window for a resumed secondary worktree.
- The user had to say “you return it to main” and later “dude, this is the primary window.”
- Closing a VS Code window, closing an Agento session, and removing a worktree were easy to conflate.
- Commands had different validity depending on whether they ran in the primary, planning, or build window.
Agento needs a canonical status command consumed by every workflow, returning the current role, active delivery, owning worktree, lifecycle state, and allowed next commands.

**2. Too much manual lifecycle routing**

The user frequently became the workflow coordinator:

`next-feature → start-session → new-feature → build → review → close → ship`

When `/ship` found problems after `/close-session`, recovery became especially awkward: return primary to `main`, reopen the feature, run another build/review, close again, then ship. One 30-turn session spent approximately turns 9–22 on this recovery path.

The highest-leverage change would be a `/continue` command that derives and performs the next legal transition. Ship audits should also happen before teardown, or `/ship` should automatically reopen a repair session when findings are rejected.

**3. Command discovery and packaging inconsistencies**

There was one concrete packaging defect: `/agento agento-init.prompt` was treated as ordinary text because commands were exported with the wrong path and `.prompt` suffix. It triggered file searching, an unrelated fallback, and a pending confirmation before the packaging was repaired.

Invocation style also varied between:

- `/agento ship ...`
- `/ship ...`
- `/agento ap.prompt ...`
- `/ap ...`
Canonical command names, aliases for old forms, and packaging tests should make command invocation unambiguous.

**4. Silent or unreliable command execution**

Nine turns across six sessions had an empty assistant response. These included duplicated `/new-feature`, duplicated `/build-feature`, and one `/ship` invocation. Users responded by retrying, saying “Try Again,” or submitting the same command twice.

Every command needs an immediate execution receipt and a terminal result:

- accepted with operation ID
- rejected with reason and allowed alternatives
- completed with resulting state
- failed with a retry-safe explanation
Commands should also be idempotent so duplicate submissions cannot corrupt lifecycle state.

**5. Capability and confirmation interruptions**

Some workflows discovered too late that:

- `vscode_askQuestions` was unavailable
- Plan mode could not execute `/start-session`
- destructive steps required manual terminal confirmation
- shipping stopped at a confirmation gate without a streamlined repair path
These are less frequent than worktree confusion, but they break momentum. Commands should preflight required capabilities before starting and declare the fallback immediately.

**Priority order**

1. Add authoritative worktree/window/session-state detection.
2. Add `/continue` and an integrated ship-finding repair path.
3. Guarantee visible, idempotent command results.
4. Standardize command names and preserve compatibility aliases.
5. Preflight tools, permissions, and execution mode.
The central design problem is that Agento exposes its internal state machine to the user. Most of the observed friction would disappear if the plugin owned state detection and transition selection, leaving the user to make product decisions rather than route commands between windows.
