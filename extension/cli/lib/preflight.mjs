// The preflight document builders — the §9 operation ID, argument parsing, the
// receipt and preflight lines, and the preflight document itself — shared by the
// `preflight` command and by `brief` (which runs preflight in process).

import { WINDOW_ROLES, windowVerdict } from "../session-state.mjs";
import { config, git, options, rest, root, source, usage } from "./context.mjs";
import { capabilityOf, COMMAND_NEEDS, doctorDocument } from "./doctor.mjs";
import { configDocument, requireSlug, requireType, resolveDocument } from "./resolve.mjs";
import { sessionRecord } from "./session.mjs";

// §9 operation ID `<command>:<subject>:<short-sha>`: the slug when one was passed;
// else the managed session id; else the branch; else, detached and unmanaged, HEAD.
function opIdFor(command, slug, worktree) {
  const subject = slug ?? (worktree.isManaged && worktree.dirPrefix && worktree.id ? `${worktree.dirPrefix}-${worktree.id}` : !worktree.detached && worktree.branch ? worktree.branch : "HEAD");
  const sha = git(root, "rev-parse", "--short", "HEAD") || "HEAD";
  return { subject, opId: `${command}:${subject}:${sha}` };
}

function preflightArgs() {
  const command = rest[0];
  if (!command) usage(`preflight needs a command; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
  if (!COMMAND_NEEDS[command]) usage(`preflight: unknown command ${command}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
  const args = rest.slice(1);
  if (args.length > 2) usage(`preflight takes <command> [<type> <slug> | <type>/<slug> | <slug>], got ${JSON.stringify(rest.join(" "))}`);
  if (args.length === 2) return { command, type: requireType(args[0]), slug: requireSlug(args[1]), full: Boolean(options.full) };
  const typed = args[0]?.match(/^(feature|issue)\/(.*)$/);
  if (typed) return { command, type: typed[1], slug: requireSlug(typed[2]), full: Boolean(options.full) };
  return { command, type: null, slug: args[0] ? requireSlug(args[0]) : null, full: Boolean(options.full) };
}

// The §9 receipt and preflight lines, spelled exactly as the policy does.
function receiptLines({ opId, window, doctor }) {
  if (!window.match) {
    const alternatives = [...window.allowed, ...window.elsewhere.map((e) => `${e.command} (${e.window} window)`)];
    return { status: "rejected", receipt: `Receipt: rejected — ${window.reason}; allowed: ${alternatives.length ? alternatives.join(", ") : "none"}`, preflightLines: [] };
  }
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) return { status: "rejected", receipt: `Receipt: rejected — ${capabilityOf(failed.id)}: ${failed.detail}; fallback: ${failed.fallback}`, preflightLines: [] };
  const preflightLines = doctor.checks.filter((c) => c.status === "warn").map((c) => `Preflight: ${capabilityOf(c.id)} warn — ${c.fallback}`);
  return { status: "ok", receipt: `Receipt: accepted ${opId}`, preflightLines };
}

// What `preflight <command> [<type> <slug>]` emits: the session record, the §11
// window verdict, `doctor --for <command>`, the slug's resolution (null without a
// slug), the config document, and the §9 op-id, receipt, and preflight lines.
// `--full` is that document unchanged; the default is the brief document (the
// fields commands actually read), which drops `session.worktrees`, `session.allowed`,
// `session.elsewhere`, `config`, `root`, `configSource`, and `doctor.checks`.
function preflightDocument({ command, type, slug, full = false }) {
  const session = sessionRecord();
  const rule = WINDOW_ROLES[command];
  const clean = rule.clean ? git(session.worktree.path, "status", "--porcelain") === "" : true;
  const window = windowVerdict({ command, record: session, slug, clean, defaultBranch: config.branches.default });
  const doctor = doctorDocument(command);
  const { subject, opId } = opIdFor(command, slug, session.worktree);
  const { status, receipt, preflightLines } = receiptLines({ opId, window, doctor });
  if (full) {
    return {
      status,
      command,
      opId,
      subject,
      receipt,
      preflightLines,
      session,
      window,
      doctor,
      resolve: slug ? resolveDocument(type, slug) : null,
      config: configDocument(),
      root,
      configSource: source,
    };
  }
  const { role, hosted, worktree, companion, workspace, delivery, pr, companionPr, lifecycle, warnings } = session;
  return {
    status,
    command,
    opId,
    subject,
    receipt,
    preflightLines,
    window: {
      role: window.role,
      required: window.required,
      match: window.match,
      reason: window.reason,
      allowed: window.allowed,
      elsewhere: window.elsewhere,
      ...(window.role === "unmanaged" ? { primary: session.worktrees[0]?.path ?? root } : {}),
    },
    session: { role, hosted, worktree, companion, workspace, delivery, pr, companionPr, lifecycle, warnings },
    doctor: { status: doctor.status, for: doctor.for, failing: doctor.checks.filter((c) => c.status !== "ok") },
    ...(slug ? { resolve: resolveDocument(type, slug) } : {}),
  };
}

export { opIdFor, preflightArgs, receiptLines, preflightDocument };
