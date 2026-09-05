---
description: "Scaffold Agento in the current project: .github/agento.json, features/ and issues/ directories, an ## Agento section in AGENTS.md, and scripts/wait-for-checks.sh"
argument-hint: "[--force]"
---

Initialize the current workspace (the **target repository**, not the Agento clone)
for Agento delivery work. `--force` rewrites files that already exist; without it,
leave existing files untouched and report what was kept.

## Steps

1. Confirm the workspace root is a git repository and is **not** the Agento plugin
   clone itself (no `plugin.json` with `"name": "agento"` at its root).

2. Create `.github/agento.json` with the defaults below if absent. If the project
   uses a different default branch (check `git remote show origin`), set
   `branches.default` accordingly.

   ```json
   {
     "artifacts": { "features": "features", "issues": "issues" },
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
   Only set the keys you want to override; every key is optional.

3. Create the artifact roots from the config (default `features/` and `issues/`),
   each with a `.gitkeep`.

4. Create or append to the target repository's `AGENTS.md` an `## Agento` section
   using the template below. Fill the placeholders from the project's actual files
   (package.json scripts, README, existing tooling); ask the user for anything you
   cannot infer, using `vscode/askQuestions`. If AGENTS.md already has an `## Agento`
   section, leave it alone unless `--force` was given.

   ```markdown
   ## Agento

   Delivery work in this repository is driven by the Agento plugin (slash commands
   /start-session, /new-feature, /build-feature, /review-feature, /ap, /ship,
   /close-session, /start-freehand, /finish-freehand). Artifacts live in
   `features/YYYY/MM/<slug>/` and `issues/YYYY/MM/<slug>/`; configuration is
   `.github/agento.json`.

   ### Commands

   - Install: `<install command>`
   - Test: `<test command>`
   - Typecheck: `<typecheck command, or "none">`
   - Lint: `<lint command, or "none">`
   - Full verification: `<what /ship should expect to be green>`

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

5. Copy Agento's bounded CI poller into the project at `scripts/wait-for-checks.sh`
   and `chmod +x` it. Source it from the local Agento clone: the session context line
   `Agento CLI: node <agento-root>/scripts/agento.mjs` gives `<agento-root>`
   (fallback: the workspace or user `chat.pluginLocations` setting). Never download it
   from the network — an unpinned `curl | copy` of an executable is not acceptable;
   if the clone cannot be located, tell the user to copy the file from their Agento
   checkout manually.

6. If `artifacts.features`/`artifacts.issues` were customized away from the defaults,
   copy Agento's `templates/project.instructions.md` to
   `.github/instructions/agento.instructions.md` and adjust its `applyTo:` to the
   custom roots so the artifact contract keeps loading.

7. **Check the enforcement layer.** The delivery guard is a slip guard, not a
   boundary; the default branch must be protected server-side. Run
   `gh api repos/{owner}/{repo}/rulesets --jq '.[] | select(.target=="branch") | .name'`
   and `gh api repos/{owner}/{repo}/branches/<default>/protection` (404 means none).
   If neither a ruleset nor branch protection covers the default branch, ask the user
   (with `vscode/askQuestions`) whether to create a ruleset now that: requires a pull
   request before merging, requires the project's CI check(s) to pass, blocks force
   pushes, and blocks deletion — `gh api -X POST repos/{owner}/{repo}/rulesets` with
   `enforcement: active`, `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`, and
   `rules` of type `pull_request`, `required_status_checks`, `non_fast_forward`, and
   `deletion`. Never create it without the user's yes; if declined or if `gh` lacks
   admin scope, record the gap in the report so the user can do it in the GitHub UI.

8. Commit the scaffold on a `changes/agento-init` branch (never on the default
   branch), open a PR, and report: config values chosen, files created, whether the
   default branch is protected server-side, the exact next command (`/start-session`
   then `/new-feature <description>`), and — if the plugin is not yet registered —
   the settings snippet:

   ```jsonc
   "chat.plugins.enabled": true,
   "chat.pluginLocations": { "<path to the Agento clone>": true }
   ```
