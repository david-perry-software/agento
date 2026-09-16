# The project profile: `.github/agento.json` + `AGENTS.md`

Agento is generic; your project supplies its facts in two places.

## `.github/agento.json` — machine-readable

Read by the hooks and the roadmap resolver. Every key is optional; omit the file
entirely for defaults.

```json
{
  "artifacts": {
    "features": "features",
    "issues": "issues",
    "initiatives": "initiatives",
    "repo": { "name": null, "dir": null }
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

| Key | Default | Effect |
|---|---|---|
| `artifacts.features` / `artifacts.issues` | `features` / `issues` | Where plan/roadmap/review live, inside the companion checkout. If changed, also adjust the companion's `.github/instructions/agento.instructions.md` `applyTo` (copied from `templates/project.instructions.md` by `/agento agento-init`). |
| `artifacts.initiatives` | `initiatives` | Where initiative `brief.md` + `breakdown.md` live; `agento.mjs initiative` walks this root. Same `agento.instructions.md` note applies. |
| `artifacts.repo.name` | `null` | Name of a sibling **companion repository** that holds the artifact roots instead of this repository; set by `/agento agento-init` (default `<repo>-docs`). Setting it (or `dir`) switches every `agento.mjs` reader to the companion checkout; `null` for both = the in-repo layout of projects initialised before the companion existed. Defaults to the basename of `dir` when only `dir` is set. |
| `artifacts.repo.dir` | `../<name>` | Path of the companion checkout, resolved against the **primary** checkout (like `worktrees.dir`), so every managed worktree reads the same sibling clone. When set, the in-repo `features/`, `issues/`, and `initiatives/` directories are ignored; `doctor` (`artifact-repo` check) fails when the checkout is missing, not a git toplevel, has no `origin`, or lacks `branches.default`, and warns about stale in-repo roots. |
| `worktrees.dir` | `../<repo-name>-worktrees` | Managed worktree parent. `null` = derive from the repo directory name. |
| `branches.default` | `main` | Protected branch: the guard denies direct commits/pushes to it. |
| `branches.feature` / `branches.issue` | `feature/` / `issue/` | Branch prefixes; the roadmap nudge fires on these. Must match the `branch:` header in roadmaps. |
| `branches.freehand` / `branches.postShip` | `changes/` / `post-ship/` | Freehand and post-ship-epilogue branch prefixes. |
| `checks.releaseWorkflow` | `null` | A GitHub Actions workflow file name; `/agento ship` watches it after merge when set. |

When `artifacts.repo` is set, the editor only sees the companion's files if the
primary VS Code window adds the companion checkout as a workspace folder (*File →
Add Folder to Workspace…*); `/agento agento-init`'s report reminds you. `doctor`
cannot detect this: the hook payload carries the working directory but no list of
workspace folders, so keep the folder added by hand.

## `AGENTS.md` `## Agento` section — narrative

Read by the agents. `/agento agento-init` scaffolds it from `templates/AGENTS-section.md`:

- **Commands** — install / test / typecheck / lint / full verification. Agents quote
  these in plans and run them in verify steps.
- **Verification strategy** — how to serve the app locally, the e2e runner, and
  whether a deployment-preview system exists.
- **Shared resources** — staging backends, machine-wide local services, fixed ports
  that collide across sessions (or "none").
- **Skills** — the domain → skill table used by the skills-first policy.

Keep both files honest: the agents treat AGENTS.md as the project's truth, and the
hooks treat `agento.json` as the machine's truth.
