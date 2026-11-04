## 8. Cross-window handoff

Build and review happen in the secondary (worktree) window — in companion mode
(`artifacts.repo` set) that is the pair's `<kind>-<id>.code-workspace` window holding
the product half and its companion half; close and ship happen in the primary window. Every Builder completion, Reviewer verdict, and Autopilot stop ends
with the exact commands:

1. In this window: `/agento review-feature <slug>` or `/agento review-issue <slug>` after a build
   completes; the Builder fix handoff after `Verdict: request-changes`.
2. After `Verdict: approve`, switch to the primary workspace window and run
   `/agento ship <slug>`; it audits while this worktree is still open, sends you
   back here on a rejected audit, and tears the worktree down once the PR is merged.
   Standalone `/agento close-session <type>/<slug>` is for plan and freehand
   sessions and for abandoning a build.

`/agento continue [slug]` derives the same handoff command from the session record
(`agento.mjs next`) and performs it; it may be named alongside the explicit command in
these hand-offs. Never substitute raw git or worktree commands for these workflow
commands.

