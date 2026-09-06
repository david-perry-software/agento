# Review: initiative-workflow

Verdict: approve

Reviewed `da1f1ba` (`feature/initiative-workflow`, draft PR #12) against `origin/main`
`48a954b` on 2026-09-06 (UTC) from the owning worktree
`/home/david/DP/agento-worktrees/plan-20260906-021639`. `node scripts/agento.mjs
resolve feature initiative-workflow` → `status: ok`; `git merge-base --is-ancestor
origin/main HEAD` holds; `gh pr view 12 --json mergeStateStatus` → `CLEAN`, `isDraft:
true`. Skills consulted: none — no matching domain (no `## Agento` skills table in
AGENTS.md, no `.agents/skills/`). Every command below was run by the Reviewer in this
worktree; nothing was taken from the Builder's evidence on trust.

## Acceptance checklist results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `initiative-architect.agent.md`: name, `Use when:`, `agent` tool + `agents: ["Explore"]`, no `handoffs`, nine-step Procedure | **pass** | `grep -c 'agento.mjs initiative\|agento.mjs find\|wait-for-checks.sh\|/next-feature\|Source:'` → 9 (≥ 5); `grep -c '^handoffs'` → 0; frontmatter L2–8 has `name: "🏛️ Agento Architect"`, `tools: [read, search, edit, execute, agent]`, `agents: ["Explore"]`; Procedure L35–97 covers primary-worktree precondition (1), inline-or-file brief with `Source:` (2), clarification (3), `initiative <slug>` → `missing` + branch checks (5), `find <feature-slug>` → `missing` (6), `status: ok` gate (7), PR + `wait-for-checks.sh` + normal merge + delete + `main` sync (8), `/next-feature <slug>` closing (9); `node --test tests/customizations.test.mjs` part of the 69/69 run below |
| 2 | `new-initiative.prompt.md` dispatches to the Architect, `argument-hint` names text and path, authorizes branch/PR/merge, stops on empty argument | **pass** | `grep -c '🏛️ Agento Architect'` → 1 (L4 `agent:`); L3 `argument-hint: "Brief text, or a repository-relative path…"`; L31–34 authorization paragraph; L36 "If the argument is empty, ask for the brief … and stop." |
| 3 | `next-feature.prompt.md` read-only, runs `initiative <slug>`, groups members, prints the four commands, lists other ready members, handles `next: null` | **pass** | `grep -c 'initiative:<\|/start-session\|/build-feature\|/review-feature\|/ship\|blockedBy\|anomalies'` → 9 (≥ 7); L4 `agent: "agent"`, L5 `tools: [read, search, execute]`; L8–11 read-only statement; L19–27 grouping incl. `blockedBy` and `anomalies`; L28–30 `next: null` (`done` vs in-flight); L33–39 command block; L41–44 concurrent ready members; L46–47 never runs `/start-session`/`/new-feature` |
| 4 | Planner explicit `initiative:<i>/<f>` intake with hard stops, no override, `Brief:`/`Summary:`, preassigned slug, header field, breakdown link; `new-feature.prompt.md` documents the form | **pass** | `grep -c 'initiative:' .github/agents/delivery-planner.agent.md` → 4 (≥ 3); `grep -c blockedBy` → 1; `grep -c 'initiative:' .github/prompts/new-feature.prompt.md` → 4 (≥ 1); Planner step 3 (L51–69, before Research at L70) anchors the pattern `^initiative:[a-z0-9-]+/[a-z0-9-]+$`, stops on `missing`/`invalid`/non-member/`state != unplanned`/`ready == false` "there is no override", forbids attachment by slug coincidence; step 5 L82 preassigned slug; step 7 L119–121 header + `## Problem` link; all `step N` cross-references (L50, 63, 64, 66, 82) renumbered consistently |
| 5 | `delivery-status.prompt.md` `Initiative` column, second table from `agento.mjs initiative`, `/next-feature <slug>`, read-only | **pass** | `grep -c 'agento.mjs initiative\|/next-feature\|Initiative'` → 4 (≥ 3); `grep -c read-only` → 1; step 1 reads `initiative`, step 3 `Initiative` column (`—` when null), step 4 list mode + per-`valid` `next`/`done`/`anomalies`, step 5 folds `valid: false` and `anomalies` into anomalies |
| 6 | `ship.prompt.md` stamps `(unreleased)` with `date -u +%Y-%m-%d` in the `status: complete` commit, refreshes on a later date, final restriction permits it | **pass** | `grep -c unreleased` → 4 (≥ 3); `grep -c 'date -u'` → 2 (≥ 1); step 1 audit bullet (version change vs `(unreleased)` gap), step 3 first bullet "in this same commit, immediately before checks and merge, never as a manual step", refresh sentence after the checks bullet, final paragraph L100–104 lists the stamp and its refresh |
| 7 | Docs, templates, example updated | **pass** (see Finding 3) | `grep -l '/new-initiative' README.md docs/commands.md templates/AGENTS-section.md .github/prompts/agento-init.prompt.md` → all four; `grep -c Architect` docs/architecture.md → 3, docs/artifacts.md → 2, docs/commands.md → 2; `grep -c initiatives examples/soshiki-profile.md` → 1; docs/concurrency.md: literal `grep -c initiatives` → 0 but `grep -n -i initiative` → L19–23, the required "same-wave members may be planned/built concurrently" paragraph (roadmap 5.2's `grep -c initiative` → 3); template L3–7 and agento-init L49–53 command sentences `diff` identical; `grep -c '/new-initiative\|/next-feature\|Architect\|breakdown.md' README.md` → 12 (≥ 8) |
| 8 | Manifests `0.3.0`, CHANGELOG first heading `## 0.3.0 (unreleased)` with the required bullets | **pass** | `node -e '…process.exit(1)'` exit 0; `sed -n 3p CHANGELOG.md` → `## 0.3.0 (unreleased)`; bullets: Architect + `/new-initiative`, `/next-feature`, Planner intake, `/delivery-status`, `/ship` stamp, initiative foundation (`initiatives-core`) |
| 9 | Rehearsal evidence files exist with the quoted outputs | **pass** | `evidence/step-1-3-architect-rehearsal.md` contains `"status": "missing"` ×2, `"status": "ok"` ×2, `"next": "demo-a"` (grep → 5 hits); `evidence/step-4-3-ship-stamp.md` contains `(unreleased)` and `(2026-09-06)` (grep → 7). Independently re-driven in a throwaway local repo (`mktemp -d`, no remote, deleted afterwards): `initiative demo-init` → `missing`; `find demo-a` → `missing`; after brief.md + 2-member breakdown → `{"status":"ok","errors":[],"states":["demo-a:unplanned:true","demo-b:unplanned:false"],"next":"demo-a","done":false}`; stamp `sed` on a temp copy → `diff` shows exactly `1c1 ## 9.9.9 (unreleased) → ## 9.9.9 (2026-09-06)` |
| 10 | Full lint gate (policy §5): node tests ≥ 69 pass, shellcheck 0, replay-guard 0, nothing beyond baseline | **pass** | `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0, `# tests 69 / # pass 69 / # fail 0` (= plan.md baseline); `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` (`/home/david/.local/bin/shellcheck`) exit 0, 0 output lines (= baseline); `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0, 91 fixtures → 91 verdict lines, no mismatch (= baseline) |
| 11 | No files under `scripts/`, `.github/hooks/`, `hooks.json`, `tests/guard-fixtures.txt` modified | **pass** | `git diff --name-only origin/main...HEAD \| grep -E '^(scripts/\|\.github/hooks/\|hooks\.json\|tests/guard-fixtures\.txt)'` → no output (22 files changed, all `.github/agents`, `.github/prompts`, docs, README, CHANGELOG, manifests, templates, example, and the slug directory) |

## Plan vs implementation

Checked against plan.md `## Approach` §1–8 and `## Decisions` 1–5:

- **Architect runs in the primary window and self-publishes (Decision 1)** — matches:
  step 1 requires the primary checkout on `main`, clean, zero ahead/behind (rejects
  `plan-<id>` and `changes/*` worktrees); step 5 `git switch -c
  changes/initiative-<slug>`; step 8 commit → push → PR → `wait-for-checks.sh pr <n>`
  → normal merge → delete → `main` sync; `/finish-freehand` is not required. No
  `handoffs` (Decision 2).
- **`/next-feature` is read-only (Decision 2)** — matches: `agent: "agent"`, tools
  `read, search, execute` (needed for the CLI), explicit "never create worktrees,
  branches, or files, and never hand off"; the printed sequence follows policy §8
  (plan/build/review in the secondary window, `/close-session` + `/ship` from the
  primary).
- **Planner intake explicit only, hard stops, no override (Decision 3)** — matches
  Planner step 3 and the new-feature prompt paragraph; both say plain `/new-feature`
  never attaches by slug coincidence.
- **`agento.mjs status` and `session-context.sh` untouched (Decision 4)** — matches:
  no `scripts/` diff; `/delivery-status` only consumes the existing per-item
  `initiative` field plus `agento.mjs initiative`.
- **`## 0.3.0 (unreleased)` stamped by `/ship` in the `status: complete` commit
  (Decision 5)** — matches ship.prompt.md step 3 and the final restriction paragraph;
  the bootstrapping risk (primary window loads the pre-stamp prompt from `main`) is
  mitigated as planned by the roadmap `## Follow-ups` note with the exact replacement.
- **Deviations (all additive, none contradict a decision):**
  1. `/next-feature` with an *empty* argument runs list mode, shows initiatives, asks
     which to report, and stops (next-feature.prompt.md L16–18). Not in `## Approach`
     §3; still read-only and consistent with Decision 2.
  2. Planner agent `argument-hint` (L4, "Describe the feature or issue to plan") was
     not extended with the `initiative:<i>/<f>` form; only the `/new-feature`
     prompt's `argument-hint` was. The plan required the prompt only, so this is not
     a gap — listed under Follow-ups.
- No undocumented changes: every file in `git diff --stat origin/main...HEAD` is named
  in `## Approach` §1–8 or is a delivery artifact of this slug.

## Roadmap audit

All 15 ticked steps spot-checked against the codebase (code is truth):

- 1.1 / 1.2 / 2.1 / 3.1 / 3.2 / 4.1 / 4.2 / 5.1 / 5.2 / 5.3 / 6.1 — each step's own
  `verify:` grep/test rerun above (checklist rows 1–8); all hold.
- 1.3 / 4.3 — evidence files present and linked from the step line with the
  completion date; CLI path and stamp independently re-driven (checklist row 9).
- 7.1 — full gate rerun: 69/69, shellcheck 0, replay-guard 0; equals the recorded
  result and the plan.md baseline.
- 7.2 — scope boundary clean; `origin/main` is an ancestor of `HEAD`; PR #12
  `mergeStateStatus: CLEAN`; header `status: in-review`; `## Follow-ups` stamp note
  present.
- No `(manual)` or `(manual, post-ship)` steps exist, so no evidence-file gaps.

No falsely ticked boxes; no missing-work steps added; no repairs made.

## Findings

Ordered by severity. Nothing above minor.

1. **Minor — Planner `argument-hint` not updated.**
   [.github/agents/delivery-planner.agent.md](../../../../.github/agents/delivery-planner.agent.md)
   L4 still reads "Describe the feature or issue to plan" while the agent body now
   accepts `initiative:<initiative-slug>/<feature-slug>`. The `/new-feature` prompt
   hint does carry the form, so users invoking the command are informed; only direct
   agent invocation lacks the hint.
2. **Minor — `/next-feature` empty-argument list mode is undocumented in the plan.**
   [.github/prompts/next-feature.prompt.md](../../../../.github/prompts/next-feature.prompt.md)
   L16–18. Behaviour is read-only and sensible; plan.md `## Approach` §3 should have
   named it. No action needed beyond noting the deviation here.
3. **Minor — checklist item 7's literal proxy grep misses.** plan.md requires
   `grep -c initiatives docs/concurrency.md` ≥ 1, but
   [docs/concurrency.md](../../../../docs/concurrency.md) L19–23 uses the singular
   ("Initiative members", `initiative:<i>/<f>`, `changes/initiative-<slug>`), so the
   plural grep returns 0 while the roadmap 5.2 verify (`grep -c initiative`) returns 3.
   The stated requirement — the concurrent same-wave paragraph — is met; scored pass
   on substance. Future plans should use the same token in the checklist and the
   roadmap.

Security: only Markdown customization files, manifests, and the CHANGELOG changed;
no hooks, scripts, or executable code. The ship stamp instruction bounds the
replacement to the exact `## <version> (unreleased)` heading and derives the date
from `date -u`, so no user-controlled text reaches a shell. No secrets appear in any
artifact or evidence file.

## Follow-ups

- Extend the Planner agent's `argument-hint` (delivery-planner.agent.md L4) to mention
  `initiative:<initiative-slug>/<feature-slug>` so direct agent invocation matches the
  `/new-feature` prompt hint.
- Add the `/next-feature` empty-argument list-mode behaviour to docs/commands.md and
  README's command reference (currently only the prompt body describes it).
- First real use of the `/ship` changelog stamp is shipping this feature; the roadmap
  `## Follow-ups` note carries the exact manual replacement for the primary window's
  pre-stamp prompt. Confirm after PR #12 merges that `## 0.3.0 (<date>)` landed in the
  `status: complete` commit.
