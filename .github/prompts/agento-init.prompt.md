---
description: "Scaffold Agento in the current project: create and clone the companion artifact repository (<repo>-docs), .github/agento.json pointing at it, an ## Agento section in AGENTS.md, and scripts/wait-for-checks.sh; --migrate also moves an existing in-repo features/, issues/, initiatives/ tree into the companion"
argument-hint: "[--force] [--migrate]"
---

Needs: terminal, ask-questions, gh, network
Fallback: ask-questions → §10 standard fallback (numbered questions in chat)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Initialize the current workspace (the **target repository**, not the Agento clone)
for Agento delivery work. Delivery artifacts do not live in the product repository:
init creates a **companion repository** (conventionally `<repo>-docs`) on GitHub,
clones it as the sibling `../<name>`, scaffolds the artifact roots there, and points
the product's `.github/agento.json` at it. `--force` rewrites scaffold files that
already exist (in both repositories); without it, leave existing files untouched and
report what was kept. `--force` never deletes, resets, or recreates a repository or
clone. `--migrate` additionally moves a pre-existing in-repo artifact tree
(`features/`, `issues/`, `initiatives/`) into the companion — see
`## Migration (--migrate)` below.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (existing files are kept unless `--force`; an existing companion
repository or clone is adopted; with `--migrate`, roots already moved report nothing
to migrate and existing `changes/agento-init` PRs in either repository are resumed).
Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for agento-init` and map
`fail`/`warn` per §10. `<agento-root>` comes from the session context line
`Agento CLI: node <agento-root>/scripts/agento.mjs` (fallback: the user-level
`chat.pluginLocations` setting — it is machine-scoped, so only user settings carry it).
Window check per §11: requires role `any` (read-only / not window-sensitive).

## Steps

1. **Product repository.** Confirm the workspace root is a git repository, is
   **not** the Agento plugin clone itself (no `.claude-plugin/plugin.json` with
   `"name": "agento"`), and is the **primary checkout**: `node
   <agento-root>/scripts/agento.mjs session` must report `worktree.isPrimary: true`.
   The companion is cloned to `../<name>` relative to the primary checkout (that is
   where every `agento.mjs` reader resolves it); running from a managed worktree
   would put the clone in the worktrees directory, so stop and name the primary
   path (`worktrees[0].path`) instead. Record `gh repo view --json
   nameWithOwner,visibility` as `<owner>/<repo>` and `<visibility>`, and the default
   branch from `git remote show origin` as `<default>`.

2. **Companion name.** Ask once, with the ask-questions tool (or its declared
   fallback, §10): "Name of the companion artifact repository under `<owner>`?"
   with default `<repo>-docs`. Accept only names matching `^[A-Za-z0-9_.-]{1,100}$`
   that differ from `<repo>`; re-ask otherwise. Call the answer `<name>`.

3. **Companion repository and clone.** Adopt, never recreate:
   - `gh repo view <owner>/<name>` succeeds → the repository exists; note
     `adopted`. It fails → `gh repo create <owner>/<name> --<public|private|internal
     per <visibility>> --description "Agento delivery artifacts for <owner>/<repo>"`;
     note `created`. A nonzero `gh repo create` stops the command: report the exact
     failure and the alternative (create the repository in the GitHub UI, then re-run
     `/agento agento-init` to adopt it). Never retry with elevated scopes.
   - `../<name>` (relative to the product root) does not exist → `git clone
     <clone-url> ../<name>` (an empty repository clones with a warning; that is
     fine). It exists → adopt it only if `git -C ../<name> rev-parse --show-toplevel`
     is that path and `git -C ../<name> remote get-url origin` names
     `<owner>/<name>`; any other content at that path is a hard stop naming the
     conflict — never write into or remove it.
   - `git -C ../<name> fetch origin`. If `origin/<default>` exists and has files,
     the repository is accepted only when the first line of its `README.md` is the
     marker `<!-- agento-companion: <owner>/<repo> -->`; an unrelated repository that
     happens to carry the name stops the command and asks for a different name
     (back to step 2) rather than being written into.

4. **Companion scaffold.** Prepare these files — in `../<name>` on `<default>`
   (checked out from `origin/<default>`) when that branch exists, otherwise in a
   scratch directory (`mktemp -d`) because the empty clone receives them by fetch
   below — creating each if absent (rewriting with `--force`):
   - `README.md` from `<agento-root>/templates/companion-README.md` with
     `<owner>/<repo>` filled in (its first line is the marker step 3 reads).
   - `<features>/.gitkeep`, `<issues>/.gitkeep`, `<initiatives>/.gitkeep`, using the
     root names the product config will carry (defaults `features`, `issues`,
     `initiatives`).
   - `.github/instructions/agento.instructions.md`: the frontmatter of
     `<agento-root>/templates/project.instructions.md` (rewrite its `applyTo` to the
     configured roots when they differ from the defaults) followed by the verbatim
     body of `<agento-root>/.github/instructions/delivery-artifacts.instructions.md`
     (everything after its frontmatter).
   Nothing else — no LICENSE, no `.github/agento.json`, no workflows.
   Then publish:
   - No `origin/<default>` yet (created this run, or adopted empty) → bootstrap the
     default branch through the GitHub Contents API, one call per file in the order
     listed above (README first — it initialises the repository and creates
     `<default>`): `gh api -X PUT repos/<owner>/<name>/contents/<path> -f
     branch=<default> -f message="chore: scaffold Agento artifact roots (<path>)"
     -f content="$(base64 -w0 <file>)"`. Never `git push` to the companion's default
     branch: the delivery guard denies every push to a default branch, `git -C`
     included, and this API bootstrap is the only time init writes to a default
     branch — it happens before any ruleset exists. Then `git -C ../<name> fetch
     origin` and `git -C ../<name> checkout <default>` so the clone tracks it.
   - `origin/<default>` exists → commit the missing files on `changes/agento-init`
     in the companion, push it, and open a PR there; nothing is written to its
     default branch. No missing files → nothing to commit; note `kept`.

5. **Companion ruleset.** For a companion this run `created`, immediately after the
   bootstrap commits run `gh api -X POST repos/<owner>/<name>/rulesets` with
   `name: "Agento default branch"`, `target: branch`, `enforcement: active`,
   `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`, `conditions.ref_name.exclude:
   []`, and `rules` of type `pull_request`, `non_fast_forward`, and `deletion` (no
   `required_status_checks`: the companion has no CI). For an `adopted` companion,
   run the same check-then-ask that step 9 runs for the product. A `403`/`422`
   (missing admin scope, or a private repository on a plan without rulesets) is
   recorded as a gap in the report, never retried with `--admin`.

6. **Product config.** Create `.github/agento.json` with the snippet below if absent
   (`--force` rewrites it), setting `branches.default` to `<default>` and
   `artifacts.repo.name` to `<name>`. Do **not** create `features/`, `issues/`, or
   `initiatives/` in the product repository: the roots live in the companion.

   ```json
   {
     "artifacts": {
       "features": "features",
       "issues": "issues",
       "initiatives": "initiatives",
       "repo": { "name": "<name>", "dir": null }
     },
     "worktrees": { "dir": null },
     "branches": {
       "default": "main",
       "feature": "feature/",
       "issue": "issue/",
       "freehand": "changes/",
       "postShip": "post-ship/"
     },
     "checks": { "releaseWorkflow": null }
   }
   ```

   `worktrees.dir: null` means "a sibling directory named `<repo-name>-worktrees/`".
   `artifacts.repo.name` points every `agento.mjs` reader at the sibling companion
   checkout `../<name>`; `dir: null` means exactly that sibling path. Only set the
   keys you want to override; every key is optional.

7. **AGENTS.md.** Create or append to the target repository's `AGENTS.md` an
   `## Agento` section using the template below (`<agento-root>/templates/AGENTS-section.md`).
   Fill the owner and companion placeholders from steps 1–2 and the remaining
   placeholders from the project's actual files (package.json scripts, README,
   existing tooling); ask the user for anything you cannot infer, with the
   ask-questions tool (or its declared fallback, §10). If AGENTS.md already has an
   `## Agento` section, leave it alone unless `--force` was given.

   ```markdown
   ## Agento

   Delivery work in this repository is driven by the Agento plugin (slash commands
   /agento start-session, /agento new-initiative, /agento next-feature, /agento new-feature, /agento new-issue,
   /agento build-feature, /agento build-issue, /agento review-feature, /agento review-issue, /agento ap, /agento ship,
   /agento continue, /agento close-session, /agento start-freehand, /agento finish-freehand, /agento doctor; /agento ship audits
   a finished build in place and tears its worktree down, /agento close-session is for
   plan and freehand sessions and abandoned builds). Artifacts live in the companion
   repository `<owner>/<companion>` cloned at `../<companion>` —
   `features/YYYY/MM/<slug>/`, `issues/YYYY/MM/<slug>/`, and
   `initiatives/YYYY/MM/<slug>/` there; configuration is this repository's
   `.github/agento.json`.
   Commands are always written `/agento <name>`; a bare `/<name>` or a `.prompt`/`.md`
   suffix is read as the canonical command and proceeds without confirmation.

   ### Commands

   - Install: `<install command>`
   - Test: `<test command>`
   - Typecheck: `<typecheck command, or "none">`
   - Lint: `<lint command, or "none">`
   - Full verification: `<what /agento ship should expect to be green>`

   ### Verification strategy

   <How user-visible behavior is verified locally: dev server command, ports, e2e
   runner. Whether a deployment preview system exists and when it may be used.>

   ### Shared resources

   <Staging backends, machine-wide local services, fixed ports that collide across
   concurrent sessions — or "none".>

   ### Skills

   | Domain | Skill |
   |---|---|
   | <domain> | <skill name or "none installed"> |
   ```

8. **CI poller.** Copy Agento's bounded CI poller into the project at
   `scripts/wait-for-checks.sh` and `chmod +x` it. Source it from the local Agento
   clone at `<agento-root>`. Never download it from the network — an unpinned
   `curl | copy` of an executable is not acceptable; if the clone cannot be located,
   tell the user to copy the file from their Agento checkout manually.

9. **Check the product's enforcement layer.** The delivery guard is a slip guard,
   not a boundary; the default branch must be protected server-side. Run
   `gh api repos/{owner}/{repo}/rulesets --jq '.[] | select(.target=="branch") | .name'`
   and `gh api repos/{owner}/{repo}/branches/<default>/protection` (404 means none).
   If neither a ruleset nor branch protection covers the default branch, ask the user
   (with the ask-questions tool or its declared fallback, §10) whether to create a
   ruleset now that: requires a pull
   request before merging, requires the project's CI check(s) to pass, blocks force
   pushes, and blocks deletion — `gh api -X POST repos/{owner}/{repo}/rulesets` with
   `enforcement: active`, `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`, and
   `rules` of type `pull_request`, `required_status_checks`, `non_fast_forward`, and
   `deletion`. Never create it without the user's yes; if declined or if `gh` lacks
   admin scope, record the gap in the report so the user can do it in the GitHub UI.

10. **Self-check.** From the product root run `node <agento-root>/scripts/agento.mjs
    doctor` and read the `artifact-repo` check. `ok` → continue. `warn` naming stale
    in-repo roots (a project initialised before the companion layout) → continue and
    report it as pre-existing; do not move or delete anything here — that is what
    `/agento agento-init --migrate` is for (`## Migration (--migrate)` below), and
    with `--migrate` given this check must read `ok` because the roots are gone from
    the working tree. `fail` → stop before
    committing and report the check's `detail` and `fallback` verbatim.

11. **Commit, PR, report.** Commit the product scaffold on a `changes/agento-init`
    branch (never on the default branch), open a PR, and report: the companion
    `<owner>/<name>` with its GitHub URL and clone path `../<name>`, whether it was
    created or adopted, the bootstrap commit SHAs (`origin/<default>` head) or the
    companion PR number, both
    rulesets' status (created / already protected / declined / gap), config values
    chosen, files created and files kept, the reminder to add `../<name>` to the
    editor workspace (*File → Add Folder to Workspace…*) so the artifact-format
    instructions load in the **primary** window — see the Agento clone's
    `docs/project-profile.md`; managed sessions need no such step because
    `/agento start-session` and `/agento start-freehand` open every session as a
    two-folder `.code-workspace` pairing the product worktree with its companion half
    under `../<name>-worktrees/` — the exact next command (`/agento start-session` then
    `/agento new-feature <description>`), and — if the plugin is not yet registered —
    the settings snippet:

    ```jsonc
    "chat.plugins.enabled": true,
    "chat.pluginLocations": { "<path to the Agento clone>": true }
    ```

## Migration (--migrate)

With `--migrate`, the product repository already carries delivery history inside
its own tree (`features/`, `issues/`, `initiatives/` — the roots `doctor` reports as
stale once a companion is configured). Steps 1–5 run unchanged (companion name,
create or adopt, scaffold, ruleset). Then, instead of going straight to step 6, run
the M-steps below; steps 6–10 follow, and step 11 is replaced by M7–M9. The
`migrate` subcommand does filesystem work only — every stage, commit, and push
below is yours, so the delivery guard keeps governing them.

- **M1 — Dry run.** From the product root run `node <agento-root>/scripts/agento.mjs
  migrate ../<name>` and read the JSON: `mode: "dry-run"` lists `roots[]` (files
  and bytes per root), `records` (every roadmap and breakdown found), and
  `conflicts[]`. `status: "conflict"` (exit 3) names destination files the move
  would overwrite: stop and report them — nothing is written until they are
  resolved. `mode: "nothing-to-migrate"` means the roots are already gone: skip
  M2–M6, note it in the report, and resume any existing `changes/agento-init` PRs
  (M7–M9) instead of opening new ones. `reason: "not-sibling"` means `../<name>`
  is not a sibling of the primary checkout — step 3 put it there, so re-check the
  clone path before continuing.
- **M2 — In-flight deliveries.** Run `gh pr list --state open --json headRefName`
  in the product. Any open branch carrying the configured `branches.feature` or
  `branches.issue` prefix is an in-flight delivery whose in-repo artifacts the move
  would strand (its branch keeps the roots, the default branch loses them). List
  them and stop unless the user explicitly accepts the move now — ask with the
  ask-questions tool (or its declared fallback, §10) and record the answer in the
  report. The clean path is to ship those deliveries first and re-run.
- **M3 — Companion branch.** `git -C ../<name> switch -c changes/agento-init
  origin/<default>` (resume it with `git -C ../<name> switch changes/agento-init`
  when it already exists). The companion's default branch is never written by this
  flow.
- **M4 — Apply.** `node <agento-root>/scripts/agento.mjs migrate ../<name> --apply`.
  Expect `mode: "applied"`, `records.identical: true` (same roadmaps and breakdowns
  read from the destination as from the source), `configWritten` naming the
  product's `.github/agento.json` (created from the template with
  `artifacts.repo.name: "<name>"`, or that one key set in an existing config), and
  `readmeNoteAdded: true` (the companion `README.md` gains a `## Migrated history`
  note explaining that pre-migration plans link relative to the product tree at the
  time of writing). `records.identical: false` → stop; report `records.diff[]`
  and do not commit either side. The product working tree now has the roots
  removed and the config added — step 6 finds the config already present.
- **M5 — Commit and push the companion.** `git -C ../<name> add -A`, then commit
  `docs(migration): import delivery artifacts from <owner>/<repo>` and `git -C
  ../<name> push -u origin changes/agento-init`.
- **M6 — Companion PR.** `cd ../<name> && gh pr create --draft --base <default>
  --head changes/agento-init --title "docs(migration): import delivery artifacts
  from <owner>/<repo>" --body "<one paragraph: what moved, from which repository,
  and that the product PR follows>"` (run inside the clone so `gh` targets the
  companion). Resume an existing open PR on that branch instead of creating a
  second one. Record its URL as `<companion-pr>`.
- **M7 — Product commit and PR.** Run steps 6–10 (step 10 must read `artifact-repo`
  `ok`), then commit everything on `changes/agento-init` in the product —
  `chore(agento-init): move delivery artifacts to <name>` — push, and open the
  product PR whose body links `<companion-pr>` and says **merge the companion PR
  first** (a product default branch that points at an empty companion default
  branch reads no history until the companion PR lands). Resume an existing open
  PR on `changes/agento-init` instead of creating a second one.
- **M8 — Cross-link.** `gh pr edit <companion-pr> --body "<existing body> +
  <product PR URL>"` inside the clone so each PR names the other.
- **M9 — Report.** Everything step 11 reports, plus: both PR URLs and the merge
  order (companion first, then product), the roots moved (`moved[]`), the record
  counts from `records`, whether the README note was added, and the reminder that
  full per-file history stays in the product repository's log (the companion carries
  one import commit). Init never merges either PR.
