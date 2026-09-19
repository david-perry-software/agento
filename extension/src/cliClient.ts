import { execFile } from "node:child_process";
import type * as vscode from "vscode";

export interface CliResult {
  code: number;
  json: unknown;
  stderr: string;
}

export class CliParseError extends Error {
  constructor(stdout: string, options?: ErrorOptions) {
    const excerpt = stdout.slice(0, 200);
    super(`Agento CLI returned invalid JSON: ${JSON.stringify(excerpt)}`, options);
    this.name = "CliParseError";
  }
}

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
  }
}

export function buildCliArgs(cliPath: string, args: string[], root: string): string[] {
  if (args.includes("--root")) {
    throw new CliError("CLI arguments must not include --root");
  }
  return [cliPath, ...args, "--root", root];
}

export function parseCliOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CliParseError(stdout, { cause: error });
  }
}

export interface CliClientOptions {
  nodePath: string;
  cliPath: string;
  output: Pick<vscode.OutputChannel, "appendLine">;
  timeoutMs?: number;
}

export class CliClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: CliClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  run(args: string[], root: string): Promise<CliResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      execFile(
        this.options.nodePath,
        buildCliArgs(this.options.cliPath, args, root),
        {
          cwd: root,
          env: process.env,
          maxBuffer: 16 * 1024 * 1024,
          timeout: this.timeoutMs,
        },
        (error, stdout, stderr) => {
          const code = typeof error?.code === "number" ? error.code : 0;
          this.options.output.appendLine(`cli: ${args.join(" ")} -> exit ${code} in ${Date.now() - startedAt} ms`);

          if (error && typeof error.code !== "number") {
            reject(new CliError(`Unable to run Agento CLI with ${this.options.nodePath}; set agento.nodePath: ${error.message}`, { cause: error }));
            return;
          }

          let json: unknown;
          try {
            json = parseCliOutput(stdout);
          } catch (parseError) {
            reject(parseError);
            return;
          }

          if (![0, 1, 3].includes(code)) {
            reject(new CliError(`Agento CLI exited ${code}: ${stderr.trim()}`, { cause: error ?? undefined }));
            return;
          }

          resolve({ code, json, stderr });
        },
      );
    });
  }
}