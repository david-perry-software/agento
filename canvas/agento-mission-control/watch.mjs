// Debounced file-system watching for the Mission Control canvas. Watches the
// artifact roots (features, issues, initiatives) and the product and companion
// `.git/refs` and `.git/worktrees` directories, coalescing bursts of changes into
// a single in-flight refresh. With `pr: true`, a `--pr` refresh also runs on a
// fixed interval (open and manual refreshes are driven by the caller). `stop()`
// releases every watcher and timer.

import fs from "node:fs";

export const DEBOUNCE_MS = 500;
export const PR_INTERVAL_MS = 5 * 60 * 1000;

// Start watching. Options:
//   watchPaths: string[]   directories to watch (nonexistent ones are skipped)
//   onChange: async ({ pr }) => void — refresh callback (pr true for the interval)
//   onError: (err) => void  — failure reporter for a throwing onChange (default no-op)
//   pr: boolean            enable the --pr refresh interval
//   debounceMs: number     debounce window (default 500 ms; tests shrink it)
//   prIntervalMs: number   --pr interval (default 5 minutes; tests shrink it)
export function startWatcher({ watchPaths = [], onChange, onError = () => {}, pr = false, debounceMs = DEBOUNCE_MS, prIntervalMs = PR_INTERVAL_MS } = {}) {
  const watchers = [];
  let debounceTimer = null;
  let prTimer = null;
  let inFlight = false;
  let pending = false;

  const refresh = async (options) => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await onChange(options);
    } catch (err) {
      // A failed background refresh must never reject unhandled — that would
      // exit the extension process. Report it and keep watching so later
      // refreshes still run.
      try {
        onError(err);
      } catch {
        // reporting must never crash the watcher either
      }
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh({ pr: false });
    }, debounceMs);
  };

  for (const watchPath of watchPaths ?? []) {
    if (!watchPath || !fs.existsSync(watchPath)) continue;
    try {
      watchers.push(fs.watch(watchPath, { persistent: false }, () => schedule()));
    } catch {
      // unwatchable path (permissions, platform); keep watching the rest
    }
  }

  if (pr) {
    prTimer = setInterval(() => {
      void refresh({ pr: true });
    }, prIntervalMs);
    if (typeof prTimer.unref === "function") prTimer.unref();
  }

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (prTimer) clearInterval(prTimer);
      debounceTimer = null;
      prTimer = null;
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
    },
    // A manual debounced refresh (also useful for tests).
    schedule,
    refresh,
  };
}
