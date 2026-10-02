import path from "node:path";

import { isCanonicalAgentoCommand } from "./commandActions.js";

// The `<name>` of a canonical `/agento <name> …` command string, else null.
export function commandName(command: string): string | null {
  if (!isCanonicalAgentoCommand(command)) return null;
  return command.split(/\s+/)[1] ?? null;
}

// The `agent:` frontmatter scalar of a `commands/<name>.md` body (quoted or bare),
// null when the file has no frontmatter or no `agent:` line.
export function readCommandAgent(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, "") === "---");
  if (end <= 0) return null;
  const agentLine = lines.slice(1, end).find((line) => line.startsWith("agent:"));
  if (agentLine === undefined) return null;
  const raw = agentLine.slice("agent:".length).replace(/\r$/, "").trim();
  if (raw.length === 0) return null;
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

export interface ChatModeSources {
  pluginRoot: string | null;
  readFile: (filePath: string) => string;
}

export type ChatModeResolution = { mode: string } | { mode: null; reason: string };

// The chat `mode` a dispatch should pass to `workbench.action.chat.open`: the
// command's `agent:` name verbatim, `"agent"` for built-in-agent commands (no
// `agent:` line or `agent: "agent"`), and a null-mode reason when the plugin root
// cannot be resolved or the command file cannot be read.
export function resolveChatMode(command: string, sources: ChatModeSources): ChatModeResolution {
  const name = commandName(command);
  if (name === null) return { mode: null, reason: "not a canonical /agento command" };
  if (sources.pluginRoot === null) return { mode: null, reason: "no plugin root" };
  const filePath = path.join(sources.pluginRoot, "commands", `${name}.md`);
  let text: string;
  try {
    text = sources.readFile(filePath);
  } catch (error) {
    return { mode: null, reason: `unreadable command file ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const agent = readCommandAgent(text);
  if (agent === null || agent === "agent") return { mode: "agent" };
  return { mode: agent };
}

export interface CommandFileSources {
  pluginRoot: string | null;
  exists: (filePath: string) => boolean;
}

export type CommandFileResolution =
  | { path: string }
  | { path: null; reason: string };

// The `commands/<name>.md` file a dispatch should attach to the chat request, or
// a null-path reason when the command is not canonical, the plugin root is
// unresolved, or the command file does not exist.
export function resolveCommandFile(command: string, sources: CommandFileSources): CommandFileResolution {
  const name = commandName(command);
  if (name === null) return { path: null, reason: "not a canonical /agento command" };
  if (sources.pluginRoot === null) return { path: null, reason: "no plugin root" };
  const filePath = path.join(sources.pluginRoot, "commands", `${name}.md`);
  if (!sources.exists(filePath)) return { path: null, reason: `missing command file ${filePath}` };
  return { path: filePath };
}
