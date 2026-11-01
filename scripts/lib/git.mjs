import { execFileSync } from "node:child_process";

export const isAncestor = (dir, a, b) => gitRun(dir, ["merge-base", "--is-ancestor", a, b]).ok;

// The re-auth command for a remote URL: GitHub remotes use gh auth login; others
// name their credential helper or SSH key.
export function reauthFor(url) {
  if (/^https:\/\/github\.com\//.test(url ?? "")) return "gh auth login";
  return `re-authenticate the credentials for ${url ?? "origin"} (credential helper or SSH key)`;
}

// A bounded, prompt-free git call that reports stderr instead of swallowing it.
export function gitRun(dir, args, timeout = 30000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  try {
    const stdout = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env });
    return { ok: true, stdout: stdout.trim(), stderr: "", timedOut: false };
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT" || Boolean(error?.signal && !error?.status);
    const stderr = (error?.stderr ?? "").toString().trim();
    return { ok: false, stdout: (error?.stdout ?? "").toString().trim(), stderr: timedOut ? `git ${args[0]} timed out after ${timeout / 1000} s` : stderr || error?.message || "unknown error", timedOut };
  }
}
