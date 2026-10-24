---
description: "Open Agento Mission Control, the read + dispatch canvas companion to the sidebar: delivery kanban, initiative wave graph, timeline, worktree and window map, and live activity feed"
argument-hint: "No arguments"
agent: "agent"
tools: [read, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: read `<agento-root>/.github/instructions/delivery-policy.instructions.md` once before the first step unless it is already in context; `<agento-root>` comes from the session context line `Agento CLI: node <agento-root>/scripts/agento.mjs`.

Open Agento Mission Control. It changes no repository files: its buttons dispatch
only the commands the CLI lists as `allowed` for the current window, and a greyed
command's handoff button opens or focuses the window that runs it and queues the
command there (`agento.mjs handoff`).

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command `/agento delivery-status`
repeated in its own block directly above the result line per §12; a duplicate
submission follows this command's §9 idempotency row (a fresh open — reopening the
canvas with the same `instanceId` reuses the live instance). Open with one `node
<agento-root>/scripts/agento.mjs preflight mission-control` call (§9–§11): print its
`receipt` and then its `preflightLines` verbatim, and stop on `status: rejected`
(exit 3). Window check per §11: requires role
`any` (opening is read-only, and dispatch buttons stay limited to this window's `allowed[]`).

1. If the `open_canvas` tool is available in this session, open the canvas with canvas
   id `agento-mission-control`, `instanceId: "mission-control"`, and input `{}`.
   Report the open result (its `url` and `status`) and summarize the canvas: the five
   panels (delivery kanban, initiative wave graph, timeline, worktree and window map,
   live activity feed) and its four agent actions (`refresh`, `get_snapshot`, `focus`,
   `post_note`). If the result says the instance is already open, say so — the same
   live server is reused.
2. If `open_canvas` is not available (this session has no canvas tools, or
   `chat.canvases.enabled` is off), do not fail — explain the prerequisites:
   a. Run `node <agento-root>/scripts/agento.mjs harness status` and report its
      `canvas` object (`link`, `expected`, `state`). When `state` is not `installed`,
      the user runs `agento.mjs harness install --plugin-root <clone>` on the
      registered plugin clone (with `--force` to replace a foreign or dangling link),
      as documented in `docs/install.md`.
   b. The user enables `chat.canvases.enabled` in VS Code user settings and opens a
      local Copilot-harness chat session (canvases run only there).
   c. Then re-run `/agento mission-control` in that session.
3. End with the §9 result line whose `next:` is `/agento delivery-status`.
