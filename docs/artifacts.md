# Delivery artifacts

Each planned unit of work gets an immutable creation-month directory in the
**companion repository** that `/agento agento-init` creates and clones as a sibling
of the product checkout (`../<repo>-docs`, named by `.github/agento.json`
`artifacts.repo.name`): `features/YYYY/MM/<slug>/` or `issues/YYYY/MM/<slug>/`
(roots are configurable). Projects initialised before the companion existed keep
the roots inside the product repository (`artifacts.repo` unset); once
`artifacts.repo` is set, any in-repo copies are ignored. A large brief that
decomposes into several features gets an initiative directory,
`initiatives/YYYY/MM/<slug>/`.

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
  the /agento ship epilogue lands them via a `post-ship/<slug>` branch.
- Issues must add an exposing regression test that **fails before** the fix and
  passes after; the test references the issue number.
- Never delete steps: strike obsolete ones, append discovered ones with
  `(added <date>)`.
- A feature joins an initiative only through the explicit Planner argument
  `/agento new-feature initiative:<initiative-slug>/<feature-slug>`; the Planner validates
  the member with `agento.mjs initiative <initiative-slug>` and hard-stops unless
  every `Requires:` member is `status: complete` (no override). A plain
  `/agento new-feature` never attaches by slug coincidence. `/agento next-feature
  <initiative-slug>` prints the commands for the recommended next member.

The exact contract — section order, YAML fields, checkbox syntax — is enforced by
`.github/instructions/delivery-artifacts.instructions.md`, which loads for every
file under the artifact roots. `/agento agento-init` copies it into the companion
repository as `.github/instructions/agento.instructions.md` (frontmatter from
`templates/project.instructions.md`, `applyTo` matching your roots) so the contract
keeps applying when the companion folder is in the workspace.

## Freehand work

`/agento start-freehand <slug>` creates a `changes/<slug>` worktree with **no artifacts** —
for small ad-hoc work. `/agento finish-freehand` commits, PRs, and merges it.
