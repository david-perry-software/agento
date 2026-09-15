## Agento

Delivery work in this repository is driven by the Agento plugin (slash commands
/agento start-session, /agento new-initiative, /agento next-feature, /agento new-feature, /agento new-issue,
/agento build-feature, /agento build-issue, /agento review-feature, /agento review-issue, /agento ap, /agento ship,
/agento continue, /agento close-session, /agento start-freehand, /agento finish-freehand, /agento doctor; /agento ship audits
a finished build in place and tears its worktree down, /agento close-session is for
plan and freehand sessions and abandoned builds). Artifacts live in
`features/YYYY/MM/<slug>/`, `issues/YYYY/MM/<slug>/`, and
`initiatives/YYYY/MM/<slug>/`; configuration is `.github/agento.json`.
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
