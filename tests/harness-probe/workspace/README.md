# harness-probe workspace fixture

A throwaway VS Code workspace the harness-probe delivery opens as a separate
window to observe how the Copilot harness loads skills, agents, and hooks.

Contents:

- `.github/hooks/probe.json` — SessionStart and PreToolUse hooks that log their
  stdin payloads to the probe log dir (`probe setup` rewrites the logger path to
  an absolute one).
- `.github/agents/probe-pinned.agent.md` — a pinned-model subagent that also tests
  ask-user.
- `.github/agents/probe-unpinned.agent.md` — an unpinned subagent that tests
  ask-user and a nested subagent.

Do not edit files here directly while probing. Run `node ../probe.mjs setup` from
`tests/harness-probe/` (it copies this directory, rewrites `probe.json`, and
git-inits the copy) and then follow `../PROMPTS.md` in the opened window.
