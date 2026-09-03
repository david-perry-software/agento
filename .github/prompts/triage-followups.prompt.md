---
description: "Harvest un-triaged follow-ups from shipped features/issues, file them as GitHub issues autonomously, and annotate the source artifacts"
argument-hint: "Slug to triage, or empty to scan all shipped work"
agent: "📋 Agento Planner"
---

Triage delivery follow-ups into the GitHub backlog. This invocation authorizes filing
GitHub issues with `gh issue create`, commenting stale-code flags on open issues with
`gh issue comment` (step 6), and merging the single annotation PR described in step 5
through the ruleset. No clarifying questions — run autonomously end to end.

**Mode** — from the argument:
- **Slug given**: recursively resolve an exact slug parent below `features/` and
  `issues/`, triaging it only when exactly one directory matches; otherwise report
  every conflicting path and stop.
- **Empty**: recursively scan every slug directory containing a roadmap below
  `features/` and `issues/` for un-triaged follow-ups and triage them all in one run.

1. **Harvest.** For each slug in scope, collect bullet items from:
   - review.md `## Follow-ups` — current review only; ignore superseded reviews below
     a `---` separator.
   - roadmap.md `## Follow-ups` and `## Follow-ups (accepted at ship)`.

   Skip items that are: "None"-type entries; already annotated `→ filed as #<n>`;
  already covered by an existing slug (recursively search plan.md files below
  `features/` and `issues/` for references to the follow-up) or an existing GitHub issue
   (`gh issue list --search "<key phrase>" --state all`); or referencing code that no
   longer exists on `main` (verify the file paths/symbols named in the item) — skip
   these as **stale** rather than filing them. Record every skip with its reason for
   the final report.

2. **Classify** each remaining item as a defect (future `/new-issue`) or an
   enhancement (future `/new-feature`). Do not ask for confirmation.

3. **File** one GitHub issue per item with `gh issue create`:
   - Title: imperative summary of the follow-up.
   - Body: the follow-up text quoted verbatim; source link
    (the resolved repository-relative artifact path and the finding/step it
    references); why it
     was deferred; and an intake line — `Intake: /new-issue #<this issue>` for
     defects (that prompt imports GitHub issues by number) or
     `Intake: /new-feature <suggested description> — close this issue when planned`
     for enhancements.
   - Never include secrets, tokens, or internal URLs in issue bodies.

4. **Annotate** each filed item's source line in place with ` → filed as #<n>` so
   re-runs skip it. Do not otherwise reword or reorder artifact content.

5. **Publish the annotations.** From `main` synced with `origin/main`, create
   `chore/followup-triage-<slug>` (slug mode) or `chore/followup-triage-<YYYY-MM-DD>`
   (scan mode), commit only the annotated artifacts
   (`docs(delivery): triage follow-ups ...`), push with upstream, open a PR to `main`,
   merge it through the ruleset once required checks pass (normal merge commit, no
   bypass), delete the branch, and sync `main`. If nothing was filed, skip this step
   entirely — no branch, no PR.

6. **Reconcile the open backlog against the codebase** (code is truth; scan mode
   only — skip in slug mode). For every open GitHub issue whose body carries a
   `Source:` line or an `Intake:` line (i.e. previously triage-filed or
   delivery-filed issues):
   - Extract the file paths and code symbols the issue references (backtick paths,
     source links, named exports); check they still exist on synced `main`
     (`git ls-files`, grep for symbols).
   - If the referenced code is gone, do NOT close the issue — an issue's intent can
     outlive its file paths. Comment once:
     `Stale-code flag (triage <YYYY-MM-DD>): the referenced code no longer exists on
     main (<what is missing, and the removing PR/commit if identifiable>). Close if
     the intent no longer applies, or re-anchor the issue to the current code.`
   - Idempotency: skip issues that already have a `Stale-code flag` comment. Never
     comment on issues that reference no code at all (process/ops items).
   - Record every flagged issue in the final report.

7. **Report** a table of follow-ups → issue number + classification, the skipped
   items with reasons, stale-code flags posted (issue → missing reference), and the
   annotation PR number.
