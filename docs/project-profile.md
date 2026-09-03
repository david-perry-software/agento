# The project profile: `.github/agento.json` + `AGENTS.md`

Agento is generic; your project supplies its facts in two places.

## `.github/agento.json` — machine-readable

Read by the hooks and the roadmap resolver. Every key is optional; omit the file
entirely for defaults.

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

| Key | Default | Effect |
|---|---|---|
| `artifacts.features` / `artifacts.issues` | `features` / `issues` | Where plan/roadmap/review live. If changed, also copy `templates/project.instructions.md` (done by `/agento-init`). |
| `worktrees.dir` | `../<repo-name>-worktrees` | Managed worktree parent. `null` = derive from the repo directory name. |
| `branches.default` | `main` | Protected branch: the guard denies direct commits/pushes to it. |
| `branches.feature` / `branches.issue` | `feature/` / `issue/` | Branch prefixes; the roadmap nudge fires on these. Must match the `branch:` header in roadmaps. |
| `branches.freehand` / `branches.postShip` | `changes/` / `post-ship/` | Freehand and post-ship-epilogue branch prefixes. |
| `checks.releaseWorkflow` | `null` | A GitHub Actions workflow file name; `/ship` watches it after merge when set. |

## `AGENTS.md` `## Agento` section — narrative

Read by the agents. `/agento-init` scaffolds it from `templates/AGENTS-section.md`:

- **Commands** — install / test / typecheck / lint / full verification. Agents quote
  these in plans and run them in verify steps.
- **Verification strategy** — how to serve the app locally, the e2e runner, and
  whether a deployment-preview system exists.
- **Shared resources** — staging backends, machine-wide local services, fixed ports
  that collide across sessions (or "none").
- **Skills** — the domain → skill table used by the skills-first policy.

Keep both files honest: the agents treat AGENTS.md as the project's truth, and the
hooks treat `agento.json` as the machine's truth.
