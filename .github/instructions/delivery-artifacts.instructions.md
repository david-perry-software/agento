---
description: "Format contract for delivery artifacts (plan.md, roadmap.md, review.md) in the artifact roots configured by .github/agento.json (default: features/ and issues/)"
applyTo: "features/**,issues/**"
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

## Lint baseline policy

Every new feature or issue plan must run the full-repository lint command (documented
in the project's AGENTS.md) during research and record the command, exit status, and
failing findings. The Planner must assess whether each finding overlaps the files or
behavior in scope. A red baseline is never silently waived.

- If a baseline finding overlaps the delivery, the plan must make cleanup a
   prerequisite or include the cleanup explicitly in scope.
- If all baseline findings are demonstrably pre-existing and unrelated, the plan may
   use a scoped gate. That gate must lint every changed or newly created lintable file,
   run the affected package or workspace lint command when it can pass independently,
   run focused tests for changed behavior, run the affected package or workspace
   typecheck, and finish by rerunning full-repository lint. The plan must compare the
   initial and final findings and permit only the documented pre-existing, unrelated
   findings; changed-files-only lint is insufficient.

Encode the selected strategy in the plan's research, approach, acceptance checklist,
and roadmap verification steps. This policy applies to newly created plans and to
future steps added to an active delivery. Do not rewrite historical delivery artifacts
solely to adopt it. If scope changes, reassess whether baseline findings now overlap.

# roadmap.md

Starts with a fenced yaml block containing exactly these fields:

```yaml
status: planned        # planned | in-progress | paused | in-review | complete
branch: feature/<slug> # or issue/<slug> (with the configured branch prefixes)
last-updated: YYYY-MM-DD
next-step: "<free-text pointer to the next unchecked step, or ''"
github-issue: "#<number>"  # issues only; omit for features
```

Then `## Phase N: <name>` sections containing steps:

- `- [ ] N.M <imperative step description> — verify: <command or observable check>`
- Steps must be small, independently verifiable, ordered.
- Steps only a human can perform (external dashboards, account/vault setup, approvals,
  physical actions) are marked with `(manual)` after the step number:
  `- [ ] N.M (manual) <exact action for the user> — verify: <check>`. A `(manual)`
  step may be ticked only after the user confirms completion and provides a screenshot,
  stored as `evidence/step-N-M-<short-name>.png` inside the slug directory (features
  and issues alike) and linked from the step line. Anything executable through an
  available CLI (gh, git, and the project's CLIs declared in AGENTS.md) or verifiable
  by an agent driving a browser (loading a URL, clicking through a flow, asserting
  rendered state, capturing a screenshot) is never `(manual)` — the agent runs it
  itself per the self-reliance rule in the target repository's AGENTS.md.
- User-visible and deployed-behavior checks run before review against a **locally
   served branch by default** (per-slug ports or the project's documented full local
   stack for auth/DB-backed flows) — no platform allowlist edits are needed there.
  Name the target in the `verify:` line (`local:<ports>`, `dev-stack`, or
  `preview: <reason>`). Use an isolated deployment preview only when the behavior
  depends on the deployed platform itself (build/env wiring, edge/middleware,
  backend-integration, or the release path) and say why on the step; see
  [concurrent-delivery.instructions.md](concurrent-delivery.instructions.md).
  Either way the agent drives the target in the browser and collects the resulting
  screenshots under `evidence/` on the work branch. Such a check is `(manual)` only
  when it needs the user — human credentials, an approval, or a dashboard the agent
  cannot reach.
- Manual steps whose verification genuinely cannot run against a branch preview or
  faithful local environment are marked `(manual, post-ship)`:
  `- [ ] N.M (manual, post-ship) <exact action> — verify: <check>`. They are expected
  to remain unticked through review and ship — they are not gaps. /ship completes them
  after the merge in its post-ship verification epilogue and lands the evidence + tick
  via a short-lived `<post-ship-prefix><slug>` branch and PR. Evidence rules are
  identical to `(manual)` steps. The plan's `## Risks` must state why pre-merge
  preview verification is unavailable or materially unfaithful. Convenience, a missing
  preview URL, or waiting for the normal release is not enough by itself; the plan must
  include preview-enablement work or ask the user to explicitly accept the post-ship
  exception.
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
