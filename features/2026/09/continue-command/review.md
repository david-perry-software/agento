# Review: continue-command

Verdict: approve

Review round 1, at `23d7e19` on `feature/continue-command` (draft PR #21, `state:
OPEN`, `isDraft: true`, base `main`), 2026-09-14. This promoted planning worktree
(`plan-20260915-024029`, `role: build`, `delivery.slug: continue-command`) owns the
branch per `agento.mjs session` (`worktrees[]`: primary `/home/david/DP/agento` on
`main`, this entry on the branch, no other). `doctor --for review-feature` → `ok`
(node v22.22.3, origin reachable, gh authenticated, python3, worktrees-dir writable);
no `Preflight:` line. `resolve feature continue-command` → `status: ok`, `source:
local`. `git fetch origin` then `git merge-base --is-ancestor origin/main HEAD` → 0
(`origin/main` = `b2dbbda`). Skills consulted: none — no matching domain (no
`.agents/skills/`, no `## Agento` skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview`
target applies, so no browser drive was needed. The user-visible surface is the CLI
JSON and the prompt text, both re-driven below.

Verification run by the Reviewer at `23d7e19` (plan.md `## Research` baseline at
`b2dbbda`: shellcheck 0 / 124 pass / replay 0):

- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, empty output.
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, **140 pass /
  0 fail / 0 skipped** (`# tests 140`). +16 over the baseline, all from this
  delivery (8 `deriveNext` table tests, 7 `next` integration tests, 1 shared); no new
  or undocumented findings.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0, every
  fixture `-> allow`/`-> ask` as recorded.
- `git diff --stat origin/main...HEAD` → 20 files, 1940+/32−; `git diff
  --name-only … | grep hooks` → nothing. Every file is in plan.md "Files touched";
  no `scripts/hooks/`, `.github/hooks/`, `plugin.json`, or `package.json` change
  (versions stay `0.3.0`).
- Canary negative check: appended `` run `git worktree list --porcelain` yourself ``
  to `.github/prompts/continue.prompt.md` → `node --test tests/customizations.test.mjs`
  exit 1 with `not ok 8 - only worktree-mutating commands inspect …` **and** `not ok
  18 - plugin manifest …` (the mirror test caught the drift from `commands/continue.md`);
  reverted with `git checkout --`, `git status --short` empty, rerun → 18 pass / 0 fail.

## Acceptance checklist results

1. **`deriveNext()` exported + table test over every §1 cell, six statuses, prompt
   basenames, never `ap`** — **pass.** `scripts/session-state.mjs:378` exports
   `deriveNext`; `NEXT_STATUSES` (L282) lists the six statuses. `node --test
   --test-reporter=spec scripts/session-state.test.mjs` → 8 `deriveNext:` tests pass:
   "build/plan window … every lifecycle × reviewFresh cell" (12-row `activeTable`
   × feature/issue, asserts every non-`no-delivery` `LIFECYCLES` value seen),
   "given another slug is blocked; build without a roadmap is blocked", "detached
   plan window drives the Planner from ready initiative members" (ok / none /
   ambiguous / blocked / missing), "freehand and unmanaged … unsupported for every
   lifecycle", "primary window, one delivery candidate, every lifecycle × owner ×
   reviewFresh cell" (16 rows + `complete`/no-owner → `none` + issue prefix),
   "primary window blocked when the primary itself owns the branch or is on one",
   "primary window with no slug — none, one initiative member, ambiguous; with a slug
   — missing", and "every command it ever emitted exists as a prompt and is never
   ap" (`emitted` distinct set deep-equals `build-feature, build-issue, new-feature,
   review-feature, review-issue, ship, start-session`). Every `ok` result is checked
   against `.github/prompts/` basenames and `!== "ap"` in the shared `next()` helper.
2. **`next` in this build worktree** — **pass.** With the committed `status: in-review`
   header the fresh run gives `/agento review-feature continue-command`, `window:
   here`, `dispatch.prompt … commands/review-feature.md`, `dispatch.agent …
   delivery-reviewer.agent.md`, exit 0 (matches rehearsal (c2)). With the header
   temporarily set to `in-progress` (sed, then `git checkout --`; `git status
   --short` → 0 lines): `status: ok`, `lifecycle: building`, `next.invocation:
   "/agento build-feature continue-command"`, `window: "here"`, `dispatch.prompt …
   commands/build-feature.md`, `dispatch.agent … delivery-builder.agent.md`;
   `test -f` on both paths → exists (matches rehearsal (c1)).
3. **Primary, no slug → `start-session … --resume` + `then`; two roadmaps →
   `ambiguous`, exit 3** — **pass.** `node scripts/agento.mjs next --root
   /home/david/DP/agento` → exit 0, `status: ok`, `role: primary`, `slug:
   continue-command`, `next.invocation: "/agento start-session
   feature/continue-command --resume"`, `window: here`, `then: "/agento continue
   continue-command"`, `dispatch.agent: null`, `warnings: []`; with the slug argument
   the identical transition. Ambiguity: `scripts/agento.test.mjs` "next from the
   primary: one in-progress roadmap → start-session --resume with then; two →
   ambiguous" asserts `two.code === 3`, `status: ambiguous`, `next: null`,
   `dispatch: null`, and `candidates[].invocation` `/agento continue bug` /
   `/agento continue widget` — passes.
4. **Fresh approve → ship (`primary` from build worktree, `here` from primary); stale
   approve → review; fresh request-changes → build** — **pass.** `scripts/agento.test.mjs`
   "next: review freshness decides between ship, re-review, and the fix handoff"
   passes: `approved.reviewFresh === true`, `approved.next.window === "primary"`;
   `fromPrimary.next.window === "here"`; `stale.reviewFresh === false`,
   `stale.next.window === "here"` (review); `fix.reviewFresh === true` (build). Code:
   `activeTransition` and `primaryTransition` in `scripts/session-state.mjs`
   L303–372; `reviewFreshness()` in `scripts/agento.mjs` L508–515 compares
   `git log -1 --format=%ct <ref> -- <dir>/review.md` with `-- . ':(exclude)…'`.
5. **Ready member slug from the primary → plan-mode `start-session` + `then`; detached
   `plan-*` with one ready member → `new-feature initiative:<i>/<f>` here** — **pass.**
   "next: ready initiative members drive start-session from the primary and
   new-feature from a plan window" passes (`inPlan.json.next.window === "here"`,
   unknown slug from the plan window → `missing`); unit cells in item 1.
6. **freehand → `unsupported` exit 3; wrong slug in build → `blocked` exit 3; unknown
   slug → `missing` exit 3; usage lists `next [<slug>]`** — **pass.** Live: temporary
   `git worktree add --detach …/freehand-review-tmp HEAD` → `next --root` there → exit
   3, `status: unsupported`, `role: freehand`, `next: null` (worktree removed +
   pruned, `git worktree list` shows no `review-tmp`); `next other-slug` here → exit
   3, `blocked`, "wrong window for other-slug: this worktree owns
   feature/continue-command…"; `next no-such-slug --root /home/david/DP/agento` → exit
   3, `missing`, "No roadmap for slug no-such-slug under features/ or issues/, locally
   or on origin, and no initiative member with that slug is ready."; `node
   scripts/agento.mjs` → exit 1, usage line 20 `next [<slug>]  (the one legal
   transition: command, args, window, dispatch paths)`. Integration test "next:
   freehand worktrees are unsupported; the primary on a delivery branch and an
   unplanned build branch are blocked" passes.
7. **`/agento continue` first in every primary/build/plan row, absent from
   freehand/unmanaged; `continue` in `COMMAND_NEEDS`; hook shape unchanged** —
   **pass.** `scripts/session-state.mjs` L262–266 prepends `CONTINUE` to every `TABLE`
   row only (`FREEHAND`/`UNMANAGED` untouched); `scripts/agento.mjs:309` `continue:
   ["terminal","ask-questions","browser","gh","code","network"]`. `doctor --for
   continue` → exit 0, `for.needs` = those six. `session` here → `allowed[0] ===
   "/agento continue"`; `session --root /home/david/DP/agento` → same. The three
   suites pass; `tests/session-context.test.mjs` only widened its two `allowed=[…]`
   regexes; no hook file changed.
8. **Prompt ≡ command file, Needs/Fallback, §9, `doctor --for continue`, window-check
   line, no porcelain / `ap` choice / canary** — **pass.** `diff
   .github/prompts/continue.prompt.md commands/continue.md` → empty. L7–9 `Needs:` /
   `Fallback:` / §10 pointer; L21–27 §9 receipt + idempotency + `doctor --for
   continue` (1 occurrence); L28 `Window check per §11: requires role `primary`,
   `plan`, or `build``. `grep -E 'porcelain|Receipt: (accepted|rejected)|Result:
   (completed|failed)|duplicate of|Preflight: |switch to Agent mode|paused at
   teardown'` → no match; the only `/agento ap` mention (L79) is in "What continue
   never does". `tests/customizations.test.mjs` → 18/18; negative check above proves
   the canaries bind to this file.
9. **Policy §9 row, §8 sentence, canonical list** — **pass.** `grep -n "/agento
   continue" .github/instructions/*.md` → `delivery-policy.instructions.md:156` (§8
   sentence), `:227` (§9 idempotency row), `command-invocation.instructions.md:15`.
10. **Docs mention `/agento continue` / `next`; versions `0.3.0`** — **pass.** `grep -c
    "agento continue"`: README.md 4, docs/commands.md 7, docs/architecture.md 1,
    templates/AGENTS-section.md 1, commands/agento-init.md 1, AGENTS.md 1,
    CHANGELOG.md 2 (under `## 0.4.0 (unreleased)`, CHANGELOG.md:3); `diff
    .github/prompts/agento-init.prompt.md commands/agento-init.md` → empty; AGENTS.md:18
    lists `next` in the CLI subcommand bullet; `plugin.json:4` / `package.json:3`
    `"version": "0.3.0"`.
11. **Rehearsal evidence exists, is linked, and matches a fresh run** — **pass.**
    `evidence/step-3-1-continue-rehearsal.md` (240 lines, four sections (a)–(d)) is
    linked from roadmap step 3.1. Fresh runs reproduce every recorded `status`,
    `next.invocation`, and `window`: (a) and (b) byte-for-byte on the compared fields;
    (c1) after the temporary `in-progress` header; (c2) is now the committed state and
    matches; (d) via a fresh detached freehand-named worktree → `unsupported`, exit 3.
12. **Full gate equal to baseline; diff within "Files touched"** — **pass.** See the
    verification block above: shellcheck 0, 140/0 (> 124), replay 0, 20/20 files
    listed.

Tally: **12 pass / 0 fail / 0 deferred**.

## Plan vs implementation

- The `deriveNext` table matches plan.md §1 row for row, including the `then` values,
  `--resume` only with a managed owner, `blocked` for a primary-owned branch or the
  primary sitting on a delivery branch, and `none` for `complete` with no owner.
  `reviewFresh: null` is treated as "not stale" (`!== false`), consistent with the
  plan's "not older counts as fresh" mitigation.
- `agento.mjs next` follows §2: slug resolution (local → `roadmapOnBranch` via the
  shared resolver / unpushed local branch → ready member → `missing`), `findOwner`,
  `refFor` (origin → local branch with warning → HEAD, never fetches), candidate
  union with de-duplication by slug, `dispatchFor` matching `agent:` to an agent
  file's `name:`, exit 0 / 3 / 1 as specified. One undocumented-but-reasonable
  refinement: a slug that exists as both a feature and an issue emits `ambiguous`
  (exit 3) naming both — not in the §1 table but consistent with Decision Q2.
- The prompt implements §4 (session → next → map status → perform → single result
  line); `Fallback:` adds a parenthetical that the dispatched command's own soft
  needs apply, which is accurate. No `tools:` restriction, as planned.
- Policy, instruction, doc, template, and changelog edits are exactly those in §5;
  no version bump. `tests/session-context.test.mjs` changed only where the widened
  `allowed=[…]` broke, as the plan allowed.
- No deviations from "Files touched"; no hook edit.

## Roadmap audit

All 11 boxes ticked; each spot-checked against the code and the live CLI:

- 1.1 `deriveNext` + 8 table tests (item 1). 1.2 CLI wiring, usage line, live output
  in both windows (items 2, 3, 6). 1.3 seven `next` integration tests pass (items
  3–6). 1.4 `CONTINUE` prepended, `COMMAND_NEEDS.continue`, doctor/session output
  (item 7). 1.5 / 2.4 / 3.2 gate reruns — the Reviewer's fresh run agrees
  (shellcheck 0, 140/0, replay 0) and `origin/main` is an ancestor of `HEAD`.
- 2.1 prompt + byte-identical mirror (item 8). 2.2 policy/instruction greps (item 9).
  2.3 doc greps + agento-init mirror (item 10).
- 3.1 evidence file linked and reproduced (item 11); the temporary states it
  describes left no residue (`git status --short` → 0; no stray worktree).

No falsely ticked boxes; no steps added; no repairs made.

## Findings

- **Minor** — `evidence/step-3-1-continue-rehearsal.md` §(d): the derived rejection
  line quotes `allowed: /agento finish-freehand <slug>, /agento commit-current-changes`
  with a literal `<slug>`, but `deriveAllowed` (`scripts/session-state.mjs:268–279`)
  fills `<slug>` from `worktree.id`, so the record for `freehand-rehearsal-tmp` would
  read `/agento finish-freehand rehearsal-tmp`. The recorded JSON — what the
  acceptance item requires — is exact; only the prose-derived receipt is
  approximate. No action required for approval.
- **Informational** — `dispatch.prompt`/`dispatch.agent` resolve under `PLUGIN_ROOT`
  (the directory of the running `agento.mjs`), so from the primary they point into
  this worktree's `commands/` when the CLI is invoked from here (as rehearsal (a)
  shows). This is what plan §2.5 specifies and is correct in plugin mode; noted so a
  reader is not surprised by worktree paths in the primary's output.
- **Informational** — no `tests/customizations.test.mjs` canary forbids `/agento ap`
  in guidance; the prompt's "never chooses `/agento ap`" is enforced at the CLI layer
  (unit test "never ap") rather than in the prompt text. Adequate for Decision Q4.

No security-relevant change: `next` is read-only over git and the filesystem (no
fetch, no writes), `requireSlug` validates the argument before any git call, and no
secrets are read or printed.

## Follow-ups

- Correct the `<slug>` placeholder in the evidence §(d) derived receipt to the
  filled value (`rehearsal-tmp`) if the evidence is ever refreshed; cosmetic only.
