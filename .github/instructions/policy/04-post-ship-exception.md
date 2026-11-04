## 4. Post-ship exception

`- [ ] N.M (manual, post-ship) <action> — verify: <check>` is allowed only when preview
*and* faithful local verification are genuinely impossible or materially unfaithful,
plan.md `## Risks` states why, and the user explicitly accepted it during
clarification. A missing preview URL, convenience, or "wait for the normal release" is
not enough on its own.

Such steps stay unticked through build, review, and ship — they are not gaps.
Reviewers score acceptance items satisfiable only by that step as `deferred to
post-ship`, not fail; an unticked `(manual, post-ship)` step *without* the documented
justification is missing preview evidence and forces `request-changes`. /agento ship
completes valid exceptions after the merge in its epilogue, landing evidence + tick via
a `<post-ship-prefix><slug>` PR. Evidence rules are identical to §3.

