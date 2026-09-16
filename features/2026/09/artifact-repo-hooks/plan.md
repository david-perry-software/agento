# Artifact repository hooks: companion-aware SessionStart context and delivery guard

## Problem

Both Agento hooks assume the delivery artifacts live inside the product checkout.
[scripts/hooks/session-context.sh](../../../../scripts/hooks/session-context.sh)
walks `<toplevel>/features` and `<toplevel>/issues` for `Delivery work:` lines, and
[scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh)
`agento_config()` reads only `artifacts.{features,issues}` and `branches.*`, protects
one default branch (that of the repo the command targets), and asks on every
delivery-branch commit whose files contain no `roadmap.md`. Once `artifacts.repo` is
set (wave 1, [artifact-repo-config](../artifact-repo-config/plan.md), `status:
complete`), the CLI reads roadmaps from the sibling companion checkout, but the hooks
do not: SessionStart reports "No in-progress delivery work" while roadmaps sit in
`../<name>/features/`, the companion's default branch is protected only by the
hard-coded defaults, and the roadmap nudge fires on *every* product commit because
the roadmap can never be in that repo.

This feature is the wave‑2 member **`artifact-repo-hooks`** of the initiative
[external-artifact-repo](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md)
(`### artifact-repo-hooks` block): both hooks read `artifacts.repo`, SessionStart
lists resumable work from the companion and names it on an `Artifacts:` line, and
the guard protects the companion's default branch and re-targets the roadmap nudge to
the companion checkout. With `artifacts.repo` unset both hooks emit today's output
verbatim.

## Decisions

Clarifying questions were asked as a numbered list in chat (ask-questions tool
unavailable, policy §10 fallback). The user's reply, verbatim: **"defaults"**. The
Planner read that as the default option named in each question and records the
resulting choices:

- **Q1 — How is "recently committed roadmap.md" defined for the companion-mode
  roadmap nudge?** Default taken: the breakdown's literal rule — on a product
  delivery-branch commit, look at the companion checkout for that branch; do **not**
  ask when the companion index has a staged `roadmap.md` **or** the companion `HEAD`
  commit touches a `roadmap.md`; otherwise ask with a reason naming the companion
  path. Never ask merely because the product commit lacks a `roadmap.md`. A commit
  run directly in the companion (`git -C <companion> commit …` on a delivery branch)
  keeps today's rule (roadmap among the files the commit records).
- **Q2 — Which config governs a `git -C <companion>` command?** Default taken: agree
  with the proposal — the guard also loads the config of the hook `cwd`'s repository
  (the product checkout); when that config sets `artifacts.repo` and the command's
  target toplevel equals the resolved companion path, the product config's
  `branches.*` apply to the companion (default branch, `feature/`/`issue/` prefixes).
  A companion that carries its own `.github/agento.json` is not a supported layout.
- **Q3 — Python reimplementation or shell out to the CLI for the companion path?**
  Default taken: reimplement `resolveArtifactsRoot` in Python inside both hooks
  (`name`/`dir` → absolute path relative to the **primary** checkout, the first
  `git worktree list --porcelain` entry, using the primary's config when it differs),
  so the no‑node fallback of `session-context.sh` stays byte-for-byte. Line shape:
  `Artifacts: <absolute companion path> (branch <name|detached>)`, printed directly
  after the `Session:` line (or after `Agento CLI:` when no `Session:` line) and only
  when `artifacts.repo` is set.
- **Q4 — Companion worktree path in the `git worktree remove` occupant check?**
  Default taken: (a) defer — paired companion worktrees and their path convention
  belong to `paired-artifact-worktrees`; recorded under `## Out of scope` and as a
  roadmap Follow-up so that member picks it up.
- **Q5 — Stale in-repo roots with `artifacts.repo` set?** Default taken: same as the
  CLI (artifact-repo-config Decision 4) — the product repo's `features/`/`issues/`
  are ignored; only the companion is walked. `doctor` already warns about them.

Planner's derived decisions (no user question needed):

- The companion's default branch is `config.branches.default` of the product config,
  as `artifact-repo-config` and `artifact-repo-init` already assume.
- Which companion branch the nudge inspects: the companion checkout as it is (its
  current index and `HEAD`), not a branch lookup by name — paired worktrees (wave 2,
  `paired-artifact-worktrees`) are what put the companion on the mirrored branch;
  until then the single clone `../<name>` is inspected. The reason text names the
  companion path and its current branch so a mismatch is visible to the user.
- Guard config discovery is a two-step read: `target_dir()` config (today) plus the
  hook‑cwd repository's config when it differs. Companion protection is derived from
  the product config only; the guard never reads a config from inside the companion.
- Replay fixtures for companion mode live in a second fixture file,
  `tests/guard-fixtures-companion.txt`, run by `replay-guard.sh` with a
  `REPLAY_COMPANION=1` mode that creates a sibling companion repo and substitutes the
  literal token `{companion}` in each command with its absolute path. The existing
  fixture file and default mode are unchanged.

## Research

Skills consulted: none — no matching domain (`.agents/skills/**/SKILL.md` returns
nothing; AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `311e8d7`:

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests
  153`, `# pass 153`, `# fail 0`.
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.

Green baseline → no overlap decision, no scoped gate: the Builder reruns the **full**
baseline (all three commands, plus the new companion replay) at every step that
touches `scripts/`, and the Reviewer compares against 153/153/0, shellcheck silent,
replay exit 0. Builder notes: (1) the guard denies output redirections that name
`scripts/hooks/*` — run shellcheck without `> file`; (2) every edit to
`scripts/hooks/*.sh` is approval-gated by the guard itself (`PROTECTED`,
[delivery-guard.sh L109–L112](../../../../scripts/hooks/delivery-guard.sh#L109-L112)),
so expect one `ask` per edit-tool call and keep edits few and large; (3) the guard
denies `git -C <companion> push … <default>` — companion fixtures must use temp
repos, never the real companion.

### Codebase findings (file:line as of `311e8d7`)

- **SessionStart hook.** [scripts/hooks/session-context.sh](../../../../scripts/hooks/session-context.sh):
  `cwd` from the payload (L23), `root = git rev-parse --show-toplevel` (L31),
  `session_summary()` (L35–L62) shells out to `agento.mjs session --root <cwd>` and
  returns `None` on any failure; config read (L64–L76) takes only
  `artifacts.features|issues` with `null` → default; `lines` order is `Current git
  branch:`, `Agento CLI:`, `Session:` (L78–L85); the walk (L86–L104) joins `root` with
  each base and prints `Delivery work: <relpath> [status: …] next-step: …` for
  `in-progress|paused|in-review`; fallback line L106–L107. Tests:
  [tests/session-context.test.mjs](../../../../tests/session-context.test.mjs) —
  `makeRepo({ branch, config })`, `writeRoadmap()`, `run(cwd, env)`,
  `pathWithoutNode()`; the test "falls back to the pre-feature output byte for byte
  when node is absent" (L122–L133) pins the no‑node output to the with‑node output
  minus the `Session:` line — the `Artifacts:` line must therefore be produced by
  Python, not by the CLI, so it appears identically in both runs.
- **Delivery guard.** [scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh):
  `hook_cwd` (L49); `worktree_remove_target()` + occupant scan (L51–L103);
  `PROTECTED` (L109); `target_dir()` (L214–L222) honours `git -C <path>` and a
  leading `cd <path> &&`; `git()` bound to `workdir` (L226–L230); `agento_config()`
  (L232–L255) merges `.github/agento.json` of the target toplevel over defaults
  covering `artifacts.{features,issues}` and `branches.*` only; `default_branch`,
  `feature_prefix`, `issue_prefix`, `DEFAULT`, `GIT` (L257–L262); `commit_files()`
  (L264–L289) — pathspecs, else index, plus tracked modifications on `-a`; the
  per-segment loop (L293–L342): force/no-verify/delete rules, chain-aware branch
  tracking (L322–L329), default-branch deny (L334–L337), roadmap nudge (L339–L342).
  Tests: [tests/guard.test.mjs](../../../../tests/guard.test.mjs) — `decide(command,
  { cwd, filePath, tool })`, `makeGitRepo({ config })`; nudge tests at L79–L110;
  custom default branch at L147–L160; worktree removal at L169–L172.
- **Replay harness.** [scripts/hooks/replay-guard.sh](../../../../scripts/hooks/replay-guard.sh)
  creates a throwaway repo on `feature/replay` (or `REPLAY_CWD`), reads
  `<verdict> <command>` lines, and exits 1 on a mismatch;
  [tests/guard-fixtures.txt](../../../../tests/guard-fixtures.txt) has ~100 lines.
  Commands cannot name the temp companion path today — hence the `{companion}` token
  substitution in Decision "Replay fixtures".
- **Reference implementation to mirror.** [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs)
  `resolveArtifactsRoot()` (L50–L60): both `name` and `dir` null → in-repo; `dir =
  resolve(primaryRoot, repo.dir ?? ../<name>)`; `name = repo.name ??
  basename(dir)`. [scripts/agento.mjs](../../../../scripts/agento.mjs)
  `resolveArtifacts()` (L88–L94): `primaryRoot` = first `git worktree list
  --porcelain` entry, primary's config when it differs from `root`. The `doctor`
  `artifact-repo` check (L305–L326) is the CLI-side validation the hooks do **not**
  repeat — a missing companion simply yields no `Delivery work:` lines and an
  `Artifacts:` line naming the absent path.
- **Init hand-off.** [artifact-repo-init roadmap Follow-ups](../artifact-repo-init/roadmap.md):
  init writes the companion bootstrap through the GitHub Contents API, so the guard
  needs no push exemption for the companion default branch; it "still needs to learn
  the companion checkout so delivery-branch commits there get the same roadmap
  nudge" — covered by Decision Q2.
- **Docs naming hook behaviour.** [docs/hooks.md](../../../../docs/hooks.md) L8–L19
  (SessionStart description), L35–L50 (guard rule table, incl. the roadmap-nudge and
  worktree-remove rows), L52–L55 ("artifact roots come from the target repo's
  `.github/agento.json`"); [CHANGELOG.md](../../../../CHANGELOG.md) `## Unreleased`
  (L3) already carries the wave‑1/2 entries.
- **Concurrent deliveries.** `gh pr list --state open --json number,headRefName,title`
  → `[]`. No open PRs; no overlap to sequence around. Sibling wave‑2 member
  `paired-artifact-worktrees` is unplanned; if it starts before this ships, both touch
  `scripts/hooks/*.sh` — see Risks.

## Approach

All changes are gated on `artifacts.repo` resolving to an external path; unset →
both hooks reduce to today's code paths and output.

1. **Shared Python helper (duplicated verbatim in both hooks; hooks are standalone).**
   `resolve_artifacts(product_root)` → `(external: bool, path: str|None, name)`:
   read `.github/agento.json` / `agento.json` from `primary_root` (first `git -C
   <product_root> worktree list --porcelain` `worktree ` entry, else `product_root`);
   `repo = config.artifacts.repo` with `null` → unset; both unset → `(False, None,
   None)`; else `path = abspath(join(primary_root, repo.dir or ../<name>))`, `name =
   repo.name or basename(path)`. Only run the worktree-list call when `repo` is set
   (mirrors the CLI's "no extra git call in in-repo mode").
2. **`scripts/hooks/session-context.sh`.**
   - After the config read: `external, companion, _ = resolve_artifacts(root)`. Walk
     base = `companion` when external, else `root` (product roots ignored when
     external — Decision Q5). `rel` in `Delivery work:` stays relative to the walked
     base (so paths read `features/2026/09/<slug>` exactly as today).
   - When external, append `Artifacts: <companion> (branch <git -C <companion> branch
     --show-current | detached>)` directly after the `Session:` line (or after
     `Agento CLI:` when there is none). Absent companion directory → the same line
     (branch `detached`) and the existing "No in-progress delivery work in …" line.
   - Header comment updated to name `artifacts.repo`.
3. **`scripts/hooks/delivery-guard.sh`.**
   - `agento_config()` gains `"artifacts": {…, "repo": {"name": None, "dir": None}}`
     in defaults (nested merge for `repo`), and a second read: `product_root =
     toplevel of hook_cwd`; when it differs from the target toplevel, load its config
     too. `companion = resolve_artifacts(product_root)`; `target_is_companion =
     realpath(target toplevel) == realpath(companion path)`. When
     `target_is_companion`, `config = product config` (Decision Q2) so
     `default_branch`/prefixes protect the companion.
   - Roadmap nudge (L339–L342) becomes: if `is_commit` on a delivery branch — (a)
     target is the product repo and companion is external → inspect the companion:
     `git -C <companion> diff --cached --name-only` has a `roadmap.md`, or `git -C
     <companion> show --name-only --format= HEAD` has one → allow; else `ask` with
     `"Committing delivery work while the companion <path> (branch <b>) has no staged
     or last-committed roadmap.md change; progress may be lost on resume. Proceed?"`;
     (b) otherwise (in-repo mode, or the target *is* the companion) → today's rule
     unchanged.
   - Occupant check: unchanged (Decision Q4).
4. **Replay harness and fixtures.** `replay-guard.sh`: `REPLAY_COMPANION=1` creates
   `<cwd>-docs` (`git init -b main`, empty commit, `switch -c feature/replay`), writes
   `<cwd>/.github/agento.json` = `{"artifacts":{"repo":{"dir":"../<basename>-docs"}}}`
   (committed on `feature/replay` so the product tree is clean), and replaces the
   literal `{companion}` in each command with the companion's absolute path before
   building the payload. New `tests/guard-fixtures-companion.txt` (~20 lines):
   `deny git -C {companion} push origin main`, `deny git -C {companion} commit -m x`
   after a chained `switch main`, `deny cd {companion} && git push origin HEAD:main`,
   `allow git -C {companion} push origin feature/replay`, `allow git -C {companion}
   status`, plus in-repo-mode controls. Add `./scripts/hooks/replay-guard.sh <
   tests/guard-fixtures-companion.txt` with `REPLAY_COMPANION=1` to AGENTS.md
   `## Commands` and to `tests/guard.test.mjs`' fixture-replay coverage if one exists
   (else document in docs/hooks.md).
5. **Tests.**
   - `tests/session-context.test.mjs`: `makeRepo({ companion: true })` creating
     `<base>/project` + `<base>/project-docs`; tests: companion roadmaps listed and
     product roadmaps ignored; `Artifacts:` line position and shape; unset config →
     no `Artifacts:` line and output identical to today's; no‑node fallback still
     equals with‑node minus `Session:` in companion mode; managed worktree
     (`worktrees.dir`) resolves `../project-docs` from the primary, not the worktree.
   - `tests/guard.test.mjs`: `makeGitRepo({ companion: true, config })`; tests:
     `git -C <companion> push origin trunk` denied with product `branches.default:
     trunk`; `git -C <companion> commit` on companion `trunk` denied; product
     delivery-branch commit → `ask` when companion has no roadmap change, `allow`
     when companion index stages a `roadmap.md`, `allow` when companion `HEAD` touches
     one, `ask` again after a further companion commit without one; `git -C
     <companion> commit` on a delivery branch without roadmap → `ask` (today's rule);
     in-repo mode behaviour unchanged (existing tests stay green untouched).
6. **Docs.** `docs/hooks.md`: SessionStart paragraph (`Artifacts:` line, companion
   walk), guard table rows (companion default branch; re-targeted nudge), the
   config paragraph (L52–L55), testing section (companion fixtures). `CHANGELOG.md`
   `## Unreleased` bullet. `AGENTS.md` `## Commands` gains the companion replay.

Affected files: `scripts/hooks/session-context.sh`, `scripts/hooks/delivery-guard.sh`,
`scripts/hooks/replay-guard.sh`, `tests/guard-fixtures-companion.txt` (new),
`tests/guard.test.mjs`, `tests/session-context.test.mjs`, `docs/hooks.md`,
`CHANGELOG.md`, `AGENTS.md`.

## Risks

- **Hook edits are approval-gated by the guard itself.** Every edit-tool call on
  `scripts/hooks/*.sh` returns `ask`; a Builder that batches many tiny edits will
  stall. Mitigation: one or two large edits per hook; the user approves each.
- **Nudge false negatives/positives around the companion `HEAD` heuristic.** A
  companion `HEAD` that touched a roadmap hours ago suppresses the nudge for an
  unrelated product commit. Accepted per Decision Q1 (the nudge is a slip guard, not
  enforcement — docs/hooks.md); the reason text names the companion branch so
  mismatches are visible. Revisit when `paired-artifact-worktrees` puts the companion
  on the mirrored branch.
- **Single companion clone shared by concurrent sessions (pre paired-worktrees).**
  The guard inspects whatever branch `../<name>` is on. Mitigation: the reason text
  includes the companion branch; `paired-artifact-worktrees` (Recommended after this
  member) removes the sharing.
- **Concurrent delivery on `scripts/hooks/*.sh`.** `paired-artifact-worktrees` is
  ready and may start in parallel; both edit the hooks and their tests. Mitigation:
  integrate `origin/main` by merge before every push; the initiative's
  `Recommended after: artifact-repo-hooks` on that member says it should follow this
  one — the user is advised to sequence it after this ships.
- **Guard timeout budget.** Each extra `git` call runs with a 5 s timeout; companion
  mode adds up to three (`worktree list`, `diff --cached`, `show HEAD`). Mitigation:
  only run them when `artifacts.repo` is set and only on commit segments.
- **Python duplication between hooks.** The helper is copied into both hooks (they
  are standalone scripts wired by path). Mitigation: identical function text; a
  `tests/customizations.test.mjs`-style equality check is out of scope — noted as a
  Follow-up candidate.

## Out of scope

- Adding a companion worktree path to the `git worktree remove` occupant check
  (Decision Q4) — `paired-artifact-worktrees`.
- Paired companion worktrees, mirrored branches, dual-merge ship, migration — later
  initiative members.
- A companion-local `.github/agento.json`; `doctor`-style validation of the companion
  inside the hooks (the CLI's `artifact-repo` check owns it).
- Any change to `scripts/agento.mjs`, `scripts/agento-config.mjs`, or the resolver.

## Acceptance checklist

- [ ] With `artifacts.repo` unset, `bash scripts/hooks/session-context.sh` and the
  guard produce byte-identical output to `origin/main` for every existing test — all
  pre-existing tests in `tests/session-context.test.mjs` and `tests/guard.test.mjs`
  pass unmodified; `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0.
- [ ] SessionStart in companion mode lists `Delivery work:` lines only from the
  companion checkout (product `features/`/`issues/` ignored) and prints exactly one
  `Artifacts: <abs path> (branch <name|detached>)` line directly after `Session:` —
  verified by new tests in `tests/session-context.test.mjs`.
- [ ] SessionStart no‑node fallback in companion mode equals the with‑node output minus
  the `Session:` line (the `Artifacts:` line present in both) — new test.
- [ ] From a managed worktree (`worktrees.dir` set), SessionStart resolves the companion
  relative to the primary checkout — new test.
- [ ] Guard denies `git -C <companion> push origin <default>` and a commit/merge on the
  companion's default branch using the **product** config's `branches.default`
  (tested with `trunk`); allows pushes to companion work branches — new tests and
  `tests/guard-fixtures-companion.txt` via `REPLAY_COMPANION=1
  ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` exit 0.
- [ ] Guard roadmap nudge in companion mode: product delivery-branch commit → `ask`
  (reason names the companion path and branch) when the companion has neither a staged
  nor a `HEAD`-committed `roadmap.md`; `allow` in each of the two satisfied cases;
  never asks solely because the product commit lacks `roadmap.md` — new tests.
- [ ] Guard commit directly in the companion on a delivery branch keeps today's
  rule (`ask` without roadmap among recorded files, `allow` with) — new test.
- [ ] Full lint gate equal to baseline: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` ≥ 153 pass / 0 fail; shellcheck of the four scripts silent,
  exit 0; both replay runs exit 0.
- [ ] `docs/hooks.md`, `CHANGELOG.md` `## Unreleased`, and `AGENTS.md` `## Commands`
  describe the companion behaviour and the companion replay command; `node --test
  tests/customizations.test.mjs` exit 0.
- [ ] Roadmap header carries `initiative: "external-artifact-repo"` and `node
  scripts/agento.mjs initiative external-artifact-repo` reports `artifact-repo-hooks`
  with `state` equal to the roadmap status and `errors: []`.
