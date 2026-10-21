import path from "node:path";

export interface PluginRootSources {
  configured: string | undefined;
  pluginLocations: Record<string, unknown> | undefined;
  homedir: string;
  exists: (filePath: string) => boolean;
  readJson: (filePath: string) => unknown;
}

export type ModelsSelection = { kind: "apply"; profile: string } | { kind: "clear" };

export interface ModelProfileQuickPickItem {
  label: string;
  description: string;
  detail?: string;
  selection: ModelsSelection;
}

export interface ModelsSummary {
  ok: boolean;
  message: string;
  /** The files the CLI reported as dirty (status `dirty`), for the Source Control action. */
  dirty: string[];
  /** True when the write hit a stale `--expect` (status `conflict`). */
  conflict: boolean;
}

export function expandHome(filePath: string, homedir: string): string {
  if (filePath === "~") return homedir;
  if (filePath.startsWith("~/")) return path.join(homedir, filePath.slice(2));
  return filePath;
}

function isAgentoPlugin(root: string, sources: PluginRootSources): boolean {
  const manifest = path.join(root, ".claude-plugin", "plugin.json");
  if (!sources.exists(manifest)) return false;
  try {
    const json = sources.readJson(manifest);
    return typeof json === "object" && json !== null && (json as { name?: unknown }).name === "agento";
  } catch {
    return false;
  }
}

// The `agento.pluginRoot` setting wins; otherwise the first enabled
// `chat.pluginLocations` entry that is the Agento plugin. null when neither is.
export function resolvePluginRoot(sources: PluginRootSources): string | null {
  const configured = sources.configured?.trim();
  if (configured) {
    const root = path.resolve(expandHome(configured, sources.homedir));
    return isAgentoPlugin(root, sources) ? root : null;
  }
  for (const [location, enabled] of Object.entries(sources.pluginLocations ?? {})) {
    if (enabled !== true) continue;
    const root = path.resolve(expandHome(location, sources.homedir));
    if (isAgentoPlugin(root, sources)) return root;
  }
  return null;
}

export function missingPluginRootMessage(configured: string | undefined, homedir: string): string {
  const value = configured?.trim();
  if (value) {
    const root = path.resolve(expandHome(value, homedir));
    return `agento.pluginRoot is set to ${root}, which is not an Agento plugin clone (no .claude-plugin/plugin.json named "agento"): fix or clear the setting.`;
  }
  return "No Agento plugin clone found: set agento.pluginRoot or register the clone in chat.pluginLocations.";
}

interface ListedProfile {
  name?: unknown;
  description?: unknown;
  errors?: unknown;
}

export function toQuickPickItems(listJson: unknown): ModelProfileQuickPickItem[] {
  const list = (listJson ?? {}) as { profiles?: unknown; active?: unknown };
  const profiles = Array.isArray(list.profiles) ? (list.profiles as ListedProfile[]) : [];
  const items: ModelProfileQuickPickItem[] = [];
  for (const profile of profiles) {
    if (typeof profile.name !== "string") continue;
    const errors = Array.isArray(profile.errors) ? profile.errors.filter((e): e is string => typeof e === "string") : [];
    const description = typeof profile.description === "string" ? profile.description : "";
    items.push({
      label: profile.name,
      description: list.active === profile.name ? `applied${description ? ` · ${description}` : ""}` : description,
      ...(errors.length ? { detail: `${errors.length} error(s): ${errors[0]}` } : {}),
      selection: { kind: "apply", profile: profile.name },
    });
  }
  items.push({ label: "Clear", description: "use the picker's model", selection: { kind: "clear" } });
  return items;
}

export function selectionToArgs(selection: ModelsSelection, pluginRoot: string): string[] {
  return selection.kind === "apply"
    ? ["models", "apply", selection.profile, "--plugin-root", pluginRoot]
    : ["models", "clear", "--plugin-root", pluginRoot];
}

// Arg builders for the write verbs. Every write passes `--expect <hash>` from the
// snapshot the action was taken on, when a hash exists, so a file changed by
// another window is a `conflict` instead of a silent clobber.
export function createProfileArgs(name: string, pluginRoot: string, options: { from?: string; description?: string; hash?: string | null } = {}): string[] {
  return [
    "models", "create", name,
    ...(options.from ? ["--from", options.from] : []),
    ...(options.description ? ["--description", options.description] : []),
    ...(options.hash ? ["--expect", options.hash] : []),
    "--plugin-root", pluginRoot,
  ];
}

export function renameProfileArgs(oldName: string, newName: string, pluginRoot: string, options: { hash?: string | null } = {}): string[] {
  return [
    "models", "rename", oldName, newName,
    ...(options.hash ? ["--expect", options.hash] : []),
    "--plugin-root", pluginRoot,
  ];
}

export function deleteProfileArgs(name: string, pluginRoot: string, options: { force?: boolean; hash?: string | null } = {}): string[] {
  return [
    "models", "delete", name,
    ...(options.force ? ["--force"] : []),
    ...(options.hash ? ["--expect", options.hash] : []),
    "--plugin-root", pluginRoot,
  ];
}

export function initProfilesArgs(pluginRoot: string): string[] {
  return ["models", "init", "--plugin-root", pluginRoot];
}

const STATUS_FALLBACK: Record<string, string> = {
  exists: "A profile with that name already exists",
  "not-found": "No profile with that name was found",
  active: "That profile is applied in this clone",
  conflict: "The profiles file changed since it was read; refresh and try again",
  invalid: "The profile is invalid",
  dirty: "The clone has changes beyond the model pins",
};

export function summarizeModelsResult(json: unknown): ModelsSummary {
  const result = (json ?? {}) as {
    status?: unknown;
    verb?: unknown;
    profile?: unknown;
    changed?: unknown;
    created?: unknown;
    errors?: unknown;
    dirty?: unknown;
    message?: unknown;
  };
  if (result.status === "ok") {
    const verb = typeof result.verb === "string" ? result.verb : null;
    const profile = typeof result.profile === "string" ? result.profile : null;
    if (verb === "create") return { ok: true, message: `Created model profile ${profile ?? "unknown"}.`, dirty: [], conflict: false };
    if (verb === "rename") return { ok: true, message: "Renamed the model profile.", dirty: [], conflict: false };
    if (verb === "delete") return { ok: true, message: `Deleted model profile ${profile ?? "unknown"}.`, dirty: [], conflict: false };
    if (verb === "init") return { ok: true, message: result.created === true ? "Created the model profiles file." : "The model profiles file already exists.", dirty: [], conflict: false };
    const changed = Array.isArray(result.changed) ? result.changed.length : 0;
    const what = profile ? `Applied model profile ${profile}` : "Cleared the model profile";
    return { ok: true, message: `${what}: ${changed} file(s) changed. Run Developer: Reload Window if the model picker does not update.`, dirty: [], conflict: false };
  }
  const dirty = Array.isArray(result.dirty) ? result.dirty.filter((d): d is string => typeof d === "string") : [];
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  const conflict = result.status === "conflict";
  const details = [...errors, ...(result.status === "dirty" ? dirty : [])];
  const status = String(result.status ?? "failed");
  const message = typeof result.message === "string" && result.message ? result.message : (STATUS_FALLBACK[status] ?? `models ${status}`);
  return { ok: false, message: details.length ? `${message}: ${details.join("; ")}` : message, dirty, conflict };
}
