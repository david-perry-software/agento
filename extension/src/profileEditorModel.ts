// Pure editor model for the model-profile editor webview. No `vscode` import, so
// the profile↔form mapping, model-choice grouping, alias derivation, message
// schema, conflict diff, and rename validation are all unit-testable in isolation.

const PROFILE_NAME = /^[a-z0-9-]+$/;
const BODY_KEYS = new Set(["description", "default", "agents", "prompts"]);

// The editable form fields, shared by `ProfileForm` and the webview messages.
export interface WebviewForm {
  name: string;
  description: string;
  default: string[];
  agents: Record<string, string[]>;
  prompts: Record<string, string[]>;
}

export interface ProfileForm extends WebviewForm {
  /** Unknown top-level body keys, preserved verbatim and surfaced as a notice. */
  unknown: Record<string, unknown>;
}

export interface Pinnable {
  agents?: string[];
  prompts?: string[];
}

export interface ModelChoice {
  id: string | null;
  name: string;
  vendor: string;
  /** The qualified picker name the form stores and the CLI validates. */
  label: string;
}

export type AliasStatus =
  | { status: "existing"; id: string }
  | { status: "suggested"; id: string }
  | { status: "none" };

// --- profile ↔ form -----------------------------------------------------

function toList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function fromList(list: string[]): string | string[] | undefined {
  const entries = list.filter((entry) => entry.trim() !== "");
  if (entries.length === 0) return undefined;
  return entries.length === 1 ? entries[0] : entries;
}

function recordValues(body: unknown, key: string): Record<string, string[]> {
  const raw = (body as Record<string, unknown> | null)?.[key];
  const out: Record<string, string[]> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) out[name] = toList(value);
  return out;
}

/** The stored profile body as an editable form. A one-item value stays a
 *  one-entry list in the form and is written back as a string; unset fields are
 *  empty; unknown top-level keys are kept in `unknown`. */
export function profileToForm(body: unknown, pinnable: Pinnable): ProfileForm {
  const record = (body ?? {}) as Record<string, unknown>;
  const agents: Record<string, string[]> = {};
  for (const alias of pinnable.agents ?? []) agents[alias] = toList((record.agents as Record<string, unknown> | undefined)?.[alias]);
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!BODY_KEYS.has(key)) unknown[key] = value;
  return {
    name: "",
    description: typeof record.description === "string" ? record.description : "",
    default: toList(record.default),
    agents,
    prompts: recordValues(record, "prompts"),
    unknown,
  };
}

/** The profile body for `models update` stdin. Key order is stable:
 *  `description`, `default`, `agents` in alias order, `prompts` in insertion
 *  order, then the preserved unknown keys. Empty fields and empty entries are
 *  omitted, and a one-entry list is written as a string. */
export function formToProfile(form: ProfileForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.description.trim() !== "") body.description = form.description;
  const fallback = fromList(form.default);
  if (fallback !== undefined) body.default = fallback;

  const agents: Record<string, string | string[]> = {};
  for (const [alias, list] of Object.entries(form.agents)) {
    const value = fromList(list);
    if (value !== undefined) agents[alias] = value;
  }
  if (Object.keys(agents).length) body.agents = agents;

  const prompts: Record<string, string | string[]> = {};
  for (const [command, list] of Object.entries(form.prompts)) {
    const value = fromList(list);
    if (value !== undefined) prompts[command] = value;
  }
  if (Object.keys(prompts).length) body.prompts = prompts;

  for (const [key, value] of Object.entries(form.unknown)) body[key] = value;
  return body;
}

// --- model choices ------------------------------------------------------

/** `vscode.lm.selectChatModels()` entries → vendor-grouped, labelled, sorted,
 *  de-duplicated choices. The label is the qualified picker name. */
export function modelChoices(models: unknown): ModelChoice[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const raw of models) {
    const model = (raw ?? {}) as Record<string, unknown>;
    const name = typeof model.name === "string" ? model.name.trim() : "";
    const vendor = typeof model.vendor === "string" ? model.vendor.trim() : "";
    if (!name || !vendor) continue;
    const id = typeof model.id === "string" && model.id ? model.id : null;
    const label = `${name} (${vendor})`;
    if (seen.has(label)) continue;
    seen.add(label);
    choices.push({ id, name, vendor, label });
  }
  choices.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
  return choices;
}

// --- aliases ------------------------------------------------------------

/** The `copilotModels` id for a chosen model: the bare id for a Copilot-hosted
 *  model, the id as-is when it is already `<vendor>/<id>`, `<vendor>/<id>` for any
 *  other vendor, and null when there is no id. */
export function suggestAlias(choice: { id: string | null; vendor: string }): string | null {
  if (!choice.id) return null;
  if (choice.vendor === "copilot") return choice.id;
  if (choice.id.includes("/")) return choice.id;
  return `${choice.vendor}/${choice.id}`;
}

export function aliasStatus(value: string, copilotModels: unknown, choices: ModelChoice[]): AliasStatus {
  const aliases = (copilotModels ?? {}) as Record<string, unknown>;
  const existing = typeof aliases[value] === "string" && aliases[value] ? (aliases[value] as string) : null;
  if (existing !== null) return { status: "existing", id: existing };
  const choice = choices.find((c) => c.label === value);
  const suggested = choice ? suggestAlias(choice) : null;
  if (suggested !== null) return { status: "suggested", id: suggested };
  return { status: "none" };
}

// --- webview messages ---------------------------------------------------

export type WebviewMessage =
  | { type: "ready" }
  | { type: "change"; form: WebviewForm; dirty: boolean }
  | { type: "validate"; form: WebviewForm }
  | { type: "save"; form: WebviewForm }
  | { type: "saveAndApply"; form: WebviewForm }
  | { type: "addAlias"; value: string; id: string }
  | { type: "reload" }
  | { type: "openFile" };

export type ParsedMessage = { ok: true; message: WebviewMessage } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string[]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isStringList(entry));
}

function parseForm(value: unknown): WebviewForm | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).sort().join(",") !== "agents,default,description,name,prompts") return null;
  if (typeof value.name !== "string") return null;
  if (typeof value.description !== "string") return null;
  if (!isStringList(value.default)) return null;
  if (!isStringRecord(value.agents)) return null;
  if (!isStringRecord(value.prompts)) return null;
  return {
    name: value.name,
    description: value.description,
    default: value.default,
    agents: value.agents,
    prompts: value.prompts,
  };
}

const MESSAGE_SCHEMA: Record<string, { keys: string[]; parse: (value: Record<string, unknown>) => WebviewMessage | null }> = {
  ready: { keys: ["type"], parse: () => ({ type: "ready" }) },
  reload: { keys: ["type"], parse: () => ({ type: "reload" }) },
  openFile: { keys: ["type"], parse: () => ({ type: "openFile" }) },
  change: {
    keys: ["dirty", "form", "type"],
    parse: (value) => {
      const form = parseForm(value.form);
      if (!form || typeof value.dirty !== "boolean") return null;
      return { type: "change", form, dirty: value.dirty };
    },
  },
  validate: {
    keys: ["form", "type"],
    parse: (value) => {
      const form = parseForm(value.form);
      return form ? { type: "validate", form } : null;
    },
  },
  save: {
    keys: ["form", "type"],
    parse: (value) => {
      const form = parseForm(value.form);
      return form ? { type: "save", form } : null;
    },
  },
  saveAndApply: {
    keys: ["form", "type"],
    parse: (value) => {
      const form = parseForm(value.form);
      return form ? { type: "saveAndApply", form } : null;
    },
  },
  addAlias: {
    keys: ["id", "type", "value"],
    parse: (value) => {
      if (typeof value.value !== "string" || typeof value.id !== "string") return null;
      return { type: "addAlias", value: value.value, id: value.id };
    },
  },
};

/** Validates a webview→host message against a closed schema: a known `type`, the
 *  exact keys for that type, and values of the right shape. Anything else is
 *  rejected and must be logged, never acted on. */
export function parseWebviewMessage(raw: unknown): ParsedMessage {
  if (!isRecord(raw)) return { ok: false, error: "message is not an object" };
  const type = raw.type;
  if (typeof type !== "string" || !Object.hasOwn(MESSAGE_SCHEMA, type)) {
    return { ok: false, error: `unknown message type ${JSON.stringify(type)}` };
  }
  const schema = MESSAGE_SCHEMA[type];
  if (Object.keys(raw).sort().join(",") !== schema.keys.slice().sort().join(",")) {
    return { ok: false, error: `message ${JSON.stringify(type)} has unexpected keys` };
  }
  const message = schema.parse(raw);
  return message ? { ok: true, message } : { ok: false, error: `message ${JSON.stringify(type)} has invalid fields` };
}

// --- conflict diff and rename -------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** The field paths that changed between two stored profile bodies, for the
 *  conflict banner. Values may be a string or a fallback list. */
export function diffFields(base: unknown, latest: unknown): string[] {
  const a = (base ?? {}) as Record<string, unknown>;
  const b = (latest ?? {}) as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of ["description", "default"]) {
    if (!deepEqual(a[key] ?? undefined, b[key] ?? undefined)) changed.push(key);
  }
  for (const section of ["agents", "prompts"] as const) {
    const aSection = isRecord(a[section]) ? a[section] : {};
    const bSection = isRecord(b[section]) ? b[section] : {};
    for (const key of new Set([...Object.keys(aSection), ...Object.keys(bSection)])) {
      if (!deepEqual(aSection[key] ?? undefined, bSection[key] ?? undefined)) changed.push(`${section}.${key}`);
    }
  }
  return changed;
}

/** The rename rule the CLI applies: `[a-z0-9-]+` and not already taken. Returns
 *  an error message or null when the new name is valid. */
export function validateRename(name: string, existing: readonly string[]): string | null {
  if (!PROFILE_NAME.test(name)) return `Profile names match [a-z0-9-]+, got ${JSON.stringify(name)}`;
  if (existing.includes(name)) return `A profile named ${JSON.stringify(name)} already exists`;
  return null;
}
