## Agento

Delivery work in this repository is driven by the Agento plugin (slash commands
/start-session, /new-feature, /new-issue, /build-feature, /build-issue,
/review-feature, /review-issue, /ap, /ship, /close-session, /start-freehand,
/finish-freehand). Artifacts live in `features/YYYY/MM/<slug>/`,
`issues/YYYY/MM/<slug>/`, and `initiatives/YYYY/MM/<slug>/`; configuration is
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
