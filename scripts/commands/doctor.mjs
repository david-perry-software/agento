// The `policy`, `doctor`, and `preflight` subcommands and their document
// builders, moved unchanged from the legacy switch in `scripts/agento.mjs`.

import { emit, emitRaw, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import { COMMAND_NEEDS, doctorDocument } from "../lib/doctor.mjs";
import { policySections } from "../lib/policy.mjs";
import { preflightArgs, preflightDocument } from "../lib/preflight.mjs";

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
