# Step 4.3 — /ship changelog stamp rehearsal

Rehearsed on a temp copy of `CHANGELOG.md` outside the worktree (`mktemp -d`), on
2026-09-06 (UTC). The stamp is exactly what `ship.prompt.md` step 3 prescribes:
replace `(unreleased)` on the `## <version> (unreleased)` heading with the output of
`date -u +%Y-%m-%d`.

## Setup

```sh
T=$(mktemp -d)
{ printf '## 9.9.9 (unreleased)\n\n- **Rehearsal** entry.\n\n'; cat CHANGELOG.md; } > "$T/CHANGELOG.md"
cp "$T/CHANGELOG.md" "$T/CHANGELOG.before.md"
```

First line before the stamp:

```
## 9.9.9 (unreleased)
```

## Stamp

```sh
D=$(date -u +%Y-%m-%d)          # DATE=2026-09-06
sed -i "s/^## 9.9.9 (unreleased)$/## 9.9.9 ($D)/" "$T/CHANGELOG.md"
sed -n '1p' "$T/CHANGELOG.md"
```

Output:

```
## 9.9.9 (2026-09-06)
```

## Diff (exactly one changed line)

```sh
diff "$T/CHANGELOG.before.md" "$T/CHANGELOG.md"
```

```
1c1
< ## 9.9.9 (unreleased)
---
> ## 9.9.9 (2026-09-06)
```

`diff` exit status 1 (differences found); one hunk `1c1`; no other line changed.
