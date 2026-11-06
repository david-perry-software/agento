// The `brief` subcommand: everything a command start needs in one host-approved
// bash call, under a 7 KB per-page budget. It reuses the `preflightDocument`
// builder (same receipt, window verdict, doctor, and resolve), reads the command
// and agent bodies, and hands the blocks to `scripts/lib/brief.mjs` for
// deterministic pagination. The router form (a subagent-dispatched command without
// `--as-subagent`) prints only the `Dispatch:` block and runs no preflight.

import fs from "node:fs";
import path from "node:path";

import { agit, emit, emitRaw, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import { preflightDocument } from "../lib/preflight.mjs";
import { BRIEF_BUDGET, dispatchMode, paginateBrief } from "../lib/brief.mjs";
import { currentStep } from "../delivery-roadmap-resolver.mjs";
import { policySections } from "../lib/policy.mjs";
import { currentWindowRole, loadProfiles, loadRoles, modelsPins, modelsState, rolePins, secondaryProfileLookup } from "../lib/models.mjs";
import { roleBucket } from "../model-profiles.mjs";
import { requireSlug, requireType } from "../lib/resolve.mjs";
import { header } from "../lib/records.mjs";
import { SLUG_COMMANDS } from "../session-state.mjs";

const commandsDir = () => path.join(PLUGIN_ROOT, "skills", "agento", "commands");
const cliPath = () => `node ${path.join(PLUGIN_ROOT, "scripts", "agento.mjs")}`;

function commandNames() {
  return fs
    .readdirSync(commandsDir())
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

// The command file's frontmatter is a flat `key: value` block.
function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: match[2] };
}

function parseFrontmatter(raw) {
  const meta = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

function agentFileByName(name) {
  const dir = path.join(PLUGIN_ROOT, ".github", "agents");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".agent.md"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const match = text.match(/^name:\s*(.+)$/m);
    if (match && match[1].trim().replace(/^["']|["']$/g, "") === name) return path.join(dir, file);
  }
  return null;
}

// The `models pins` computation, run exactly as `models pins` runs it (no --role):
// the secondary role profile in plan/build/freehand windows, else the clone's file
// pins.
function computePins() {
  const loaded = loadProfiles();
  const loadedRoles = loadRoles();
  const state = modelsState(PLUGIN_ROOT, loaded);
  const role = roleBucket(currentWindowRole());
  const { profile, source } = secondaryProfileLookup(loaded, loadedRoles, state, role);
  return source === "role-profile" ? rolePins(PLUGIN_ROOT, loaded, state, profile) : modelsPins(PLUGIN_ROOT, loaded.copilotModels);
}

const IMPLIED_TYPE = {
  "build-feature": "feature",
  "build-issue": "issue",
  "review-feature": "feature",
  "review-issue": "issue",
};

// Maps a command + argument to the `{ type, slug }` preflight needs. Only the
// commands that pass their argument to preflight as a slug take one; every other
// command runs preflight without a slug (free text is never validated as a slug).
function briefArgs(command, argument) {
  if (!SLUG_COMMANDS.has(command)) return { command, type: null, slug: null };
  const tokens = (argument ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { command, type: IMPLIED_TYPE[command] ?? null, slug: null };
  if (tokens.length > 2) usage(`brief ${command}: too many arguments ${JSON.stringify(argument ?? "")}`);
  if (tokens.length === 2) return { command, type: requireType(tokens[0]), slug: requireSlug(tokens[1]) };
  const typed = tokens[0].match(/^(feature|issue)\/(.*)$/);
  if (typed) return { command, type: typed[1], slug: requireSlug(typed[2]) };
  return { command, type: IMPLIED_TYPE[command] ?? null, slug: requireSlug(tokens[0]) };
}

function declaredPolicySections(body) {
  const line = body.split(/\r?\n/).find((l) => /^Policy: /.test(l));
  if (!line) return [];
  return [...new Set([...line.matchAll(/§(\d+)/g)].map((m) => m[1]))];
}

function roadmapContent(resolve) {
  if (!resolve || resolve.status !== "ok") return null;
  if (resolve.source === "local") {
    // In-repo layouts resolve to an absolute path; companion layouts to a
    // repository-relative path under `artifactsRoot`.
    const file = path.isAbsolute(resolve.path) ? resolve.path : path.join(resolve.artifactsRoot, resolve.path);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  }
  return agit("show", `origin/${resolve.branch}:${resolve.path}`) || null;
}

function deliveryDocument(resolve) {
  if (!resolve) return null;
  if (resolve.status !== "ok") return { status: resolve.status, message: resolve.message ?? null, header: null, ticked: 0, total: 0, currentStep: null, artifactDir: null };
  const content = roadmapContent(resolve);
  if (!content) return { status: "missing", message: "roadmap resolved but its content could not be read", header: null, ticked: 0, total: 0, currentStep: null, artifactDir: path.posix.dirname(resolve.path) };
  const steps = [...content.matchAll(/^- \[( |x)\] \d+\.\d+/gm)];
  return {
    status: "ok",
    message: null,
    content,
    header: {
      status: header(content, "status"),
      branch: header(content, "branch"),
      lastUpdated: header(content, "last-updated"),
      nextStep: header(content, "next-step"),
      initiative: header(content, "initiative") || null,
      artifactPr: header(content, "artifact-pr") || null,
    },
    ticked: steps.filter((m) => m[1] === "x").length,
    total: steps.length,
    currentStep: currentStep(content),
    artifactDir: path.posix.dirname(resolve.path),
  };
}

function sessionBlock(preflight) {
  const s = preflight.session;
  const lines = ["Session:", `- role: ${s.role}`, `- worktree: ${s.worktree.path} (branch ${s.worktree.branch})`];
  if (s.companion) lines.push(`- companion: ${s.companion.path} (branch ${s.companion.branch})`);
  if (s.lifecycle) lines.push(`- lifecycle: ${s.lifecycle}`);
  lines.push(`- CLI: ${cliPath()}`);
  return lines.join("\n");
}

function deliveryBlock(doc) {
  if (!doc) return null;
  if (doc.status !== "ok") return `Delivery: ${doc.status}${doc.message ? ` — ${doc.message}` : ""}`;
  const lines = [
    "Delivery:",
    `- artifact dir: ${doc.artifactDir}`,
    `- status: ${doc.header.status}`,
    `- branch: ${doc.header.branch}`,
    `- steps: ${doc.ticked}/${doc.total}`,
  ];
  lines.push(doc.currentStep ? `- current step:\n\n${doc.currentStep.line}` : "- current step: none");
  return lines.join("\n");
}

function dispatchBlock(name, argument, agent, pin) {
  const invocation = `/agento ${name}${argument ? ` ${argument}` : ""}`;
  const briefCall = `${cliPath()} brief ${name}${argument ? ` ${argument}` : ""} --as-subagent`;
  const prompt =
    `Run \`${invocation}\`: open with \`${briefCall}\`, print its receipt and ` +
    "`Preflight:` lines verbatim, and read every `More:` page before the first step.";
  const lines = [`Dispatch: ${agent}`];
  if (pin) {
    lines.push(`copilotModel: ${pin.copilotModel ?? "null"}`);
    lines.push(`subagentModel: ${pin.subagentModel ?? "null"}`);
  }
  lines.push(`Prompt: ${prompt}`);
  return lines.join("\n");
}

function blocksFor(preflight, name, argument, commandBody, agent, agentBody) {
  const blocks = [
    { kind: "receipt", id: "receipt", text: [preflight.receipt, ...preflight.preflightLines].join("\n") },
    { kind: "session", id: "session", text: sessionBlock(preflight) },
  ];
  const delivery = preflight.resolve ? deliveryDocument(preflight.resolve) : null;
  if (delivery) blocks.push({ kind: "delivery", id: "delivery", text: deliveryBlock(delivery) });
  blocks.push({ kind: "command", id: "command", text: commandBody });
  if (agentBody) blocks.push({ kind: "agent", id: "agent", text: agentBody });
  const declared = new Set(declaredPolicySections(commandBody));
  for (const section of policySections(PLUGIN_ROOT)) {
    if (declared.has(section.n)) {
      blocks.push({ kind: "policy", id: section.n, title: section.title, bytes: section.bytes, text: section.raw });
    }
  }
  return { blocks, delivery };
}

export const commands = {
  brief() {
    const name = rest[0];
    const known = commandNames();
    if (!name) usage(`brief needs a command; known: ${known.map((n) => `/agento ${n}`).join(", ")}`);
    if (!known.includes(name)) {
      usage(`brief: unknown command ${JSON.stringify(name)}; known: ${known.map((n) => `/agento ${n}`).join(", ")}`);
    }
    const argument = rest.slice(1).join(" ") || null;

    const file = path.join(commandsDir(), `${name}.md`);
    const { frontmatter, body } = splitFrontmatter(fs.readFileSync(file, "utf8"));
    const meta = parseFrontmatter(frontmatter);
    const agent = meta.agent && meta.agent !== "agent" ? meta.agent : null;
    const mode = dispatchMode(agent);

    // Router form for a subagent-dispatched command: only the Dispatch block, no
    // preflight, no receipt — the subagent owns §9.
    if (mode === "subagent" && !options.asSubagent) {
      const pins = computePins();
      const alias = Object.keys(pins).find((a) => pins[a].name === agent);
      emitRaw(`${dispatchBlock(name, argument, agent, alias ? pins[alias] : null)}\n`, 0);
    }

    const { type, slug } = briefArgs(name, argument);
    const preflight = preflightDocument({ command: name, type, slug });

    if (preflight.status !== "ok") {
      if (options.json) emit({ status: preflight.status, command: name, dispatch: mode, opId: preflight.opId, receipt: preflight.receipt, preflightLines: preflight.preflightLines, window: preflight.window }, 3);
      emitRaw(`${preflight.receipt}\n`, 3);
    }

    const agentBody = mode === "inline-as-agent" ? splitFrontmatter(fs.readFileSync(agentFileByName(agent), "utf8")).body : null;
    const { blocks, delivery } = blocksFor(preflight, name, argument, body, agent, agentBody);
    const pageCommand = `${cliPath()} brief ${name}${argument ? ` ${argument}` : ""}`;

    // The one-line `Brief page N/M for <opId>` header is printed above every
    // `--page` read, so the content budget leaves room for it: the page as
    // printed stays ≤ BRIEF_BUDGET.
    const result = paginateBrief({ blocks, budget: BRIEF_BUDGET - 256, pageCommand, agent });

    if (options.json) {
      emit({
        status: preflight.status,
        command: name,
        dispatch: mode,
        opId: preflight.opId,
        receipt: preflight.receipt,
        preflightLines: preflight.preflightLines,
        session: preflight.session,
        delivery: delivery
          ? delivery.status === "ok"
            ? { status: "ok", header: delivery.header, ticked: delivery.ticked, total: delivery.total, currentStep: delivery.currentStep }
            : { status: delivery.status, message: delivery.message, header: null, ticked: 0, total: 0, currentStep: null }
          : null,
        blocks: blocks.map((b) => ({
          kind: b.kind,
          id: b.id,
          bytes: Buffer.byteLength(b.text, "utf8"),
          page: result.placement.get(b.id) ?? null,
        })),
        pages: result.pages.length,
        onDemand: result.onDemand,
      });
    }

    if (options.page !== undefined) {
      if (options.page > result.pages.length) usage(`brief ${name}: --page ${options.page} out of range (1..${result.pages.length})`);
      emitRaw(`Brief page ${options.page}/${result.pages.length} for ${preflight.opId}\n\n${result.pages[options.page - 1]}\n`, 0);
    }
    emitRaw(`${result.pages[0]}\n`, 0);
  },
};
