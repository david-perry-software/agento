# Step 4.1 smoke — throwaway `product` / `product-docs` pair (2026-09-15)

Setup (outside the repository), CLI = this worktree's `scripts/agento.mjs` at `6091c27`:

```sh
mkdir -p /tmp/arc && cd /tmp/arc
git init -q -b main product
git init -q -b main product-docs
git init -q --bare -b main product-docs.git
git -C product-docs commit -q --allow-empty -m init
git -C product-docs remote add origin /tmp/arc/product-docs.git
printf '{"artifacts":{"repo":{"name":"product-docs"}}}\n' > product/.github/agento.json
```

The delivery guard denies any `git push … main` from the Builder shell, including in
`/tmp`, so the companion's `origin/main` was not pushed; the check accepts the local
`refs/heads/main`, which is what "main present" below refers to.

## 1. `config` (from `/tmp/arc/product`) — trimmed

```json
{ "root": "/tmp/arc/product", "artifactsRoot": "/tmp/arc/product-docs",
  "repo": { "name": "product-docs", "dir": "/tmp/arc/product-docs" } }
```

## 2. `doctor` with the companion present

`doctor --for close-session` → exit **0**

```json
{ "status": "ok", "checks": ["node=ok", "python3=ok", "worktrees-dir=ok", "artifact-repo=ok"] }
```

`artifact-repo` from the unscoped `doctor`:

```json
{ "id": "artifact-repo", "status": "ok",
  "detail": "/tmp/arc/product-docs (product-docs), origin /tmp/arc/product-docs.git, main present",
  "fallback": null }
```

The unscoped `doctor` itself exits 3 in this throwaway in *both* states because the
recipe's `product` repo has no `origin` remote (`git-remote: no \`origin\` remote`),
which is unrelated to this feature; the `terminal`-scoped run above is the clean
exit-code comparison.

## 3. `status` and `paths feature demo`

```json
{ "status": "ok", "root": "/tmp/arc/product", "currentBranch": "main", "defaultBranch": "main",
  "items": [], "duplicates": [], "resumable": [] }
```

```json
{ "status": "ok", "worktreesDir": "/tmp/arc/product-worktrees",
  "worktree": "/tmp/arc/product-worktrees/feature-demo", "branch": "feature/demo",
  "artifactsRoot": "/tmp/arc/product-docs", "artifactRoot": "/tmp/arc/product-docs/features",
  "defaultBranch": "main", "postShipBranch": "post-ship/demo" }
```

## 4. `doctor` after `mv product-docs product-docs.off`

`doctor --for close-session` → exit **3**

```json
{ "status": "fail", "checks": ["node=ok", "python3=ok", "worktrees-dir=ok", "artifact-repo=fail"] }
```

```json
{ "id": "artifact-repo", "status": "fail", "detail": "/tmp/arc/product-docs absent",
  "fallback": "run `/agento agento-init` to create and clone the companion repository product-docs at /tmp/arc/product-docs, or correct artifacts.repo in .github/agento.json" }
```
