import path from "node:path";

import type { ProfileRole } from "./modelProfilesTree.js";

export interface PluginRootSources {
  configured: string | undefined;
  pluginLocations: Record<string, unknown> | undefined;
  homedir: string;
  exists: (filePath: string) => boolean;
  readJson: (filePath: string) => unknown;
}

/** A role-aware selection: use a profile for a role, or turn a role off. */
export type ModelsSelection = { kind: "use"; role: ProfileRole; profile: string } | { kind: "off"; role: ProfileRole };

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

// The quick pick: each profile marked with its role labels, then a "Turn off"
// item for this window's role. Primary's turn-off uses the picker's model;
// secondary's uses the primary windows' pins.
export function toQuickPickItems(listJson: unknown, windowRole: ProfileRole): ModelProfileQuickPickItem[] {
  const list = (listJson ?? {}) as { profiles?: unknown; roles?: unknown };
  const roles = (list.roles ?? {}) as { primary?: unknown; secondary?: unknown };
  const primaryName = typeof roles.primary === "string" ? roles.primary : null;
  const secondaryName = typeof roles.secondary === "string" ? roles.secondary : null;
  const profiles = Array.isArray(list.profiles) ? (list.profiles as ListedProfile[]) : [];
  const items: ModelProfileQuickPickItem[] = [];
  for (const profile of profiles) {
    if (typeof profile.name !== "string") continue;
    const errors = Array.isArray(profile.errors) ? profile.errors.filter((e): e is string => typeof e === "string") : [];
    const description = typeof profile.description === "string" ? profile.description : "";
    const labels = [primaryName === profile.name ? "primary" : null, secondaryName === profile.name ? "secondary" : null].filter(
      (label): label is ProfileRole => label !== null,
    );
    const labelText = labels.join(" · ");
    items.push({
      label: profile.name,
      description: labelText ? (description ? `${labelText} · ${description}` : labelText) : description,
      ...(errors.length ? { detail: `${errors.length} error(s): ${errors[0]}` } : {}),
      selection: { kind: "use", role: windowRole, profile: profile.name },
    });
  }
  items.push({
    label: "Turn off",
    description: windowRole === "primary" ? "use the picker's model" : "use the primary windows' pins",
    selection: { kind: "off", role: windowRole },
  });
  return items;
}

export function selectionToArgs(
  selection: ModelsSelection,
  pluginRoot: string,
  options: { rolesHash?: string | null } = {},
): string[] {
  const expect = options.rolesHash ? ["--expect", options.rolesHash] : [];
  if (selection.kind === "use") {
    return selection.role === "primary"
      ? ["models", "apply", selection.profile, "--plugin-root", pluginRoot]
      : ["models", "use", selection.profile, "--role", "secondary", ...expect, "--plugin-root", pluginRoot];
  }
  return selection.role === "primary"
    ? ["models", "clear", "--plugin-root", pluginRoot]
    : ["models", "use", "none", "--role", "secondary", ...expect, "--plugin-root", pluginRoot];
}

// A primary-role change from a secondary window surprises every primary window,
// so it needs the modal confirm; in a primary window it does not.
export function needsPrimaryConfirm(targetRole: ProfileRole, windowRole: ProfileRole): boolean {
  return targetRole === "primary" && windowRole === "secondary";
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

export function updateProfileArgs(name: string, pluginRoot: string, options: { dryRun?: boolean; expect?: string | null } = {}): string[] {
  return [
    "models", "update", name,
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.expect ? ["--expect", options.expect] : []),
    "--plugin-root", pluginRoot,
  ];
}

export function aliasSetArgs(picker: string, id: string, pluginRoot: string, options: { expect?: string | null } = {}): string[] {
  return [
    "models", "alias", "set", picker, id,
    ...(options.expect ? ["--expect", options.expect] : []),
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
  assigned: "That profile is assigned to the secondary role",
  conflict: "The profiles file changed since it was read; refresh and try again",
  invalid: "The profile is invalid",
  dirty: "The clone has changes beyond the model pins",
};

export function summarizeModelsResult(json: unknown): ModelsSummary {
  const result = (json ?? {}) as {
    status?: unknown;
    verb?: unknown;
    profile?: unknown;
    role?: unknown;
    changed?: unknown;
    created?: unknown;
    reapply?: unknown;
    picker?: unknown;
    errors?: unknown;
    dirty?: unknown;
    message?: unknown;
  };
  if (result.status === "ok") {
    const verb = typeof result.verb === "string" ? result.verb : null;
    const profile = typeof result.profile === "string" ? result.profile : null;
    const role = typeof result.role === "string" ? result.role : null;
    if (verb === "use" && role === "secondary") {
      return {
        ok: true,
        message: profile
          ? `Secondary windows now use ${profile}.`
          : "Turned off the secondary profile; secondary windows use the primary pins.",
        dirty: [],
        conflict: false,
      };
    }
    if (verb === "create") return { ok: true, message: `Created model profile ${profile ?? "unknown"}.`, dirty: [], conflict: false };
    if (verb === "rename") return { ok: true, message: "Renamed the model profile.", dirty: [], conflict: false };
    if (verb === "delete") return { ok: true, message: `Deleted model profile ${profile ?? "unknown"}.`, dirty: [], conflict: false };
    if (verb === "update") {
      const reapply = typeof result.reapply === "string" && result.reapply ? ` Run ${result.reapply} to update the active models.` : "";
      return { ok: true, message: `Saved model profile ${profile ?? "unknown"}.${reapply}`, dirty: [], conflict: false };
    }
    if (verb === "alias set") {
      const picker = typeof result.picker === "string" ? result.picker : "unknown";
      return { ok: true, message: `Saved the Copilot model alias for ${picker}.`, dirty: [], conflict: false };
    }
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
