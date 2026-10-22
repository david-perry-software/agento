// The pure model and presentation for the Model Profiles tree view. No `vscode`
// import: everything here is unit-tested against the `models list` JSON contract
// (see docs/model-profiles.md), so the provider stays a thin TreeItem converter.

export type ModelProfileValue = string | string[] | null;

export interface ModelProfileTarget {
  file: string;
  value: ModelProfileValue;
}

export interface ModelProfileEntry {
  name: string;
  description: string | null;
  errors: string[];
  warnings: string[];
  targets: ModelProfileTarget[];
}

export type ModelProfilesState = "no-plugin-root" | "no-file" | "error" | "ready";

/** The two window buckets: primary (clone file pins) and secondary (plan/build/freehand). */
export type ProfileRole = "primary" | "secondary";

/** The secondary role's state beyond the raw assigned name. */
export type SecondaryState = "on" | "off" | "dangling" | "invalid";

export interface ModelProfilesFile {
  path: string;
  exists: boolean;
  hash: string | null;
}

export interface ModelProfilesRoles {
  /** The primary assignment: a profile name, `custom` (pins match no profile), or null (off). */
  primary: string | null;
  /** The secondary assignment: a profile name, or null when the role is off/invalid/dangling. */
  secondary: string | null;
  secondaryState: SecondaryState;
  rolesFile: ModelProfilesFile | null;
  rolesErrors: string[];
}

export interface EffectiveProfile {
  role: ProfileRole;
  /** The profile in effect, or null when the effective state has no single profile (off/custom). */
  name: string | null;
  source: "role-profile" | "file-pins";
  label: string;
}

export interface ModelProfilesModel {
  state: ModelProfilesState;
  profiles: ModelProfileEntry[];
  messages: string[];
  active: string | null;
  profilesFile: ModelProfilesFile | null;
  windowRole: ProfileRole;
  roles: ModelProfilesRoles | null;
}

export interface ModelProfilesModelInput {
  /** The resolved plugin root, or null when no Agento plugin clone is reachable. */
  pluginRoot: string | null;
  /** The `models list` JSON, or undefined when the CLI call itself failed. */
  listResult?: unknown;
  /** The CLI failure message, when `listResult` is absent. */
  listError?: string | null;
  /** The role of this window, bucketed by `windowProfileRole`; defaults to `primary`. */
  windowRole?: ProfileRole;
}

export interface ModelProfileItemSpec {
  label: string;
  description?: string;
  icon: string;
  contextValue: string;
  tooltip?: string;
}

export type ModelProfilesElement =
  | { kind: "profile"; profile: ModelProfileEntry }
  | { kind: "message"; label: string }
  | { kind: "info"; label: string; tooltip: string };

type UnknownRecord = Record<string, unknown>;

const AGENT_FILE = /^\.github\/agents\/(.+)\.agent\.md$/;
const PROMPT_FILE = /^\.github\/prompts\/(.+)\.prompt\.md$/;
const COMMAND_FILE = /^skills\/agento\/commands\/(.+)\.md$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTarget(value: unknown): ModelProfileTarget | null {
  if (!isRecord(value) || typeof value.file !== "string") return null;
  const model = value.value;
  if (model === null) return { file: value.file, value: null };
  if (typeof model === "string") return { file: value.file, value: model };
  if (Array.isArray(model) && model.every((item) => typeof item === "string")) return { file: value.file, value: model };
  return null;
}

function parseProfile(value: unknown): ModelProfileEntry | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return null;
  const description = typeof value.description === "string" ? value.description : null;
  const errors = stringArray(value.errors);
  const warnings = stringArray(value.warnings);
  const targets = Array.isArray(value.targets)
    ? value.targets.map(parseTarget).filter((target): target is ModelProfileTarget => target !== null)
    : [];
  return { name: value.name, description, errors, warnings, targets };
}

function parseProfilesFile(value: unknown): ModelProfilesFile | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.exists !== "boolean") return null;
  return { path: value.path, exists: value.exists, hash: typeof value.hash === "string" ? value.hash : null };
}

// Maps a session role to the profile bucket it reads. `plan`, `build`, and
// `freehand` are secondary windows; primary, unmanaged, unknown, and no session
// are primary (matches the CLI's `roleBucket`).
export function windowProfileRole(sessionRole: string | null): ProfileRole {
  return sessionRole === "plan" || sessionRole === "build" || sessionRole === "freehand" ? "secondary" : "primary";
}

// Parses the `roles`/`rolesFile`/`rolesErrors` section of `models list`. The
// secondary state is derived from the errors and the profile list: `invalid` when
// the roles file has errors, `dangling` when it names a profile that does not
// exist, `off` when the role is null, and `on` otherwise.
function parseRolesValue(listResult: UnknownRecord, active: string | null, profiles: ModelProfileEntry[]): ModelProfilesRoles {
  const rolesRecord = isRecord(listResult.roles) ? listResult.roles : {};
  const primaryValue = rolesRecord.primary;
  const secondaryValue = rolesRecord.secondary;
  const primary =
    typeof primaryValue === "string" ? primaryValue : primaryValue === null ? null : active ?? null;
  const secondary = typeof secondaryValue === "string" ? secondaryValue : null;
  const rolesFile = parseProfilesFile(listResult.rolesFile);
  const rolesErrors = stringArray(listResult.rolesErrors);
  let secondaryState: SecondaryState;
  if (rolesErrors.length > 0) secondaryState = "invalid";
  else if (secondary === null) secondaryState = "off";
  else if (!profiles.some((profile) => profile.name === secondary)) secondaryState = "dangling";
  else secondaryState = "on";
  return { primary, secondary, secondaryState, rolesFile, rolesErrors };
}

// Builds the model from the `models list` JSON (or a CLI failure). The state
// precedence mirrors what the view must render: a missing plugin root, then a CLI
// or file-level error, then a missing profiles file, then the ready rows.
export function createModelProfilesModel(input: ModelProfilesModelInput): ModelProfilesModel {
  const windowRole = input.windowRole ?? "primary";
  if (input.pluginRoot === null) {
    return { state: "no-plugin-root", profiles: [], messages: [], active: null, profilesFile: null, windowRole, roles: null };
  }
  if (input.listError) {
    return { state: "error", profiles: [], messages: [input.listError], active: null, profilesFile: null, windowRole, roles: null };
  }
  if (!isRecord(input.listResult)) {
    return { state: "error", profiles: [], messages: ["The models list returned no result."], active: null, profilesFile: null, windowRole, roles: null };
  }
  const profilesFile = parseProfilesFile(input.listResult.profilesFile);
  if (profilesFile === null) {
    return { state: "error", profiles: [], messages: ["The models list result is missing profilesFile."], active: null, profilesFile: null, windowRole, roles: null };
  }
  const fileErrors = stringArray(input.listResult.errors);
  if (fileErrors.length) {
    return { state: "error", profiles: [], messages: fileErrors, active: null, profilesFile, windowRole, roles: null };
  }
  if (!profilesFile.exists) {
    return { state: "no-file", profiles: [], messages: [], active: null, profilesFile, windowRole, roles: null };
  }
  const rawProfiles = Array.isArray(input.listResult.profiles) ? input.listResult.profiles : [];
  const profiles = rawProfiles.map(parseProfile).filter((profile): profile is ModelProfileEntry => profile !== null);
  const active = typeof input.listResult.active === "string" ? input.listResult.active : null;
  const roles = parseRolesValue(input.listResult, active, profiles);
  return { state: "ready", profiles, messages: [], active, profilesFile, windowRole, roles };
}

// The profile in effect in this window: the secondary profile when the window is
// secondary and the role is on, otherwise the primary file pins (a profile name,
// custom pins, or the picker default when off).
export function effectiveProfile(model: ModelProfilesModel): EffectiveProfile | null {
  if (model.state !== "ready" || model.roles === null) return null;
  if (model.windowRole === "secondary" && model.roles.secondaryState === "on") {
    return { role: "secondary", name: model.roles.secondary, source: "role-profile", label: model.roles.secondary ?? "" };
  }
  const primary = model.roles.primary;
  if (primary === "custom") return { role: "primary", name: null, source: "file-pins", label: "custom pins" };
  if (primary === null) return { role: "primary", name: null, source: "file-pins", label: "picker default" };
  return { role: "primary", name: primary, source: "file-pins", label: primary };
}

// The root rows: message rows in the error state; otherwise the `custom` info row
// (when the clone's pins match no profile) followed by one row per profile. Empty
// in the two states the viewsWelcome content covers.
export function modelProfilesChildren(model: ModelProfilesModel): ModelProfilesElement[] {
  if (model.state === "no-plugin-root" || model.state === "no-file") return [];
  if (model.state === "error") return model.messages.map((label) => ({ kind: "message", label }));
  const children: ModelProfilesElement[] = [];
  if (model.active === "custom") {
    children.push({
      kind: "info",
      label: "Custom pins — no profile matches",
      tooltip: "The clone's pins match no profile. Apply a profile to set them, or Clear to use the picker's model.",
    });
  }
  for (const profile of model.profiles) children.push({ kind: "profile", profile });
  return children;
}

// Renders one pin value: a fallback list reads as `A → B`.
function renderPinValue(value: ModelProfileValue): string {
  if (value === null) return "none";
  return Array.isArray(value) ? value.join(" → ") : value;
}

// Groups the resolved targets into tooltip lines: one line per agent (by name),
// then one line per distinct command value (`<value> — <n> commands`), with a
// prompt file and its `skills/agento/commands` mirror counting as one command.
export function summarizePins(targets: ModelProfileTarget[]): string[] {
  const lines: string[] = [];
  for (const target of targets) {
    if (target.value === null) continue;
    const match = AGENT_FILE.exec(target.file);
    if (match) lines.push(`${match[1]}: ${renderPinValue(target.value)}`);
  }
  const commandsByValue = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.value === null) continue;
    const prompt = PROMPT_FILE.exec(target.file);
    const command = COMMAND_FILE.exec(target.file);
    const name = prompt?.[1] ?? command?.[1];
    if (name === undefined) continue;
    const key = JSON.stringify(target.value);
    const names = commandsByValue.get(key) ?? new Set<string>();
    names.add(name);
    commandsByValue.set(key, names);
  }
  for (const [key, names] of commandsByValue) {
    const value = JSON.parse(key) as string | string[];
    lines.push(`${renderPinValue(value)} — ${names.size} command${names.size === 1 ? "" : "s"}`);
  }
  return lines;
}

// The tooltip: the description, every error, every warning, and the pins summary.
function profileTooltip(profile: ModelProfileEntry): string | undefined {
  const sections: string[] = [];
  if (profile.description) sections.push(profile.description);
  if (profile.errors.length) sections.push(`**Errors**\n${profile.errors.map((error) => `- ${error}`).join("\n")}`);
  if (profile.warnings.length) sections.push(`**Warnings**\n${profile.warnings.map((warning) => `- ${warning}`).join("\n")}`);
  const pins = summarizePins(profile.targets);
  if (pins.length) sections.push(`**Pins**\n${pins.map((pin) => `- ${pin}`).join("\n")}`);
  return sections.length ? sections.join("\n\n") : undefined;
}

export function profileItemSpec(profile: ModelProfileEntry, active: string | null): ModelProfileItemSpec {
  const applied = active === profile.name;
  const invalid = profile.errors.length > 0;
  const hasWarnings = !invalid && profile.warnings.length > 0;
  const icon = applied ? "pass-filled" : invalid ? "error" : hasWarnings ? "warning" : "symbol-misc";
  const contextValue = `agento.modelProfile${applied ? ".applied" : ""}${invalid ? ".invalid" : ""}`;
  const description = applied
    ? profile.description
      ? `applied · ${profile.description}`
      : "applied"
    : (profile.description ?? undefined);
  const tooltip = profileTooltip(profile);
  return { label: profile.name, description, icon, contextValue, ...(tooltip ? { tooltip } : {}) };
}

export function modelProfilesItemSpec(element: ModelProfilesElement, active: string | null): ModelProfileItemSpec {
  if (element.kind === "profile") return profileItemSpec(element.profile, active);
  if (element.kind === "info") {
    return { label: element.label, icon: "info", contextValue: "agento.modelProfileInfo", tooltip: element.tooltip };
  }
  return { label: element.label, icon: "error", contextValue: "agento.modelProfileMessage" };
}

// Profile names must match [a-z0-9-]+ and not collide with an existing profile.
// Returns the reason the value is rejected, or null when it is valid.
export function validateProfileName(value: string, existing: ReadonlySet<string> | readonly string[]): string | null {
  if (!/^[a-z0-9-]+$/.test(value)) {
    return "Profile names must use only lowercase letters, digits, and hyphens.";
  }
  const names = existing instanceof Set ? existing : new Set(existing);
  if (names.has(value)) return `A profile named ${JSON.stringify(value)} already exists.`;
  return null;
}

// `<name>-copy`, then `<name>-copy-2`, … until the name is free.
export function suggestCopyName(name: string, existing: ReadonlySet<string> | readonly string[]): string {
  const names = existing instanceof Set ? existing : new Set(existing);
  const base = `${name}-copy`;
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
