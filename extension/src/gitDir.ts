import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface GitDirectories {
  gitDir: string;
  commonDir: string;
}

export async function resolveGitDir(folder: string): Promise<GitDirectories> {
  const dotGit = path.join(folder, ".git");
  const dotGitStat = await stat(dotGit);
  if (dotGitStat.isDirectory()) {
    return { gitDir: dotGit, commonDir: dotGit };
  }

  const match = /^gitdir:\s*(.+)\s*$/i.exec(await readFile(dotGit, "utf8"));
  if (!match) {
    throw new Error(`Invalid gitdir file: ${dotGit}`);
  }
  const gitDir = path.resolve(folder, match[1]);
  let commonDir = gitDir;
  try {
    const commonDirPath = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    commonDir = path.resolve(gitDir, commonDirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { gitDir, commonDir };
}