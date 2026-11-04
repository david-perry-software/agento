## 7. Git rules

- Never commit or push to `main`; work branches and pull requests only. Never
  force-push, rebase or amend pushed history, or bypass hooks or rulesets
  (`--no-verify`, `--admin`).
- Integrate `origin/main` by merge — never rebase — before every push and before
  setting `status: in-review`; conflict recipes are in
  concurrent-delivery.instructions.md. In companion mode integrate both defaults:
  the product's `origin/main` into the product branch and the companion's
  `origin/<default>` into the mirrored companion branch (`git -C <companion.path>
  merge origin/<default>`).
- Commit each roadmap step together with its roadmap.md update, as a Conventional
  Commit. Small, frequent, integrated, pushed commits are the pause/resume mechanism.
  **Two-commit rule (companion mode):** a step is one code commit in the product half
  and one artifact commit (roadmap tick, evidence, plan/review edits) in the companion
  half, both Conventional Commits naming the step, pushed product first then
  companion; the companion half must end every step with `dirty: false`, `ahead: 0`
  in the session record. Both repositories carry the same branch name and each has
  its own draft PR (`artifact-pr:` in the roadmap header names the companion's).
- Only the user's /agento ship marks a PR ready or merges it; Builder, Reviewer, and Autopilot
  never do.
- Keep unrelated changes out; record unrelated problems as Follow-ups in roadmap.md
  instead of fixing them.
- **Clean handoff.** At every handoff — Builder completion, Builder pause or session
  break, Reviewer verdict — `git status --porcelain --untracked-files=all` prints
  nothing in the product worktree and, in companion mode, in the companion half.
  Byproducts written outside their sink (test output, stray screenshots): delete
  them, never commit them. Evidence is committed under the slug's `evidence/`. A
  byproduct that keeps coming back means fixing its producer (route the output to
  its sink) and recording a Follow-up; `.gitignore` is reserved for genuinely
  generated artifacts.

