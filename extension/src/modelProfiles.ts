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

export function summarizeModelsResult(json: unknown): ModelsSummary {
  const result = (json ?? {}) as { status?: unknown; profile?: unknown; changed?: unknown; errors?: unknown; dirty?: unknown; message?: unknown };
  if (result.status === "ok") {
    const changed = Array.isArray(result.changed) ? result.changed.length : 0;
    const what = typeof result.profile === "string" ? `Applied model profile ${result.profile}` : "Cleared the model profile";
    return { ok: true, message: `${what}: ${changed} file(s) changed. Run Developer: Reload Window if the model picker does not update.` };
  }
  const details = [
    ...(Array.isArray(result.errors) ? result.errors : []),
    ...(Array.isArray(result.dirty) && result.status === "dirty" ? result.dirty : []),
  ].filter((d): d is string => typeof d === "string");
  const message = typeof result.message === "string" ? result.message : `models ${String(result.status ?? "failed")}`;
  return { ok: false, message: details.length ? `${message}: ${details.join("; ")}` : message };
}
