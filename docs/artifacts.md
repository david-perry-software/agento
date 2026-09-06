# Delivery artifacts

Each planned unit of work gets an immutable creation-month directory in the target
repository: `features/YYYY/MM/<slug>/` or `issues/YYYY/MM/<slug>/` (roots are
configurable in `.github/agento.json`). A large brief that decomposes into several
features gets an initiative directory, `initiatives/YYYY/MM/<slug>/`.

| File | Written by | Purpose |
|---|---|---|
| `plan.md` | Planner | Problem, evidence (issues), decisions, research (incl. skills consulted), approach, risks, acceptance checklist |
| `roadmap.md` | Planner, then Builder | The resumable state machine: YAML header (`status`, `branch`, `last-updated`, `next-step`, optional `github-issue`, optional `initiative`) + checkbox steps with `verify:` lines |
| `review.md` | Reviewer | Verdict (`approve` / `request-changes`), checklist scoring, roadmap audit, findings, follow-ups |
| `evidence/` | Builder / user | Screenshots and logs; `step-N-M-<name>.png` for `(manual)` steps |
| `brief.md` | 🏛️ Architect | The verbatim intake text under a one-line `Source: <argument\|file path> — <date>` header |
| `breakdown.md` | 🏛️ Architect | YAML header (`initiative`, `created`, `last-updated`) + `## Features` blocks (`### <feature-slug>` with `Requires`, `Recommended after`, `Wave`, `Size`, …), recommended order, risks, definition of done. **No checkboxes**: `agento.mjs initiative <slug>` derives progress from the member roadmaps, whose `initiative:` header must name this initiative |

Key rules:

- The roadmap is the only durable progress record. Builders commit the roadmap tick
  **in the same commit** as the step's code.
- `- [ ]` ticks only after the step's verify check passes. On resume, ticked boxes
  are audited against the codebase — code is truth.
- `(manual)` steps need the user; `(manual, post-ship)` steps stay unticked until
  the /ship epilogue lands them via a `post-ship/<slug>` branch.
- Issues must add an exposing regression test that **fails before** the fix and
  passes after; the test references the issue number.
- Never delete steps: strike obsolete ones, append discovered ones with
  `(added <date>)`.
- A feature joins an initiative only through the explicit Planner argument
  `/new-feature initiative:<initiative-slug>/<feature-slug>`; the Planner validates
  the member with `agento.mjs initiative <initiative-slug>` and hard-stops unless
  every `Requires:` member is `status: complete` (no override). A plain
  `/new-feature` never attaches by slug coincidence. `/next-feature
  <initiative-slug>` prints the commands for the recommended next member.

The exact contract — section order, YAML fields, checkbox syntax — is enforced by
`.github/instructions/delivery-artifacts.instructions.md`, which loads for every
file under the artifact roots. If you customize the roots, copy
`templates/project.instructions.md` into your repo (done automatically by
`/agento-init`) so the contract keeps applying.

## Freehand work

`/start-freehand <slug>` creates a `changes/<slug>` worktree with **no artifacts** —
for small ad-hoc work. `/finish-freehand` commits, PRs, and merges it.
