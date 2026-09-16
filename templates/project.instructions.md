---
description: "Format contract for delivery artifacts (plan.md, roadmap.md, review.md) and initiative artifacts (brief.md, breakdown.md) in this repository's configured artifact roots"
applyTo: "features/**,issues/**,initiatives/**"
---

This repository holds Agento delivery artifacts. The full format contract ships with
the Agento plugin at `.github/instructions/delivery-artifacts.instructions.md`;
this local copy exists so the contract loads with the correct `applyTo` when the
artifact roots differ from the defaults or live in a companion checkout —
`/agento agento-init` writes it into the companion repository as
`.github/instructions/agento.instructions.md`. Keep the `applyTo` above in sync with
the product repository's `.github/agento.json` `artifacts.features` /
`artifacts.issues` / `artifacts.initiatives` and mirror the plugin's contract
verbatim below this frontmatter when copying.
