#!/usr/bin/env node
// Agento CLI: the deterministic half of the delivery workflow. Prompts call this
// instead of re-deriving slug resolution, status listings, and config lookups in
// prose. Always prints one JSON document; exit 0 when the result is usable, 1 on a
// usage error, 3 when the resolution itself failed (conflict, mismatch, missing).
//
//   node scripts/agento.mjs config
//   node scripts/agento.mjs resolve <feature|issue> <slug>
//   node scripts/agento.mjs find <slug>                 (type-agnostic)
//   node scripts/agento.mjs status [feature|issue] [slug] [--pr]   (--pr adds pr + companionPr per non-complete item)
//   node scripts/agento.mjs close-decision <feature|issue> <slug>
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug> [--pr]   (+ ownerTree { tracked, untracked, ahead } and companionTree { tracked, untracked }, null when absent; --pr adds pr + companionPr + warnings; companion PR gaps join companionGaps)
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>   (+ worktreeState { onDisk, registeredIn, origin, expectedOrigin, ok }; + companion half and .code-workspace in companion mode, with companion.state likewise)
//   node scripts/agento.mjs workspace <feature|issue|plan|freehand> <slug|session-id> [--write]   (pair workspace file status; write the canonical document with --write)
//   node scripts/agento.mjs start-session [<feature|issue>/<slug> | <session-id>] [--resume] [--no-open]   (window check, doctor, fetch, worktree pair, post-add check, workspace file, code --new-window)
//   node scripts/agento.mjs close-session <feature|issue>/<slug> | changes/<slug> | <session-id> [--dry-run] [--ignore-occupants]   (window check, fetch --prune, close decision, clean/pushed checks, occupant gate, remove pair + workspace file, delete merged local branches)
//   node scripts/agento.mjs ship <feature|issue> <slug> [--confirm <token>] [--wait N]   (audit → --confirm → ready, checks, merge, companion merge, sync, release wait, teardown, epilogue; resumes from git + GitHub state; exit 0 ok, 2 pending, 3 rejected/blocked/failed)
//   node scripts/agento.mjs sync <feature|issue> <slug>   (build window: fetch both halves, merge origin/<branch> then origin/<default> where not ancestors — never rebase; a conflict aborts with its files, nothing pushed; push halves left ahead, product first; merged: true → re-verify; exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs step-commit <feature|issue> <slug> [--step N.M] --message-file <file|->   (build window: product commit, then the companion tick scoped to the slug dir; roadmap rule; integrate both defaults — exit 2 reverify when one merged; push product then companion; open missing draft PRs; end clean with ahead 0)
//   node scripts/agento.mjs plan-publish <feature|issue> <slug>   (planning window on the roadmap branch: commit the slug dir (docs(delivery|<type>): plan, or revise plan); companion mode opens the product branch with one empty commit; integrate, push product then companion, open the draft PRs, cross-link, artifact-pr:; never readies or merges; exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs review-publish <feature|issue> <slug> [--body-file <file|->]   (build window: review.md with one Verdict: line; commit docs(<type>): review <slug> — <verdict> in the artifact half; merge origin/<branch> everywhere and origin/<default> in the companion half only; push; upsert one marked verdict comment on the code PR (REST list + PATCH/POST); exit 0 ok, 3 rejected/failed)
//   node scripts/agento.mjs publish-pr [--dir <path>] [--branch <name>] [--title <text>] [--body-file <file|->] [--merge] [--wait N]   (a changes branch of the product or companion checkout at --dir: refuses the default branch, a detached HEAD, and the feature/issue/post-ship prefixes; push → non-draft PR → (--merge) bounded check wait, merge origin/<default> when BEHIND, gh pr merge --merge, delete the remote branch, sync the default (a linked worktree stays on its branch); resumes from git + GitHub state; exit 0 ok, 2 pending, 3 rejected/blocked/failed)
//   node scripts/agento.mjs initiative [<slug>]
//   node scripts/agento.mjs metrics [<slug>]           (phase durations, review rounds, pauses, merge date, post-ship latency from git history; + aggregate medians)
//   node scripts/agento.mjs session [--pr]             (role, worktree, worktrees, companion, workspace, delivery, lifecycle, allowed; hosted flag; --pr adds pr + companionPr)
//   node scripts/agento.mjs windows <checkout>...      (per registered checkout: the VS Code window holding it — storage.json + code --status — open flag, and the workspace file or folder to open)
//   node scripts/agento.mjs artifacts <feature|issue> <slug>   (plan.md, roadmap.md, review.md contents from the copy status shows — the delivery's managed half or the artifacts checkout — else origin/<branch> or the local branch; exit 3 missing)
//   node scripts/agento.mjs handoff <checkout> "<command>" [--no-open]   (queue one /agento command in <agento-config>/pending-dispatch for that checkout's window, then code <target> to focus or open it; the extension there runs it)
//   node scripts/agento.mjs next [<slug>]              (the one legal transition: command, args, window, target { path, workspace }, dispatch paths)
//   node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)
//   node scripts/agento.mjs policy <N> [<N>…] | --list   (print the named ## N. sections of delivery-policy.instructions.md as raw Markdown after one header line, ascending and deduplicated; --list prints JSON { sections: [{ n, title, bytes }] }; unknown/missing sections and no args exit 1)
//   node scripts/agento.mjs preflight <command> [<type> <slug> | <slug>]   (session, window verdict, doctor --for, resolve, config, opId, receipt, preflightLines in one call; exit 0 accepted, 3 rejected)
//   node scripts/agento.mjs brief <command> [<argument>] [--as-subagent] [--page N] [--json]   (one-call command start: receipt + Preflight lines, session, delivery (roadmap header, ticked/total, current step), command body, agent body, policy sections in the role's priority order, and a More:/On demand: footer, all within 7 KB per page; the router form prints only the Dispatch: block for subagent commands; exit 0 ok, 1 usage/unknown command, 3 rejected)
//   node scripts/agento.mjs dashboard [--pr] [--plugin-root <dir>]   (session, doctor, deliveries (= status), initiatives { list, details }, metrics and timings in one document; a failing section is { status: "error", message })
//   node scripts/agento.mjs stalls                      (the current Copilot session's stalled turns and the 24 h window: { status, generatedAt, thresholdSeconds, current, window, summary, root, configSource })
//   node scripts/agento.mjs migrate <companion-checkout> [--apply]   (move in-repo artifact roots into the companion; dry run without --apply)
//   node scripts/agento.mjs models <verb> [--plugin-root <dir>]   (model profiles in ~/.config/agento/model-profiles.json; read: list | pins [--role primary|secondary] | resolve <command> [--role primary|secondary] | show <name>; write: create <name> [--from <src>] [--description <text>] | update <name> [--dry-run] | rename <old> <new> | delete <name> [--force] | alias set <picker> <id> | alias remove <picker> | apply <name> | adopt | clear | use <name|none> --role primary|secondary | init; write verbs accept --expect <sha256> and report profilesFile.hash)
//   node scripts/agento.mjs harness <status|install|uninstall> [--plugin-root <dir>] [--force]   (create/report/remove the ~/.copilot/skills/agento link to the router skill; --force replaces a foreign or dangling link on install only)
//   node scripts/agento.mjs release <merge-sha> [--wait N] [--interval N]   (deploy-wait verdict for checks.releaseWorkflow; exit 0 done, 2 pending/dispatch-required, 3 gh/auth, 4 failed/no-run)
//
// Options: --root <dir> (default: the git toplevel of the cwd; a companion clone or
// companion half re-anchors on its product checkout).

import { command, usage } from "./lib/context.mjs";

// One module per command family (plan Approach rule 2). Each entry maps a
// subcommand name to the `scripts/commands/<file>.mjs` module that exports it as
// `commands[<name>]`. Missing and unknown commands fall through to the usage error.
const COMMAND_MODULES = {
  release: "release",
  migrate: "migrate",
  harness: "harness",
  models: "models",
  config: "resolve",
  resolve: "resolve",
  find: "resolve",
  ports: "resolve",
  status: "status",
  initiative: "status",
  metrics: "status",
  dashboard: "status",
  stalls: "status",
  policy: "doctor",
  doctor: "doctor",
  preflight: "doctor",
  brief: "brief",
  paths: "paths",
  workspace: "paths",
  windows: "paths",
  artifacts: "paths",
  handoff: "paths",
  session: "session",
  "start-session": "session",
  "close-session": "session",
  sync: "publish",
  "step-commit": "publish",
  "plan-publish": "publish",
  "review-publish": "publish",
  "publish-pr": "publish",
  "close-decision": "ship",
  "ship-preflight": "ship",
  ship: "ship",
  next: "next",
};

if (Object.hasOwn(COMMAND_MODULES, command)) {
  const handlers = await import(`./commands/${COMMAND_MODULES[command]}.mjs`);
  await handlers.commands[command]();
} else {
  usage(command ? `unknown command ${command}` : "missing command");
}
