---
description: "Use when verifying a delivery branch or when two or more delivery sessions may run at once: local-first verification on per-slug resources, when a deployed preview is genuinely required, sharing backing resources safely, and integrating the default branch continuously so /agento ship never hits merge conflicts — pointer for the companion repository"
applyTo: "features/**,issues/**"
---

This repository holds Agento delivery artifacts; the concurrent-delivery policy that
governs them ships with the Agento plugin. Before verifying a delivery branch or
integrating the default branch, read
`<agento-root>/.github/instructions/concurrent-delivery.instructions.md` and follow
it. `<agento-root>` is the plugin root named by the session context line
`Agento CLI: node <agento-root>/scripts/agento.mjs`.

`/agento agento-init` writes this pointer into the companion repository as
`.github/instructions/agento-concurrency.instructions.md`. Keep the `applyTo` above
in sync with the product repository's `.github/agento.json` `artifacts.features` /
`artifacts.issues`. It is a pointer, not a copy: never paste the policy here.
