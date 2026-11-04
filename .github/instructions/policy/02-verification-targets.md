## 2. Verification targets

Every user-visible or deployed behavior is verified **before review**, by the agent,
against the target the roadmap step's `verify:` line names:

- `local:<ports>` (default) — the branch served locally on per-slug ports
  (`agento.mjs ports <slug>`). Needs no platform allowlist edits.
- `dev-stack` — the project's documented full local stack for auth/DB-backed flows.
  Its fixed ports make it exclusive: confirm no other session has it up, and say so.
- `preview: <reason>` — a deployed branch preview, only when the behavior depends on
  the deployed platform itself (build/env wiring, edge/ISR/middleware, backend
  integration, the release path). Convenience is not a reason. Resolve your own
  branch's preview, never another slug's; follow AGENTS.md for platform setup, record
  it on the step, undo it at ship.

Planners write the target; Builders and Reviewers never upgrade a local step to a
preview on their own. If a step requires a preview and none exists, the plan includes
the preview-enablement work — or the user explicitly accepts a post-ship exception
(§4). Never silently defer. The Reviewer re-drives the target independently and
captures its own screenshot rather than trusting the Builder's evidence alone.

