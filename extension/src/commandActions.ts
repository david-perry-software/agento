export type CommandWindow = "here" | "primary" | "secondary";

export interface CommandAction {
  command: string;
  window: CommandWindow;
  reason: string | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandText(value: unknown): string {
  if (typeof value !== "string" || !/^\/agento [a-z][a-z-]*(?: [^\r\n]+)?$/.test(value)) {
    throw new Error("command must use canonical /agento <name> syntax");
  }
  return value;
}

export function projectCommandActions(value: unknown): CommandAction[] {
  if (!isRecord(value)) {
    throw new Error("action source must be an object");
  }
  if (!Array.isArray(value.allowed) || !Array.isArray(value.elsewhere)) {
    throw new Error("allowed and elsewhere must be arrays");
  }

  const allowed = value.allowed.map<CommandAction>((command) => ({ command: commandText(command), window: "here", reason: null }));
  const elsewhere = value.elsewhere.map<CommandAction>((entry) => {
    if (!isRecord(entry)) {
      throw new Error("each elsewhere action must be an object");
    }
    if (entry.window !== "primary" && entry.window !== "secondary") {
      throw new Error("elsewhere.window must be primary or secondary");
    }
    const window = entry.window;
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new Error("elsewhere.reason must be a non-empty string");
    }
    return { command: commandText(entry.command), window, reason: entry.reason };
  });

  return [...allowed, ...elsewhere];
}