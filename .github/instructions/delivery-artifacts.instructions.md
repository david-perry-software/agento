---
description: "Format contract for delivery artifacts (plan.md, roadmap.md, review.md) and initiative artifacts (brief.md, breakdown.md) in the artifact roots configured by .github/agento.json (default: features/, issues/, and initiatives/)"
applyTo: "features/**,issues/**,initiatives/**"
---

Delivery artifacts are machine-resumed state. Keep these formats exactly; do not invent
new fields, statuses, or checkbox syntax. If the target repository moves the artifact
roots via `.github/agento.json` `artifacts`, copy this file into that repository's own
`.github/instructions/` with a matching `applyTo` so it keeps loading.

Each delivery record has an immutable creation-month directory:
`<features-root>/YYYY/MM/<slug>/` or `<issues-root>/YYYY/MM/<slug>/` (roots default to
`features/` and `issues/`). New records use the year and zero-padded month when
planning begins. Branch names stay `<feature-prefix><slug>` and `<issue-prefix><slug>`
(prefixes default to `feature/` and `issue/`), independent of the artifact path.

Initiatives — briefs decomposed into independently shippable features — live in
`<initiatives-root>/YYYY/MM/<slug>/` (root defaults to `initiatives/`) as `brief.md` +
`breakdown.md`. An initiative has no branch of its own; its progress is derived by
`agento.mjs initiative [<slug>]` from the member features' roadmaps.

# plan.md

Required sections, in order:

1. `# <Title>` — one line
2. `## Problem` — what and why, user-visible effect
3. `## Evidence` (issues only) — verified reproduction steps, observed vs expected
   behavior, and captured proof (logs, error output, screenshots). Store binary
   evidence such as screenshots under the issue's `evidence/` directory and link it here.
   Include the GitHub issue reference as `GitHub issue: #<number>`.
4. `## Decisions` — clarifying questions asked and the user's answers
5. `## Research` — findings; must include a `Skills consulted:` line listing the
   installed skills used (or `none — no matching domain`)
6. `## Approach` — technical design; affected packages/files
7. `## Risks` — with mitigations
8. `## Out of scope`
9. `## Acceptance checklist` — testable definition-of-done statements, each as
   `- [ ] <statement>` with a concrete verification method; the Reviewer scores these.
   For issues, the first item must be: the exposing regression test (named by file
   path) fails before the fix and passes after it.
10. `## Resolution` (issues only, written by the Builder at completion) — root cause,
    what changed and why, and proof the exposing test now passes.

`## Research` records the full-repository lint baseline (command, exit status,
findings) and the overlap decision required by
[delivery-policy.instructions.md](delivery-policy.instructions.md) §5.

# roadmap.md

Starts with a fenced yaml block containing exactly these fields:

```yaml
status: planned        # planned | in-progress | paused | in-review | complete
branch: feature/<slug> # or issue/<slug> (with the configured branch prefixes)
last-updated: YYYY-MM-DD
next-step: "<free-text pointer to the next unchecked step, or ''"
github-issue: "#<number>"  # issues only; omit for features
initiative: "<initiative-slug>"  # features that belong to an initiative only; omit otherwise
```

The optional `initiative:` field names the breakdown the feature is a member of. The
CLI treats a member roadmap without it, or with a different slug, as invalid delivery
state for that initiative.

Then `## Phase N: <name>` sections containing steps:

- `- [ ] N.M <imperative step description> — verify: <command or observable check>`
- Steps must be small, independently verifiable, ordered.
- The `verify:` line of a user-visible or deployed-behavior step names its target:
  `local:<ports>`, `dev-stack`, or `preview: <reason>`. Which one applies is defined
  in [delivery-policy.instructions.md](delivery-policy.instructions.md) §2.
- `- [ ] N.M (manual) <exact action for the user> — verify: <check>` marks a step only
  the user can perform (policy §1). It is ticked only with a linked screenshot at
  `evidence/step-N-M-<short-name>.png` inside the slug directory and the completion
  date on the line (policy §3).
- `- [ ] N.M (manual, post-ship) <exact action> — verify: <check>` marks the
  post-ship exception (policy §4). It stays unticked through review and ship; /ship
  completes it via a `<post-ship-prefix><slug>` PR. plan.md `## Risks` must carry the
  justification and the user's acceptance.
- For issues, an early step (before any fix) must add the exposing regression test and
  verify that it FAILS, demonstrating the defect; a later step verifies it passes.
  The test's name or header comment must reference the issue (`#<number>`, slug) so
  the test traces back to its evidence.
- Tick a checkbox (`- [x]`) only after its verify command/check passes.
- Never delete steps; if a step becomes obsolete, mark it `- [x] N.M ~<text>~ (obsolete: <reason>)`.
- Add discovered work as new steps with a `(added <date>)` suffix.
- Code is truth: on resume, audit ticked boxes against the codebase and repair drift
  before continuing.

# review.md

Required sections, in order:

1. `# Review: <slug>` with a `Verdict: approve` or `Verdict: request-changes` line
2. `## Acceptance checklist results` — each plan.md checklist item scored pass/fail with evidence
3. `## Plan vs implementation` — gaps, deviations, undocumented changes
4. `## Roadmap audit` — falsely ticked boxes, missing steps added, repairs made
5. `## Findings` — code quality/security issues, ordered by severity, with file references
6. `## Follow-ups` — work items that should become new issues. When a follow-up is
   triaged into the backlog (via /triage-followups), its line gains a
   ` → filed as #<n>` suffix; annotated lines are never re-filed.

# brief.md

The initiative's intake text, kept verbatim so the decomposition can be re-derived
later. First line: `Source: <argument|file path> — <YYYY-MM-DD>` (where the text came
from and when it was captured), then a blank line, then the text exactly as received.

# breakdown.md

Starts with a fenced yaml block containing exactly these fields:

```yaml
initiative: <slug>
created: YYYY-MM-DD
last-updated: YYYY-MM-DD
```

Then, in order:

1. `# <Title>` — one line
2. `## Goal` — what the initiative delivers as a whole, user-visible effect
3. `## Decisions` — clarifying questions asked and the user's answers
4. `## Research` — findings; must include a `Skills consulted:` line
5. `## Features` — one `### <feature-slug>` block per member feature (slugs match
   `[a-z0-9][a-z0-9-]{1,63}` and are unique within the file), each with exactly these
   bullets:
   - `- Summary:` one line
   - `- Brief:` the part of the intake text this feature covers
   - `- Requires: <feature-slug>[, <feature-slug>…]|none` — hard dependencies that
     must be `status: complete` before this feature is ready
   - `- Recommended after: <feature-slug>[, …]|none` — soft ordering hints
   - `- Wave: <n>` — explicit delivery wave (1 = first)
   - `- Size: S|M|L`
   - `- Independence:` why the feature is shippable on its own
6. `## Recommended order` — waves with rationale; an optional mermaid graph
7. `## Risks` — with mitigations
8. `## Out of scope`
9. `## Definition of done` — when the initiative as a whole counts as delivered

No checkboxes: a breakdown never records progress. `agento.mjs initiative <slug>`
derives each member's state from its roadmap (`unplanned` when none exists, otherwise
the roadmap `status`), treats only `status: complete` as satisfying `Requires:`, and
validates the graph (unknown slugs, cycles, duplicate blocks, member roadmaps whose
`initiative:` header is absent or names another initiative).
