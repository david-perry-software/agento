// Pure chat-model preselection logic. No `vscode` import: the module maps a
// `models resolve` result and a `vscode.lm` model list to a `chat.open`
// `modelSelector` (or a reason), and composes the per-value behavior of the
// opt-in `agento.chatModelPreselect` setting (`off` | `local` | `copilot`).

/** The `modelSelector` value `chat.open` honors in the chosen harness. */
export type ChatModelSelector = { vendor: string; id: string } | { id: string };

/** A `vscode.lm.selectChatModels()` entry, narrowed to what selection needs. */
export interface ChatModelEntry {
  id: string | null;
  name: string;
  vendor: string;
  family?: string;
  version?: string;
}

/** A parsed, successful `models resolve` result (a model was pinned). */
export interface ResolvedModel {
  qualified: string;
  name: string;
  vendor: string | null;
  copilotModel: string | null;
}

/** The parsed `models resolve` output: a pinned model, or a reason not to select one. */
export type ParsedResolve =
  | { kind: "resolved"; model: ResolvedModel }
  | { kind: "reason"; reason: string };

/**
 * The resolver result the dispatcher consumes.
 * - `selector` → dispatch with `options.modelSelector = selector`.
 * - `{ selector: null, reason }` → log `dispatch: no model for <command>: <reason>` and dispatch without one.
 * - `{ selector: null, off }` → log the `dispatch: model for … — preselection off` line and dispatch without one.
 */
export type ChatModelPreselect =
  | { selector: ChatModelSelector }
  | { selector: null; reason: string }
  | { selector: null; off: { qualified: string; copilotModel: string | null } };

export type ChatModelSetting = "off" | "local" | "copilot";

export type ChatModelResolver = (command: string) => Promise<ChatModelPreselect>;

const UNPARSEABLE = "unable to parse models resolve output";

function messageOf(json: Record<string, unknown>): string | null {
  return typeof json.message === "string" && json.message.length > 0 ? json.message : null;
}

/** Parses `models resolve` JSON into a pinned model or a reason. */
export function parseResolveResult(json: unknown): ParsedResolve {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { kind: "reason", reason: UNPARSEABLE };
  }
  const record = json as Record<string, unknown>;
  if (record.status === "not-found") {
    return { kind: "reason", reason: messageOf(record) ?? UNPARSEABLE };
  }
  if (record.status !== "ok") {
    return { kind: "reason", reason: messageOf(record) ?? UNPARSEABLE };
  }
  const qualified = typeof record.qualified === "string" && record.qualified.length > 0 ? record.qualified : null;
  if (qualified === null) {
    const command = typeof record.command === "string" ? record.command : "<command>";
    const role = typeof record.role === "string" ? record.role : "<role>";
    return { kind: "reason", reason: `no pin for ${command} in the ${role} role` };
  }
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : qualified;
  const vendor = typeof record.vendor === "string" && record.vendor.length > 0 ? record.vendor : null;
  const copilotModel = typeof record.copilotModel === "string" && record.copilotModel.length > 0 ? record.copilotModel : null;
  return { kind: "resolved", model: { qualified, name, vendor, copilotModel } };
}

/**
 * The `local` selector: `{ vendor, id }` from an exact vendor+name match, or a
 * unique unqualified name match. Ambiguous or missing matches are reasons, never
 * guesses. The `copilotModels` alias fallback is deliberately not used here — it
 * only applies to the `copilot` value.
 */
export function selectorFor(model: ResolvedModel, models: ChatModelEntry[]): { selector: ChatModelSelector } | { selector: null; reason: string } {
  const byId = (entry: ChatModelEntry): entry is ChatModelEntry & { id: string } =>
    typeof entry.id === "string" && entry.id.length > 0;

  if (model.vendor !== null) {
    const match = models.find(
      (entry): entry is ChatModelEntry & { id: string } => byId(entry) && entry.vendor === model.vendor && entry.name === model.name,
    );
    if (match) {
      return { selector: { vendor: match.vendor, id: match.id } };
    }
    return { selector: null, reason: `no installed model matches ${model.qualified}` };
  }

  const matches = models.filter((entry): entry is ChatModelEntry & { id: string } => byId(entry) && entry.name === model.name);
  if (matches.length === 1) {
    return { selector: { vendor: matches[0]!.vendor, id: matches[0]!.id } };
  }
  if (matches.length > 1) {
    return { selector: null, reason: `ambiguous model name ${model.name}: it matches ${matches.length} vendors — pin a qualified "<name> (<vendor>)" value` };
  }
  return { selector: null, reason: `no installed model matches ${model.name}` };
}

/**
 * The `copilot` selector: `{ id: <copilotModel> }`, no `vscode.lm` lookup. A null
 * `copilotModel` is a reason naming the alias verb that sets one.
 */
export function selectorForCopilot(model: ResolvedModel): { selector: ChatModelSelector } | { selector: null; reason: string } {
  if (model.copilotModel !== null) {
    return { selector: { id: model.copilotModel } };
  }
  return {
    selector: null,
    reason: `no Copilot id for ${model.qualified}; set one with agento.mjs models alias set <picker> <id>`,
  };
}

/** Normalizes a raw configuration value to the three valid settings. */
export function chatModelSetting(value: unknown): ChatModelSetting {
  return value === "local" || value === "copilot" ? value : "off";
}

/**
 * The per-value preselection rule. A resolve that produced no model (unpinned,
 * not-found, unparseable) always falls through to the Q3 `no model` reason; a
 * pinned model then routes by setting: `local` → exact `vscode.lm` match,
 * `copilot` → the Copilot id, `off` → the `off` shape (no selector).
 */
export function preselectFor(
  setting: ChatModelSetting,
  resolved: ParsedResolve,
  models: ChatModelEntry[],
): ChatModelPreselect {
  if (resolved.kind === "reason") {
    return { selector: null, reason: resolved.reason };
  }
  const model = resolved.model;
  switch (setting) {
    case "local":
      return selectorFor(model, models);
    case "copilot":
      return selectorForCopilot(model);
    default:
      return { selector: null, off: { qualified: model.qualified, copilotModel: model.copilotModel } };
  }
}
