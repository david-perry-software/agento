## 5. Lint baseline gate

During planning, run the full-repository lint command from AGENTS.md and record its
command, exit status, and findings in plan.md `## Research` (the plan.md in the
artifact checkout — the companion half in companion mode; the lint itself always runs
in the product checkout). A red baseline is never silently waived:

- A finding that overlaps the delivery's files or behavior → cleanup is a prerequisite
  or explicitly in scope.
- All findings demonstrably pre-existing and unrelated → a **scoped gate** is
  permitted, and it must include all of: lint every changed or new lintable file; run
  each affected package/workspace lint that can pass independently; focused tests for
  the changed behavior; the affected package/workspace typecheck; a rerun of
  full-repository lint compared against the initial findings — only the documented
  pre-existing findings may remain. Changed-files-only lint is never sufficient.

Encode the choice in `## Research`, `## Approach`, `## Acceptance checklist`, and
roadmap `verify:` steps. Builders execute every component and record the comparison,
and reassess overlap whenever scope expands (new files, new behavior). Reviewers
compare a fresh final run against the recorded baseline and request changes for
incomplete scoped results, new or undocumented findings, or overlap without planned
cleanup. Applies to new plans and to steps added to active deliveries; never rewrite
historical artifacts solely to adopt it.

