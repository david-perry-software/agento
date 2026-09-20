import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PendingDispatchStore } from "./pendingDispatch.js";

export class FilePendingDispatchStore implements PendingDispatchStore {
  constructor(private readonly directory: string) {}

  get<T>(key: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.recordPath(key), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return "malformed" as T;
    }
  }

  async update(key: string, value: unknown): Promise<void> {
    const recordPath = this.recordPath(key);
    if (value === undefined) {
      await rm(recordPath, { force: true });
      return;
    }

    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, recordPath);
  }

  private recordPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }
}