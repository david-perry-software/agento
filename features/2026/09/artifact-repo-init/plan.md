# Artifact repository init: `/agento agento-init` creates and clones the companion repo

## Problem

`/agento agento-init` scaffolds the artifact roots (`features/`, `issues/`,
`initiatives/`) inside the product repository
([agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md) step 3)
and leaves `artifacts.repo` at its nulls (step 2 snippet), so the companion-repo
layout that `artifact-repo-config` taught the CLI to read is something a user can
only set up by hand: create a GitHub repository, clone it as a sibling, add the
roots, protect its default branch, edit `.github/agento.json`. This feature is the
wave‑2 member **`artifact-repo-init`** of the initiative
[external-artifact-repo](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md)
(`### artifact-repo-init` block): init asks for the companion name (default
`<repo>-docs`), creates the GitHub repository with the same owner and visibility as
the product repo, clones it to `../<name>`, scaffolds the three artifact roots, a
README, and the artifact-format instruction file there, protects its default branch
with the same ruleset init already offers for the product repo, and writes
`artifacts.repo.name` into the product's `.github/agento.json`. The product repo no
longer receives artifact roots. The run ends with `agento.mjs doctor` reporting
`artifact-repo` `ok`, so a freshly initialised project is immediately readable by
every CLI subcommand that `artifact-repo-config` routed through the companion.

User-visible effect: after `/agento agento-init` a target project has a sibling
`../<repo>-docs` checkout (and GitHub repository) holding `features/`, `issues/`,
`initiatives/`; its `.github/agento.json` names it; `agento.mjs config` reports the
companion as `artifactsRoot`; `doctor` is green. Re-running init adopts the existing
companion instead of recreating anything.

## Decisions

The ask-questions tool was unavailable in this session; questions were asked as a
numbered list in chat (policy §10 fallback). Answers verbatim.

- **Q1: Companion mandatory or optional?** When `/agento agento-init` runs on a
  fresh target repo, should it *always* create a companion repo (asking only for the
  name, default `<repo>-docs`), or offer an opt-out (e.g. answering `none` keeps
  today's in-repo layout with `artifacts.repo` unset)?
  A: "always create a companion repo"
- **Q2: Companion bootstrap commit.** The companion needs an initial commit (README +
  `.gitkeep` in each artifact root) on its default branch *before* the
  `pull_request`/`non_fast_forward`/`deletion` ruleset is applied, otherwise the
  ruleset blocks it. Is a direct push of that single bootstrap commit to the
  companion's default branch acceptable (mirroring AGENTS.md's "first push of `main`"
  bootstrap exception), or must init open and merge a PR in the companion for it?
  A: "That's acceptable if easier and faster"
- **Q3: Where does the artifact instructions file go?** Today
  `templates/project.instructions.md` is copied into the *product* repo only when
  roots are customized. With a companion, should init always copy it into the
  companion's `.github/instructions/agento.instructions.md` (so the artifact-format
  contract loads when the companion folder is in the workspace), and should init also
  write a `<repo>.code-workspace` file in the product repo listing both folders for
  the primary window — or leave the workspace file to `paired-artifact-worktrees`?
  A: "We want to keep everything in the companion not effecting the product if
  possible"
- **Q4: End-to-end verification.** Prompt changes are only truly testable by running
  init. May the Builder/Reviewer create throwaway GitHub repositories under your
  account (a scratch product repo plus its `-docs` companion) to drive
  `/agento agento-init` for real, and delete them afterwards (`gh repo delete` needs
  the `delete_repo` scope — you would grant it, or delete them yourself as a
  `(manual)` step)? Or should verification stop at `tests/customizations.test.mjs`
  plus a dry-run against a local bare remote without GitHub?
  A: "You can make them, ill delete them later"
- **Q5: Repo creation details.** Confirm: `gh repo create <owner>/<name>` with the
  *same owner and visibility* as the product repo, no description prompt, and
  `--force` on re-run still only rewrites files (never re-creates or resets the
  companion repo/clone). Anything to add — e.g. a companion description, a LICENSE
  copy, or a `.github/agento.json` inside the companion?
  A: "defaults"

Planner's derived decisions (recorded so the Builder does not re-decide them):

- **Companion name.** Asked once with the ask-questions tool (or its §10 fallback),
  default `<repo>-docs` where `<repo>` is the product's GitHub repository name;
  validated against `^[A-Za-z0-9_.-]{1,100}$` and required to differ from the
  product repository name. The owner is the product repo's owner
  (`gh repo view --json nameWithOwner,visibility`); visibility maps `PUBLIC` →
  `--public`, `PRIVATE` → `--private`, `INTERNAL` → `--internal`. Description is
  fixed text: `Agento delivery artifacts for <owner>/<repo>` (Q5 "defaults" — no
  prompt for it).
- **Adopt, never recreate.** `gh repo view <owner>/<name>` succeeding means the
  repository exists and is adopted; `../<name>` existing means the clone is adopted
  when it is a git toplevel whose `origin` URL points at `<owner>/<name>` (any other
  content at that path is a hard stop naming the conflict). An adopted remote whose
  default branch already has commits is accepted only if it is empty of files or
  already carries the Agento companion marker (the README's first line, see the
  template below); an unrelated repository that happens to be named `<repo>-docs`
  stops the command and asks for a different name rather than being written into.
  `--force` rewrites scaffold files in both repos and never deletes, resets, or
  recreates a repository or clone.
- **Bootstrap versus PR in the companion.** Companion with no `origin/<default>`
  (freshly created or adopted-empty) → one Conventional Commit on `<default>` pushed
  directly with `-u` (Q2; the only direct push to a default branch Agento ever
  performs, and only before the ruleset exists). Companion whose `origin/<default>`
  already exists → the missing scaffold files are committed on
  `changes/agento-init` in the companion and published as a PR there; nothing is
  pushed to its default branch.
  *Builder amendment (added 2026-09-16):* the delivery guard is `git -C`-aware and
  denied `git -C <companion> push -u origin main` during the smoke ("Direct
  commits/pushes to main are forbidden"), so the direct push is not executable by
  any agent running under the guard. The bootstrap keeps Q2's shape — scaffold files
  land on the companion's default branch before the ruleset, with no PR — but is
  written through the GitHub Contents API (`gh api -X PUT repos/<owner>/<name>/contents/<path>`,
  one commit per file, README first so the empty repository is initialised). No
  `git push` to a default branch remains anywhere in init, so `artifact-repo-hooks`
  needs no guard exemption for it.
- **Companion ruleset.** For a companion this run *created*, init creates the ruleset
  immediately after the bootstrap push without a second question — the user asked
  for the companion by naming it, and an unprotected default branch is what the
  ruleset step exists to prevent: `pull_request`, `non_fast_forward`, `deletion`;
  **no** `required_status_checks` (the companion has no CI). For an *adopted*
  companion, init runs the same check-then-ask that today's step 7 runs for the
  product repo. A `403`/`422` from the rulesets API (missing admin scope, or a
  private repository on a plan without rulesets) is recorded as a gap in the report,
  exactly like today's product-repo path.
- **Companion contents (Q3, Q5).** `README.md` from a new
  `templates/companion-README.md` (first line is the marker
  `<!-- agento-companion: <owner>/<repo> -->`, then a short explanation and the
  product repo link), `<features>/.gitkeep`, `<issues>/.gitkeep`,
  `<initiatives>/.gitkeep` using the product config's root names, and
  `.github/instructions/agento.instructions.md` = the frontmatter of
  `templates/project.instructions.md` (its `applyTo` rewritten to the configured
  roots when they differ from the defaults) followed by the verbatim body of the
  plugin's `delivery-artifacts.instructions.md`. Nothing else: no LICENSE, no
  `.github/agento.json`, no workflows, no `.code-workspace` file (Q3 — the
  multi-root workspace mechanics belong to `paired-artifact-worktrees`; init's
  report reminds the user to add the companion folder to the workspace as
  [docs/project-profile.md](../../../../docs/project-profile.md) already documents).
- **Product contents.** `.github/agento.json` with `"repo": { "name": "<name>",
  "dir": null }`, the `## Agento` AGENTS.md section (template updated to name the
  companion), and `scripts/wait-for-checks.sh`. No `features/`, `issues/`, or
  `initiatives/` directories; no `.github/instructions/agento.instructions.md` in
  the product (the contract now travels with the companion). Product ruleset check
  (today's step 7) is unchanged.
- **Self-check.** Before committing the product scaffold, the prompt runs `node
  <agento-root>/scripts/agento.mjs doctor` from the product root and requires the
  `artifact-repo` check to be `ok` (not `warn`, not `fail`); a `warn` for stale
  in-repo roots on a repo that already had them is reported, not fixed (migration
  is wave 5).
- **Where init runs.** From the primary checkout of the product repo:
  `resolveArtifactsRoot()` resolves `../<name>` against the primary checkout
  ([scripts/agento-config.mjs](../../../../scripts/agento-config.mjs) L55–61), so a
  clone made from inside a managed worktree would land in the worktrees directory.
  The prompt states this in step 1.
- **No CLI change.** `COMMAND_NEEDS["agento-init"]` stays `terminal, ask-questions,
  gh, network` ([scripts/agento.mjs](../../../../scripts/agento.mjs) L366) and the
  `Needs:` line is unchanged, so `doctor --for agento-init` and
  `tests/customizations.test.mjs` keep agreeing without code edits.
- **Throwaway repositories for verification (Q4).** The Builder creates a public
  scratch product repo `agento-smoke-init-<YYYYMMDD>` under the product repo's owner
  (public so rulesets are available on the Free plan), clones it and drives every
  step of the rewritten prompt against it exactly as the default agent would, and
  the Reviewer re-drives the idempotent second pass (and, at its discretion, a fresh
  first pass on `agento-smoke-init-<YYYYMMDD>-r`). The repositories are **not**
  deleted by the agents; their names are recorded in roadmap.md `## Follow-ups` for
  the user to delete (Q4).

## Research

Skills consulted: none — no matching domain (the repository has no
`.agents/skills/` directory — `ls -d .agents/skills` returned nothing — and its
AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `fc380e8`:

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests
  153`, `# pass 153`, `# fail 0`.
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.

The baseline is green, so there is no overlap decision and no scoped gate: the
Builder reruns the **full** baseline (all three commands) at every step's `verify:`
that touches guidance or templates, and the Reviewer compares a fresh run against
`153 pass / 0 fail`, shellcheck silent, guard exit 0. Reminder from the previous
member: the delivery guard denies shell redirects naming `scripts/hooks/*`; run
shellcheck without output redirection.

### Concurrent deliveries

`gh pr list --state open --json number,headRefName` → `[]`. No open delivery PRs at
planning time; nothing to sequence after.

### Codebase findings (file:line as of `fc380e8`)

- **The prompt to rewrite.**
  [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md):
  frontmatter L1–4 (`description` names "features/, issues/, and initiatives/
  directories"); `Needs:` L6–8; §9/§10/§11 lines L14–19; steps: 1 clone check
  L23–24, 2 config snippet with `"repo": { "name": null, "dir": null }` L26–52,
  3 artifact roots with `.gitkeep` L54–55, 4 AGENTS section (inline copy of the
  template, "Artifacts live in `features/YYYY/MM/<slug>/` …" L64–66) L57–99,
  5 `wait-for-checks.sh` L101–107, 6 copy `project.instructions.md` only for custom
  roots L109–113, 7 ruleset check-and-ask (`gh api … rulesets`, rules
  `pull_request`, `required_status_checks`, `non_fast_forward`, `deletion`) L115–128,
  8 commit on `changes/agento-init`, PR, report L130–144.
  [commands/agento-init.md](../../../../commands/agento-init.md) is the
  byte-identical plugin copy (test "plugin manifest uses suffix-less command names…"
  in [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs)
  L389–410 `assert.equal` on file contents).
- **CLI already understands the result.**
  [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs) L55–61
  `resolveArtifactsRoot()`: non-null `name` → `dir = <primaryRoot>/../<name>`.
  [scripts/agento.mjs](../../../../scripts/agento.mjs) L84–104 `resolveArtifacts()`
  reads the primary checkout's config; L305–326 the `doctor` `artifact-repo` check
  fails when `dir` is absent, not a toplevel, has no `origin`, or lacks
  `origin/<default>`/`<default>`, and warns naming stale in-repo roots; its fallback
  text (L308) already says "run `/agento agento-init` to create and clone the
  companion repository" — this feature makes that sentence true. `CAPABILITY_CHECKS`
  L354 puts it under `terminal`; `COMMAND_NEEDS["agento-init"]` L366 is `terminal,
  ask-questions, gh, network`.
- **Templates.** [templates/AGENTS-section.md](../../../../templates/AGENTS-section.md)
  L8–10 "Artifacts live in `features/YYYY/MM/<slug>/`, `issues/YYYY/MM/<slug>/`, and
  `initiatives/YYYY/MM/<slug>/`; configuration is `.github/agento.json`." — the same
  text is inlined in the prompt's step 4 (both must change together).
  [templates/project.instructions.md](../../../../templates/project.instructions.md)
  L1–12: frontmatter `applyTo: "features/**,issues/**,initiatives/**"` and a body
  saying it exists "when the artifact roots differ from the defaults" and to "mirror
  the plugin's contract verbatim below this frontmatter when copying".
  [templates/agento.json](../../../../templates/agento.json) ships `repo` nulls and
  is loaded by `scripts/agento-config.test.mjs` — unchanged by this feature.
- **Guidance tests that constrain the edits**
  ([tests/customizations.test.mjs](../../../../tests/customizations.test.mjs)):
  `guidanceFiles` L314–323 includes README, AGENTS.md, agents, prompts,
  instructions, `commands/*.md`, `docs/*.md`, `templates/*.md` — every command must
  be written `/agento <name>` (L325–335) with no `.prompt`/`.md` suffix (L337–352);
  the canary list (L270–289) forbids restating policy §9/§10 phrases outside
  delivery-policy; every prompt is listed in README, `docs/commands.md`, and its
  `## Invocation` (L300–311); frontmatter `description` is required and `Needs:`
  must agree with `doctor --for`. A new `templates/companion-README.md` is picked up
  by `listFiles(rel("templates"), ".md")` automatically.
- **Docs that describe the in-repo scaffold.**
  [README.md](../../../../README.md) L127–141 (set-up table: row "`features/`,
  `issues/` | Artifact roots (with `.gitkeep`)" L135; ruleset sentence L138–140) and
  L381 (flow table row for `/agento agento-init`);
  [docs/install.md](../../../../docs/install.md) L57–59 ("scaffolds … `features/` +
  `issues/`") and L68–70 (ruleset);
  [docs/commands.md](../../../../docs/commands.md) L5 ("config, artifact dirs,
  AGENTS.md section, CI poller");
  [docs/project-profile.md](../../../../docs/project-profile.md) L32 ("copy
  `templates/project.instructions.md` (done by `/agento agento-init`)"), L34–35
  (`artifacts.repo.*` rows), L42–45 (workspace-folder note);
  [docs/artifacts.md](../../../../docs/artifacts.md) L3–8 ("in the target
  repository … when `artifacts.repo` is set they live in the sibling companion")
  and L39–42 (copy of `project.instructions.md` "done automatically by
  `/agento agento-init`");
  [docs/architecture.md](../../../../docs/architecture.md) L89–90 boundary table
  (already companion-aware; no change needed);
  [docs/hooks.md](../../../../docs/hooks.md) L28 (ruleset mention; unchanged).
- **Policy row.** [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md)
  L233: `| /agento agento-init | Existing files are kept unless --force. |` — the
  idempotency row gains the adopt-never-recreate clause.
- **CHANGELOG.** [CHANGELOG.md](../../../../CHANGELOG.md) L3–19: `## Unreleased`
  already carries the `artifact-repo-config` bullet; this feature adds a second
  bullet under the same heading. Versions are `0.4.1` in `package.json` and
  `.claude-plugin/plugin.json` (test "…versions differ" L405); no bump in this
  member (the initiative's migration member bumps for the layout change).
- **Previous member's follow-ups**
  ([artifact-repo-config/review.md](../artifact-repo-config/review.md) L160–168):
  none concern init; the "acceptance greps use JSON key spelling" convention is
  applied in this plan's checklist.
- **GitHub facts used by the prompt design** (from `gh` behaviour, not the repo):
  `gh repo create <owner>/<name> --public|--private|--internal --description <text>`
  creates an empty repository; the first branch pushed becomes its default branch,
  so pushing `<branches.default>` first makes it the default without an API call.
  `gh repo view <owner>/<name>` exits nonzero for a missing repository (adoption
  test). Branch rulesets need admin on the repository and, for private
  repositories, a paid plan — the prompt keeps today's "record the gap" path for a
  `403`/`422`.

## Approach

Prompt, template, and documentation change only — no CLI, hook, or test-runner code.

1. **Rewrite `/agento agento-init`** (`.github/prompts/agento-init.prompt.md`, mirrored
   byte-for-byte to `commands/agento-init.md`). Frontmatter `description`: "Scaffold
   Agento in the current project: create and clone the companion artifact repository
   (`<repo>-docs`), `.github/agento.json` pointing at it, an `## Agento` section in
   AGENTS.md, and `scripts/wait-for-checks.sh`". `Needs:`/`Fallback:`/§ lines
   unchanged. Steps become:
   1. Git repo, not the Agento clone, **and** the primary checkout (`agento.mjs
      session` → `worktree.isPrimary`), with `gh repo view --json
      nameWithOwner,visibility` recorded as `<owner>/<repo>` and `<visibility>`.
   2. Ask the companion name (default `<repo>-docs`; validation and "must differ"
      rule from Decisions).
   3. **Companion repository**: adopt if `gh repo view <owner>/<name>` succeeds,
      else `gh repo create <owner>/<name> --<visibility> --description "Agento
      delivery artifacts for <owner>/<repo>"`. Clone or adopt `../<name>` (relative
      to the product root) per Decisions; hard-stop wording for a foreign directory
      or an unrelated repository.
   4. **Companion scaffold**: README from `templates/companion-README.md`,
      `.gitkeep` in each configured root, `.github/instructions/agento.instructions.md`
      (template frontmatter with adjusted `applyTo` + verbatim plugin contract body).
      Empty companion → commit `chore: scaffold Agento artifact roots` on
      `<default>` and `git -C ../<name> push -u origin <default>`; non-empty →
      `changes/agento-init` branch + PR in the companion.
   5. **Companion ruleset**: created-this-run → create (`pull_request`,
      `non_fast_forward`, `deletion`; `~DEFAULT_BRANCH`); adopted → check-then-ask
      as for the product. Record the outcome.
   6. **Product config**: write `.github/agento.json` (today's snippet with `"repo":
      { "name": "<name>", "dir": null }`, `branches.default` per `git remote show
      origin`) — no artifact roots are created in the product repo. The explanatory
      sentence under the snippet says the companion is where the roots live.
   7. **AGENTS.md `## Agento`** from the updated template (companion sentence with
      `<owner>/<name>` and `../<name>` filled in); same keep-unless-`--force` rule.
   8. `scripts/wait-for-checks.sh` — today's step 5 verbatim.
   9. **Product ruleset** — today's step 7 verbatim.
   10. **Self-check**: `node <agento-root>/scripts/agento.mjs doctor` from the
       product root; `artifact-repo` must be `ok` (a `warn` naming stale roots is
       reported as pre-existing; any `fail` stops before the commit with the check's
       `fallback`).
   11. Commit on `changes/agento-init`, PR, report: companion `<owner>/<name>`, its
       URL and clone path, created versus adopted, bootstrap commit or companion PR
       number, both rulesets' status, files created/kept, the reminder to add
       `../<name>` as a workspace folder (*File → Add Folder to Workspace…*) until
       paired worktrees land, the next commands, and the plugin settings snippet.
   Every command keeps `/agento <name>` spelling; no §9/§10 phrases are restated.
2. **Templates.** `templates/AGENTS-section.md` L8–10 → "Artifacts live in the
   companion repository `<owner>/<companion>` cloned at `../<companion>` —
   `features/YYYY/MM/<slug>/`, `issues/YYYY/MM/<slug>/`, and
   `initiatives/YYYY/MM/<slug>/` there; configuration is this repository's
   `.github/agento.json`." (placeholders `<owner>`, `<companion>` filled by init; the
   prompt's inline copy in its AGENTS step must match). New
   `templates/companion-README.md`: marker comment line, one paragraph ("Delivery
   artifacts for `<owner>/<repo>`, written by the Agento plugin: plans, roadmaps,
   reviews, evidence, and initiative breakdowns. Do not edit by hand outside a
   delivery session; the format contract is `.github/instructions/agento.instructions.md`."),
   and the three root directories listed. `templates/project.instructions.md` body:
   add "or live in a companion checkout" to the reason it exists and name the
   companion path `.github/instructions/agento.instructions.md`; `applyTo`
   unchanged.
3. **Policy row.** `delivery-policy.instructions.md` §9 table, `/agento agento-init`
   row → "Existing files are kept unless `--force`; an existing companion repository
   or clone is adopted, never recreated or reset."
4. **Docs.** README set-up table rows (config row mentions `artifacts.repo.name`;
   replace the "`features/`, `issues/`" row with "`../<repo>-docs` companion
   repository (created on GitHub and cloned) | Artifact roots `features/`,
   `issues/`, `initiatives/` (with `.gitkeep`), README, artifact-format
   instructions") and the ruleset sentence ("…on both repositories"); README L381
   row text; `docs/install.md` L57–59 and L68–70; `docs/commands.md` L5;
   `docs/project-profile.md` L32 (copy target is the companion), L34 (`artifacts.repo.name`
   "set by `/agento agento-init`"), L42–45 (init's report reminds you);
   `docs/artifacts.md` L3–8 (companion is the normal home; in-repo only for projects
   initialised before it) and L39–42 (contract copy lives in the companion).
5. **CHANGELOG.** Second bullet under `## Unreleased`: "`/agento agento-init` creates
   and clones the companion repository…" naming the adopt rule, the bootstrap push,
   the companion ruleset, the templates, and that the product repo no longer gets
   artifact roots.
6. **End-to-end smoke (Q4).** In a temp directory: `gh repo create
   <owner>/agento-smoke-init-<YYYYMMDD> --public --clone`, initial commit pushed to
   `main`; then drive the rewritten prompt's steps literally from that checkout (the
   Builder is the agent the prompt addresses). Assertions: `gh repo view
   <owner>/agento-smoke-init-<YYYYMMDD>-docs` succeeds with `visibility: PUBLIC`;
   `git -C <tmp>/agento-smoke-init-<YYYYMMDD>-docs ls-tree -r --name-only origin/main`
   lists `README.md`, `features/.gitkeep`, `issues/.gitkeep`, `initiatives/.gitkeep`,
   `.github/instructions/agento.instructions.md`; `gh api
   repos/<owner>/<companion>/rulesets --jq '.[].name'` lists the ruleset; the
   product tree has `.github/agento.json` with `"name": "agento-smoke-init-<YYYYMMDD>-docs"`,
   `AGENTS.md` with the companion sentence, `scripts/wait-for-checks.sh`, and **no**
   `features/`, `issues/`, `initiatives/`; `node <agento-root>/scripts/agento.mjs
   doctor --root <tmp>/agento-smoke-init-<YYYYMMDD>` → exit 0, `artifact-repo`
   `ok`; `agento.mjs config --root …` → `artifactsRoot` is the companion path.
   Second pass (idempotency): rerun the steps; `gh repo view --json createdAt` on
   the companion is unchanged, `git -C <companion> rev-list --count origin/main` is
   unchanged, the report says the companion and files were kept. Trimmed outputs go
   to `evidence/step-3-1-init-smoke.md` and `evidence/step-3-2-init-rerun.md`.
   Throwaway repo names are recorded in roadmap.md `## Follow-ups` for the user.

Affected files: `.github/prompts/agento-init.prompt.md`, `commands/agento-init.md`,
`templates/AGENTS-section.md`, `templates/project.instructions.md`,
`templates/companion-README.md` (new),
`.github/instructions/delivery-policy.instructions.md` (one table row),
`README.md`, `docs/install.md`, `docs/commands.md`, `docs/project-profile.md`,
`docs/artifacts.md`, `CHANGELOG.md`, plus `features/2026/09/artifact-repo-init/evidence/*.md`.

## Risks

- **Adopting an unrelated repository named `<repo>-docs`.** A user may already have
  a real docs site under that name. Mitigation: adoption requires an empty default
  branch or the README marker line; otherwise init stops and asks for another
  name (Decisions). Verified in the smoke by the second pass reading the marker.
- **Direct push to the companion default branch.** The one bootstrap push (Q2) is a
  deliberate exception; it happens only when `origin/<default>` does not exist and
  before any ruleset. The delivery guard in the product window does not yet know
  the companion (`artifact-repo-hooks`), so nothing blocks it today; once the hooks
  land, the bootstrap push must remain allowed for an empty companion — recorded
  as a note for that member in roadmap.md `## Follow-ups`.
- **Rulesets unavailable** (private repository on the Free plan, or `gh` token
  without admin) → `403`/`422`. Mitigation: same "record the gap in the report"
  path as today's product step; the smoke uses a public repository. Never
  `--admin`, never retry with elevated scopes.
- **`gh repo create` under an organisation owner** may need `repo`/`admin:org`
  scopes or be forbidden by org policy. Mitigation: the prompt maps a nonzero
  `gh repo create` to a stop naming the exact failure and the manual alternative
  (create the repository in the GitHub UI, re-run init to adopt it); the product
  repo's owner in the smoke is a user account.
- **Prompt and template drift.** The AGENTS sentence lives in the template and
  inline in the prompt; the mirror test only checks `commands/` ↔ prompt.
  Mitigation: acceptance grep requires the same companion sentence in both files.
- **Editor cannot see the companion** (initiative risk). Mitigation: init's report
  prints the "add folder to workspace" reminder and links docs/project-profile.md;
  the workspace-file mechanics remain with `paired-artifact-worktrees` (Q3).
- **Projects initialised before this feature** keep in-repo roots and `repo` nulls;
  nothing in this member migrates them (wave 5). Docs say so explicitly.
- **Throwaway repositories linger** until the user deletes them (Q4). Mitigation:
  their exact names are listed in roadmap.md `## Follow-ups` and in the Builder's
  final report; the agents never run `gh repo delete`.
- **Concurrent delivery.** No open PRs at planning time. Mitigation regardless:
  integrate `origin/main` by merge before every push (policy §7).

## Out of scope

- Hooks reading `artifacts.repo`, protecting the companion default branch in the
  guard, or re-targeting the roadmap nudge (`artifact-repo-hooks`).
- Paired worktrees, `.code-workspace` files, `session.companion`
  (`paired-artifact-worktrees`).
- Writing delivery artifacts into the companion, mirrored branches, companion PRs
  for deliveries, dual merge (`mirrored-artifact-branches`, `ship-dual-merge`).
- `--migrate` / moving existing in-repo roots into a companion
  (`artifact-history-migration`); the `doctor` fallback that already names
  `/agento agento-init --migrate` is left as is.
- Any `scripts/*.mjs` or hook change; a plugin version bump; a companion
  `.github/agento.json`, LICENSE, or CI; non-sibling companion paths; hosted
  environments; an opt-out to keep the in-repo layout on a fresh init (Q1).
- Deleting the throwaway repositories (the user's, Q4).

## Acceptance checklist

- [ ] `.github/prompts/agento-init.prompt.md` creates the companion (`gh repo create`
  with the product's owner and visibility, or adopts an existing repository/clone
  with the marker rule), clones it to `../<name>`, scaffolds `README.md`, the three
  `.gitkeep` roots, and `.github/instructions/agento.instructions.md` there,
  bootstraps by direct push only when `origin/<default>` is absent, creates the
  companion ruleset (`pull_request`, `non_fast_forward`, `deletion`, no status
  checks) for a companion it created, writes `"repo": { "name": "<name>"` into the
  product config, creates no artifact roots in the product, and self-checks with
  `agento.mjs doctor` — verify: `grep -c 'gh repo create' .github/prompts/agento-init.prompt.md`
  ≥ 1; `grep -c '"name": "<name>"' …` ≥ 1; `grep -c 'agento-companion' …` ≥ 1;
  `grep -c 'artifact-repo' …` ≥ 1; `grep -n '\.gitkeep' …` names only companion
  paths; the step-3 "Create the artifact roots" sentence is gone (`grep -c 'Create
  the artifact roots from the config' …` = 0).
- [ ] `commands/agento-init.md` is byte-identical to the prompt — verify: `diff
  .github/prompts/agento-init.prompt.md commands/agento-init.md` prints nothing.
- [ ] `templates/AGENTS-section.md` and the prompt's inline AGENTS block carry the
  same companion sentence naming `<owner>/<companion>` and `../<companion>`; the
  new `templates/companion-README.md` starts with the marker comment
  `<!-- agento-companion: <owner>/<repo> -->`; `templates/project.instructions.md`
  keeps `applyTo: "features/**,issues/**,initiatives/**"` and mentions the
  companion copy — verify: `grep -c '<owner>/<companion>' templates/AGENTS-section.md
  .github/prompts/agento-init.prompt.md` = 1 each; `sed -n 1p
  templates/companion-README.md` is the marker line; `grep -c 'features/\*\*,issues/\*\*,initiatives/\*\*'
  templates/project.instructions.md` = 1.
- [ ] `delivery-policy.instructions.md` §9 idempotency row for `/agento agento-init`
  states that an existing companion repository or clone is adopted, never
  recreated — verify: `grep -c 'adopted, never recreated' .github/instructions/delivery-policy.instructions.md` = 1.
- [ ] README.md (set-up table and L381 row), docs/install.md, docs/commands.md,
  docs/project-profile.md, docs/artifacts.md describe the companion scaffold and
  no longer say init creates `features/`/`issues/` in the product repo — verify:
  `grep -c 'companion' README.md docs/install.md docs/commands.md
  docs/project-profile.md docs/artifacts.md` ≥ 1 each; `grep -c 'Artifact roots
  (with `.gitkeep`)' README.md` = 0; `grep -c 'features/` + `issues/`'
  docs/install.md` = 0.
- [ ] CHANGELOG.md `## Unreleased` has a bullet for `/agento agento-init` companion
  creation — verify: `awk '/^## Unreleased/,/^## 0\.4\.1/' CHANGELOG.md | grep -c
  'agento-init'` ≥ 1.
- [ ] End-to-end: a throwaway product repo initialised with the rewritten prompt has
  a public companion `<owner>/agento-smoke-init-<YYYYMMDD>-docs` whose `origin/main`
  holds `README.md`, `features/.gitkeep`, `issues/.gitkeep`,
  `initiatives/.gitkeep`, `.github/instructions/agento.instructions.md` and whose
  ruleset exists; the product tree has `.github/agento.json` naming it, the
  AGENTS section, `scripts/wait-for-checks.sh`, and no `features/`, `issues/`,
  `initiatives/` — verify: `evidence/step-3-1-init-smoke.md` records `gh repo
  view`, `git ls-tree`, `gh api …/rulesets`, `ls` of the product root, and
  `agento.mjs doctor --root <product>` exit 0 with `artifact-repo` `ok` and
  `agento.mjs config --root <product>` `artifactsRoot` = companion path; the
  Reviewer re-runs `doctor`/`config` against the same checkout.
- [ ] Idempotency: a second run adopts the companion and clone, recreates nothing,
  pushes nothing to the companion default branch — verify:
  `evidence/step-3-2-init-rerun.md` records identical `createdAt` and
  `rev-list --count origin/main` before and after, and the run's report says kept.
- [ ] Throwaway repository names are recorded in roadmap.md `## Follow-ups` for the
  user to delete — verify: `grep -c 'agento-smoke-init-' features/2026/09/artifact-repo-init/roadmap.md` ≥ 1.
- [ ] Full lint baseline still green — verify: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` ≥ 153 pass, 0 fail; `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` silent; `./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures.txt` exit 0.
