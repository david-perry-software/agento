# Example: a filled-in project profile

What `## Agento` looks like in a pnpm/turbo monorepo with a Next.js web app, a
Fastify API, Supabase, Temporal, Vercel previews, and a Railway staging backend
(this mirrors the project Agento was extracted from — use it as a shape reference,
not as content to copy).

```markdown
## Agento

Delivery work in this repository is driven by the Agento plugin. Artifacts live in
`features/YYYY/MM/<slug>/`, `issues/YYYY/MM/<slug>/`, and
`initiatives/YYYY/MM/<slug>/`; configuration is `.github/agento.json`.

### Commands

- Install: `pnpm install`
- Test: `pnpm test` (per-package: `pnpm --filter <pkg> test`)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Full verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

### Verification strategy

- UI/API-contract: Playwright on per-slug ports (`pnpm exec playwright test
  e2e/<spec>.spec.ts` with `E2E_WEB_PORT`/`E2E_API_PORT` exported).
- Auth/DB flows: `./scripts/dev.sh up --detach` (local Supabase + Temporal, fixed
  ports 3000/4000 — exclusive; check `./scripts/dev.sh status` first).
- Vercel branch previews exist but cost a Railway `CORS_ORIGIN` edit + deploy wait;
  use only for platform-dependent steps and name the reason on the roadmap step.

### Shared resources

- `api-staging.example.dev` + one staging Supabase project behind every preview —
  read-only checks preferred; unique names + cleanup for writes.
- Railway `CORS_ORIGIN` is a single variable: re-read after writing; prune at ship.
- Local Supabase is machine-wide (fixed ports 54321-54324); destructive DB work is
  exclusive.

### Skills

| Domain | Skill |
|---|---|
| Temporal workflows/activities | temporal-developer |
| Supabase (DB, auth, RLS) | supabase |
| Postgres schema/RLS changes | supabase-postgres-best-practices |
| Fastify routes/plugins | fastify-best-practices |
| React/Next.js performance | vercel-react-best-practices |
| Railway infrastructure | use-railway |
| Browser automation / e2e | playwright-cli |
| Unit tests | vitest |
| Sentry issues | sentry-cli |
```
