---
description: "Harvest un-triaged follow-ups from shipped features/issues, file them as GitHub issues autonomously, and annotate the source artifacts"
argument-hint: "Slug to triage, or empty to scan all shipped work"
agent: "agent"
---

Needs: terminal, gh, network
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Triage delivery follow-ups into the GitHub backlog. This invocation authorizes filing
GitHub issues with `gh issue create`, commenting stale-code flags on open issues with
`gh issue comment` (step 6), and merging the single annotation PR described in step 5
through the ruleset. No clarifying questions — run autonomously end to end. Resolve
artifacts with the Agento CLI (`node <agento-root>/scripts/agento.mjs`; path in the
session context line `Agento CLI:`).

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row (already-annotated follow-up lines and already-flagged issues are
skipped). Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for triage-followups` and map
`fail`/`warn` per §10.
Window check per §11: requires role `any` (read-only / not window-sensitive).

**Companion mode** (`agento.mjs config` reports `artifactsRoot` different from
`root` — `artifacts.repo.name` or `.dir` set; the session record's `companion` is
`null` in the primary window and is not the trigger): the artifacts you harvest and
annotate live in the companion clone at `artifactsRoot` (`agento.mjs find`/`status`
already resolve them there), so the annotation branch, commit, PR, and merge in step
5 happen in that clone — `git -C <artifactsRoot>` for every git command and, for
`gh pr` commands, either `cd <artifactsRoot> && gh …` (the repository is inferred
from `origin`) or `--repo <companion-repo>` with `<companion-repo>` derived once via
`cd <artifactsRoot> && gh repo view --json nameWithOwner -q .nameWithOwner`; never
`artifacts.repo.name`, which is a directory basename, as the `--repo` value — while
the GitHub issues in steps 3 and 6 are still filed and flagged in the product
repository. The in-repo layout (`artifactsRoot` equal to `root`) keeps the
single-repo flow.

**Mode** — from the argument:
- **Slug given**: `agento.mjs find <slug>`; triage only when `status` is `ok`,
  otherwise report the `message` and stop.
- **Empty**: `agento.mjs status` lists every slug directory; triage all of them in
  one run.

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

2. **Classify** each remaining item as a defect (future `/agento new-issue`) or an
   enhancement (future `/agento new-feature`). Do not ask for confirmation.

3. **File** one GitHub issue per item with `gh issue create`:
   - Title: imperative summary of the follow-up.
   - Body: the follow-up text quoted verbatim; source link
    (the resolved repository-relative artifact path and the finding/step it
    references); why it
     was deferred; and an intake line — `Intake: /agento new-issue #<this issue>` for
     defects (that prompt imports GitHub issues by number) or
     `Intake: /agento new-feature <suggested description> — close this issue when planned`
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
   entirely — no branch, no PR. Companion mode: from the companion clone on its
   default branch synced with its origin, `git -C <artifactsRoot> switch -c
   chore/followup-triage-…`, commit and push there, `gh pr create --repo
   <companion-repo>`, wait with `scripts/wait-for-checks.sh pr <n> --repo
   <companion-repo>`, merge with `gh pr merge --repo <companion-repo>` (with
   `<companion-repo>` derived as above), and return the clone to its default branch
   clean.

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
