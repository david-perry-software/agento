## 3. Manual steps and evidence

Syntax: `- [ ] N.M (manual) <exact user action> — verify: <check>`. When the Builder
reaches one — or discovers one mid-step, in which case it is first added as
`(manual) … (added <date>)`:

1. **Stop and instruct**: numbered actions with precise names, URLs, and values; never
   ask for secret values in chat.
2. **Collect proof**: the user confirms completion and attaches a screenshot.
3. **Document**: save it as `evidence/step-<N-M>-<short-name>.png` inside the slug
   directory, link it from the step line, note the completion date on that line.
   The slug directory is in the artifact checkout: this worktree in the in-repo
   layout, the companion half (`companion.path` in the session record, on the
   mirrored branch) in companion mode — evidence never lands in the product half
   there.
4. **Verify and advance**: run the machine-checkable part of `verify:`, tick, commit
   evidence + roadmap together (one companion commit in companion mode), push,
   continue.
5. If the user cannot act now: pause protocol, with the manual step named in
   `next-step`.

A ticked `(manual)` step without a linked evidence file is a falsely ticked box.
Browser-driven checks the agent performs itself also land their screenshots under
`evidence/` on the work branch.

**Pause kinds.** `status: paused` means exactly one thing: only the user can advance
the roadmap — a `(manual)` step has been reached, or a blocker only the user can
clear (an auth failure, a missing prerequisite, a decision). Its `next-step` names
the step and carries the reason as a marker: `"<N.M> (manual) <action>"` for a manual
step, `"<N.M> blocked: <reason>"` for a blocker. Stopping for any other reason —
session length, token budget, a clean phase boundary, the user saying "pause" with
nothing outstanding — is a **session break**, not a pause: the in-flight step is
finished or reverted, everything is committed and pushed, `status` stays
`in-progress`, and `next-step` names the next unticked step. A session break needs
nobody: `/agento build-<type> <slug>`, `/agento ap <slug>`, and `/agento continue`
all resume it through the Builder's resume protocol, and the Autopilot never stops
on one. A `paused` roadmap whose `next-step` carries neither marker predates this
rule and is read as a session break.

