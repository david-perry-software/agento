---
description: "Derive the one legal next delivery transition from the session record and perform it — build, review, or ship here, or open the worktree window that owns the next step; optional slug when several deliveries are in flight"
argument-hint: "[<slug>]"
agent: "agent"
---

Needs: terminal, ask-questions, browser, gh, code, network
Fallback: ask-questions, browser, code → §10 standard fallbacks (the dispatched command's own soft needs apply once it runs)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Continue the delivery lifecycle from wherever it stands. The Agento CLI derives the
single transition that is legal right now — `node <agento-root>/scripts/agento.mjs
next [<slug>]`, path announced in the session context as `Agento CLI:` — and this
command **performs** it: in this window by following the named command's own files,
or across windows by opening the worktree window that owns the next step and naming
the command for it. Exactly one transition per invocation; anything not derivable is
a rejection that lists the choices. This command adds no workflow logic of its own:
`deriveNext` in `scripts/session-state.mjs` is the only transition table, and the
dispatched command's prompt and agent files are the only procedure.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row: it re-derives from git + roadmap state and performs whatever
transition is now legal — never a second worktree, branch, or PR — and the dispatched
command's own row governs the rest. Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for continue` and map `fail`/`warn`
per §10; the needs above are the union of what the dispatched commands declare.
Window check per §11: requires role `primary`, `plan`, or `build` (in `build` or
`plan`, a slug argument must equal the record's `delivery.slug`; `freehand` and
`unmanaged` reject with the record's alternatives).

## Procedure

1. **Session.** Run `node <agento-root>/scripts/agento.mjs session` and apply the
   window check above from its `role`, `worktree`, and `delivery`. Never inspect
   worktrees yourself; the record is the only source.
2. **Derive.** Run `node <agento-root>/scripts/agento.mjs next` — with the slug
   argument appended verbatim when one was given — and read `status`, `next`,
   `candidates`, `dispatch`, `reviewFresh`, `reason`, and `warnings`. Surface every
   `warnings[]` entry once (for example, a branch judged from its local ref because
   `origin/<branch>` was never fetched).
3. **Map `status`:**
   - `ok` → perform `next` (step 4).
   - `none` → nothing to perform: end with a completed result whose state is the
     record's `lifecycle` and whose `next:` is the first entry of the record's
     `allowed[]` (or `reason` when it names a command).
   - `ambiguous` → rejection listing every `candidates[].invocation` — each is
     `/agento continue <slug>` — with its `kind`, `status`, and `initiative`.
   - `blocked`, `unsupported`, `missing` → rejection quoting `reason` verbatim and
     listing the record's alternatives per §9.
   - exit 1 (usage) → rejection quoting `message`; the slug must match
     `[a-z0-9][a-z0-9-]{1,63}`.
4. **Perform `next`** — one transition, in the window `next.window` names:
   - `here` → read `dispatch.prompt` (the command file under `<agento-root>/commands/`)
     and, when non-null, `dispatch.agent` (the agent file whose `name:` the prompt's
     `agent:` frontmatter selects). Carry that command out exactly as those files
     say, with `next.args` as its arguments, applying the agent file's rules verbatim
     — its resume protocol, its own `doctor --for <command>` call, its own window
     check, its evidence and hand-off rules. Nothing in this command overrides them.
     For `start-session`, `next.args` may be empty (plan mode) or
     `<type>/<slug> [--resume]` (build mode); when `next.then` is set, that command
     is the first thing to run in the window `start-session` opens.
   - `primary` or `secondary` → the transition belongs to another window. Locate it
     from the record: `primary` is `worktrees[0].path`; `secondary` is the managed
     entry in `worktrees[]` whose `branch` equals `delivery.branch` (its `repo` is
     `product`). For `secondary`, open the pair's workspace file when it exists —
     `<path>.code-workspace` next to that entry, written by `/agento start-session` in
     companion mode (the record's own `workspace.path` when this window is inside the
     pair) — otherwise the folder path; `primary` is always the folder path (the
     primary window has no pair). When the `code` CLI is available (doctor check
     `code` is `ok`), run `code <workspace-or-path>` — it reuses an already-open
     window — and name `next.invocation` as the command to run there, emitted as its
     own block per policy §12 (and `next.then`, when set, as a second block after
     it); otherwise apply the `code` fallback from §10 and name the same command. Do
     not run the command in this window, and never run `/agento ship` from anywhere
     but the primary window.
5. **Result.** The response carries one receipt (this command's) and one result line:
   the dispatched command's own outcome when it ran here, otherwise this command's
   completed state naming the window that was opened. Its `next:` is `next.then` when
   set; else `/agento continue <slug>` (the slug that was acted on) when a further
   transition may follow; else the dispatched command's own `next:` — repeated as a
   block directly above the result line per policy §12.

## What continue never does

- Never chooses `/agento ap`, quick-fix, freehand, or commit-current-changes tiers;
  those windows and commands are reached by their own names (Decision Q4 of the plan).
- Never chains a second transition in the same invocation, even when `next.then` is
  obvious — the user re-sends `/agento continue` (or the named `then`) in the new
  window.
- Never marks a PR ready, merges, or tears a worktree down outside `/agento ship`'s own
  text when that is the command being performed.
- Never restates the policy: the receipt, result, preflight, and fallback wording
  come from delivery-policy.instructions.md, the dispatched command's procedure from
  its own files.

## Examples

- Build worktree, roadmap `status: in-progress` → `next.invocation`
  `/agento build-feature <slug>`, `window: here`: the Builder resumes in this window
  from `dispatch.prompt` + `dispatch.agent`.
- Build worktree, `status: in-review`, fresh `Verdict: approve` → `/agento ship <slug>`,
  `window: primary`: open the primary window and name the command in its own block
  (§12); `ship` audits this worktree first and tears it down after the merge.
- Primary window, one delivery in flight → `/agento start-session <type>/<slug> --resume`,
  `then: /agento continue <slug>`: reopen its worktree window; the result's `next:` is
  the `then`.
- Primary window, no delivery but one ready initiative member → `/agento start-session`
  (plan mode), `then: /agento continue <member>`: the plan window then derives
  `/agento new-feature initiative:<initiative>/<member>`.
- Primary window, two or more candidates → `status: ambiguous`: rejection listing
  `/agento continue <slug>` for each.
