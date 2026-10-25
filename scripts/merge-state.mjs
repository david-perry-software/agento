// Pure helpers for GitHub merge refusals and required status checks. No I/O, no
// side effects: everything here is exported for `scripts/merge-state.test.mjs` and
// composed by `scripts/agento.mjs` at ship time.
//
// gh v2.45.0 refuses `gh pr merge` with `Pull request #N is not mergeable: <reason>.`
// where `<reason>` comes from `blockedReason(mergeStateStatus)`:
//   BLOCKED → "the base branch policy prohibits the merge"
//   BEHIND  → "the head branch is not up to date with the base branch"
//   DIRTY   → "the merge commit cannot be cleanly created"

// Classify a `gh pr merge` refusal into `conflict`, `behind`, `blocked`, or
// `other`. gh's reason text wins; when it is unrecognised the GraphQL
// `mergeStateStatus` is the fallback.
export function classifyMergeRefusal(stderr, mergeStateStatus) {
  const text = String(stderr ?? "");
  if (/cannot be cleanly created|merge conflict/i.test(text)) return "conflict";
  if (/not up to date/i.test(text)) return "behind";
  if (/base branch policy prohibits/i.test(text)) return "blocked";
  const status = String(mergeStateStatus ?? "").toUpperCase();
  if (status === "DIRTY") return "conflict";
  if (status === "BEHIND") return "behind";
  if (status === "BLOCKED") return "blocked";
  return "other";
}

// The union of the required status-check contexts a branch protection asks for:
// the ruleset `required_status_checks` rule contexts plus the classic
// `required_status_checks` `contexts` and `checks`. A 404 (null) or an empty
// result counts as none.
export function requiredContexts(rulesJson, protectionJson) {
  const contexts = new Set();
  const addAll = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item === "string" && item) contexts.add(item);
      else if (item && typeof item.context === "string" && item.context) contexts.add(item.context);
    }
  };
  for (const rule of Array.isArray(rulesJson) ? rulesJson : []) {
    if (rule?.type === "required_status_checks") addAll(rule?.parameters?.required_status_checks);
  }
  const protection = protectionJson && typeof protectionJson === "object" ? protectionJson : null;
  if (protection) {
    addAll(protection.contexts);
    addAll(protection.checks);
  }
  return [...contexts];
}

// Bucket one rollup entry the way wait-for-checks.sh does: a StatusContext has
// `context`/`state`; a CheckRun has `name`/`status`/`conclusion`.
function rollupBucket(entry) {
  if (entry?.__typename === "StatusContext" || (entry?.state !== undefined && entry?.status === undefined)) {
    if (entry.state === "SUCCESS") return "pass";
    if (entry.state === "PENDING" || entry.state === "EXPECTED") return "pending";
    return "fail";
  }
  if (entry?.status !== "COMPLETED") return "pending";
  if (entry?.conclusion === "SUCCESS" || entry?.conclusion === "NEUTRAL" || entry?.conclusion === "SKIPPED") return "pass";
  return "fail";
}

// Which required contexts are absent from the rollup, which are still pending, and
// which have completed as failures. Complete (passing) contexts appear in none.
export function missingRequired(required, rollup) {
  const entries = new Map();
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    const name = entry?.name ?? entry?.context ?? null;
    if (name) entries.set(name, entry);
  }
  const absent = [];
  const pending = [];
  const failed = [];
  for (const context of required) {
    const entry = entries.get(context);
    if (!entry) {
      absent.push(context);
      continue;
    }
    const bucket = rollupBucket(entry);
    if (bucket === "pending") pending.push(context);
    else if (bucket === "fail") failed.push(context);
  }
  return { absent, pending, failed };
}
