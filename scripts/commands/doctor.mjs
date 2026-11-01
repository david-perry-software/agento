// The `policy`, `doctor`, and `preflight` subcommands and their document
// builders, moved unchanged from the legacy switch in `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { WINDOW_ROLES, windowVerdict } from "../session-state.mjs";
import { config, emit, emitRaw, git, options, PLUGIN_ROOT, rest, root, source, usage } from "../lib/context.mjs";
import { capabilityOf, COMMAND_NEEDS, doctorDocument } from "../lib/doctor.mjs";
import { configDocument, requireSlug, requireType, resolveDocument } from "../lib/resolve.mjs";
import { sessionRecord } from "../lib/session.mjs";

// Parses `<root>/.github/instructions/delivery-policy.instructions.md` into its
// `## N.` sections. Each entry carries the section number (the heading's digits),
// the heading title, the section's byte length, and its raw Markdown (heading line
// through the line before the next heading, or EOF for the last section).
function policySections(root) {
  const file = path.join(root, ".github", "instructions", "delivery-policy.instructions.md");
  const text = fs.readFileSync(file, "utf8");
  const heading = /^## (\d+)\. (.+)$/gm;
  const starts = [];
  let match;
  while ((match = heading.exec(text)) !== null) {
    starts.push({ n: match[1], title: match[2].trim(), offset: match.index });
  }
  return starts.map((section, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].offset : text.length;
    const raw = text.slice(section.offset, end);
    return { n: section.n, title: section.title, bytes: Buffer.byteLength(raw, "utf8"), raw };
  });
}

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

export const commands = {
  policy() {
    const sections = policySections(PLUGIN_ROOT);
    if (options.list) {
      if (rest.length) usage(`policy --list takes no section arguments, got ${JSON.stringify(rest.join(" "))}`);
      emit({ sections: sections.map(({ n, title, bytes }) => ({ n, title, bytes })) });
      return;
    }
    if (rest.length === 0) usage("policy requires one or more section numbers, or --list");
    const byN = new Map(sections.map((section) => [section.n, section]));
    const requested = [];
    for (const arg of rest) {
      if (!/^\d+$/.test(arg)) usage(`policy: unknown section ${JSON.stringify(arg)}`);
      if (!byN.has(arg)) usage(`policy: no such section ${JSON.stringify(arg)}`);
      if (!requested.includes(arg)) requested.push(arg);
    }
    requested.sort((a, b) => Number(a) - Number(b));
    const header = `# delivery-policy.instructions.md — sections ${requested.join(", ")}\n`;
    emitRaw(header + "\n" + requested.map((n) => byN.get(n).raw).join(""));
  },
  doctor() {
    if (rest.length) usage(`doctor takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    if (options.for && !COMMAND_NEEDS[options.for]) usage(`--for: unknown command ${options.for}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
    const document = doctorDocument(options.for ?? null);
    // warn is usable (exit 0); only a failed hard requirement is a resolution failure (exit 3).
    emit(document, document.status === "fail" ? 3 : 0);
  },
  preflight() {
    const document = preflightDocument(preflightArgs());
    emit(document, document.status === "ok" ? 0 : 3);
  },
};
