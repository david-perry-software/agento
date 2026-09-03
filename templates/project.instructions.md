---
description: "Format contract for delivery artifacts (plan.md, roadmap.md, review.md) in this repository's configured artifact roots"
applyTo: "features/**,issues/**"
---

This repository uses Agento delivery artifacts. The full format contract ships with
the Agento plugin at `.github/instructions/delivery-artifacts.instructions.md`;
this local copy exists so the contract loads with the correct `applyTo` when the
artifact roots differ from the defaults. Keep the `applyTo` above in sync with
`.github/agento.json` `artifacts.features` / `artifacts.issues` and mirror the
plugin's contract verbatim below this frontmatter when copying.
