import { execFileSync } from "node:child_process";

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
