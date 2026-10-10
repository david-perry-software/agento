// Delivery metrics derived from git history only: roadmap `status:` transitions,
// review.md verdict commits, `(manual, post-ship)` tick commits, and the product's
// first-parent merge subjects. Pure functions over `git log` text; no process,
// filesystem, or network access, so `agento.mjs metrics` and `dashboard` share them.

import path from "node:path";

const COMMIT_MARK = "\u0000commit ";

const unquote = (value) => value.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");

// `git log --reverse --format='%x00commit %H %cI' -p --unified=0 -- <roadmap.md and
// review.md pathspecs>` → Map<dir, event[]>, oldest first. Events: `status` per
// `+status:` line of a roadmap.md; `review` per commit touching a review.md, valued
// with the verdict that commit leaves (a re-review that keeps `Verdict:` unchanged
// shows no `+Verdict:` line under --unified=0, so the dir's last verdict carries);
// `post-ship-tick` per `(manual, post-ship)` step newly ticked in that commit.
export function parseArtifactLog(text) {
  const commits = [];
  for (const chunk of String(text ?? "").split(COMMIT_MARK).slice(1)) {
    const newline = chunk.indexOf("\n");
    const [sha, at] = (newline === -1 ? chunk : chunk.slice(0, newline)).trim().split(" ");
    if (!sha || !at || Number.isNaN(Date.parse(at))) continue;
    commits.push({ sha, at, files: parseFiles(newline === -1 ? "" : chunk.slice(newline + 1)) });
  }
  commits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const verdicts = new Map();
  const byDir = new Map();
  const push = (dir, event) => {
    const list = byDir.get(dir);
    if (list) list.push(event);
    else byDir.set(dir, [event]);
  };
  for (const { sha, at, files } of commits) {
    for (const file of files) {
      const dir = path.posix.dirname(file.path);
      const name = path.posix.basename(file.path);
      if (name === "roadmap.md" && !file.deleted) {
        for (const line of file.added) {
          const status = line.match(/^status:[ \t]*(.*)$/);
          if (status && unquote(status[1])) push(dir, { at, sha, kind: "status", value: unquote(status[1]) });
        }
        const unticked = new Set(file.removed.map((l) => l.match(/^- \[x\] (\d+\.\d+) \(manual, post-ship\)/)?.[1]).filter(Boolean));
        for (const line of file.added) {
          const step = line.match(/^- \[x\] (\d+\.\d+) \(manual, post-ship\)/)?.[1];
          if (step && !unticked.has(step)) push(dir, { at, sha, kind: "post-ship-tick", value: step });
        }
      } else if (name === "review.md") {
        if (file.deleted) {
          verdicts.delete(dir);
          continue;
        }
        for (const line of file.added) {
          const verdict = line.match(/^Verdict:\s*(approve|request-changes)\b/)?.[1];
          if (verdict) verdicts.set(dir, verdict);
        }
        if (verdicts.has(dir)) push(dir, { at, sha, kind: "review", value: verdicts.get(dir) });
      }
    }
  }
  for (const [dir, list] of byDir) byDir.set(dir, uniqueEvents(list));
  return byDir;
}

// One commit's patch → [{ path, deleted, added[], removed[] }] (hunk lines without the sign).
function parseFiles(patch) {
  const files = [];
  let file = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: null, deleted: false, added: [], removed: [] };
      files.push(file);
      inHunk = false;
      // Fallback for patches without +++ (pure renames): the b/ side of the header.
      file.path = line.match(/ b\/(.+)$/)?.[1] ?? null;
    } else if (!file) {
      continue;
    } else if (!inHunk) {
      if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line === "+++ /dev/null") file.deleted = true;
      else if (line.startsWith("@@")) inHunk = true;
    } else if (line.startsWith("@@")) {
      continue;
    } else if (line.startsWith("+")) {
      file.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      file.removed.push(line.slice(1));
    }
  }
  return files.filter((f) => f.path);
}

const eventKey = (e) => `${e.sha}\u0000${e.kind}\u0000${e.value}`;

// Deduplicated by (sha, kind, value) — one dir's events, so dir is implied — and
// sorted oldest first (stable for one commit's events).
function uniqueEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out.map((e, i) => [e, i]).sort(([a, i], [b, j]) => Date.parse(a.at) - Date.parse(b.at) || i - j).map(([e]) => e);
}

const MERGE_SUBJECT = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/;

// `git log --first-parent --merges --format='%H%x09%cI%x09%s'` → Map<branch,
// { at, sha, pr }>. A branch merged more than once keeps its earliest merge.
export function parseMergeLog(text) {
  const merged = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const [sha, at, ...subject] = line.split("\t");
    const match = subject.join("\t").trim().match(MERGE_SUBJECT);
    if (!sha || !at || !match || Number.isNaN(Date.parse(at))) continue;
    const entry = { at, sha, pr: Number(match[1]) };
    const previous = merged.get(match[2]);
    if (!previous || Date.parse(at) < Date.parse(previous.at)) merged.set(match[2], entry);
  }
  return merged;
}

const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

// `start` → `end`; with no end, open to `now` while the delivery is not complete, else null.
function interval(start, end, { complete, nowIso }) {
  if (!start) return null;
  if (end) return { start, end, seconds: seconds(start, end), open: false };
  if (complete) return null;
  return { start, end: null, seconds: seconds(start, nowIso), open: true };
}

// One delivery's metrics. `record` is a status item (type, slug, dir, roadmap,
// branch, status, postShipPending); `events` its dir's events (any order, may
// repeat); `merged` the product merge Map; `ref` names what the events were read from.
export function deriveMetrics({ record, events = [], merged = new Map(), now = Date.now(), ref = null }) {
  const nowIso = new Date(now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now).toISOString();
  const list = uniqueEvents(events);
  const statuses = list.filter((e) => e.kind === "status");
  const first = (value) => statuses.find((e) => e.value === value)?.at ?? null;
  const complete = record.status === "complete";
  const opts = { complete, nowIso };

  const cycleStart = statuses[0]?.at ?? null;
  const buildStart = first("in-progress");
  const reviewStart = first("in-review");
  const cycleEnd = first("complete");
  const plannedStart = statuses[0]?.value === "planned" ? cycleStart : null;
  const phases = {
    planned: interval(plannedStart, plannedStart && (buildStart ?? reviewStart ?? cycleEnd), opts),
    build: interval(buildStart, buildStart && (reviewStart ?? cycleEnd), opts),
    review: interval(reviewStart, reviewStart && cycleEnd, opts),
  };
  const cycle = interval(cycleStart, cycleStart && cycleEnd, opts);

  let pauseCount = 0;
  let pauseSeconds = 0;
  let pausedAt = null;
  for (const event of statuses) {
    if (event.value === "paused" && !pausedAt) {
      pausedAt = event.at;
      pauseCount += 1;
    } else if (event.value !== "paused" && pausedAt) {
      pauseSeconds += seconds(pausedAt, event.at);
      pausedAt = null;
    }
  }
  if (pausedAt) pauseSeconds += seconds(pausedAt, nowIso);
  const pauses = { count: pauseCount, seconds: pauseSeconds, open: Boolean(pausedAt) };

  const reviewRounds = list.filter((e) => e.kind === "review" && e.value === "request-changes").length;
  const mergedEntry = (record.branch && merged.get(record.branch)) || null;
  const ticks = list.filter((e) => e.kind === "post-ship-tick");
  const pending = Number(record.postShipPending ?? 0);
  const ticked = new Set(ticks.map((e) => e.value)).size;
  const lastTickAt = ticks.at(-1)?.at ?? null;
  const shippedAt = mergedEntry?.at ?? cycleEnd;
  const postShip = {
    total: ticked + pending,
    ticked,
    lastTickAt,
    latencySeconds: lastTickAt && shippedAt ? seconds(shippedAt, lastTickAt) : null,
    pending: pending > 0,
  };

  const warnings = [];
  const reached = { "in-progress": ["in-progress"], paused: ["in-progress"], "in-review": ["in-progress", "in-review"], complete: ["in-progress", "in-review", "complete"] }[record.status] ?? [];
  if (!statuses.length) warnings.push(`no status transitions for ${record.roadmap}${ref ? ` on ${ref}` : ""}`);
  else for (const value of reached) if (!first(value)) warnings.push(`no ${value} transition`);
  if (complete && !mergedEntry) warnings.push(`no merge commit names ${record.branch || "(no branch)"}`);

  return {
    type: record.type,
    slug: record.slug,
    dir: record.dir,
    roadmap: record.roadmap,
    branch: record.branch,
    status: record.status,
    ref,
    events: list,
    phases,
    cycle,
    reviewRounds,
    pauses,
    merged: mergedEntry ? { ...mergedEntry } : null,
    postShip,
    warnings,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const closedSeconds = (value) => (value && !value.open && typeof value.seconds === "number" ? [value.seconds] : []);

// Count and medians across items; each median uses only closed intervals (rounds:
// items whose cycle closed; pauses: items that paused and resumed; post-ship: items
// with a measured latency and no pending step) and is null without a sample.
export function aggregateMetrics(items) {
  return {
    count: items.length,
    complete: items.filter((i) => i.status === "complete").length,
    median: {
      plannedSeconds: median(items.flatMap((i) => closedSeconds(i.phases.planned))),
      buildSeconds: median(items.flatMap((i) => closedSeconds(i.phases.build))),
      reviewSeconds: median(items.flatMap((i) => closedSeconds(i.phases.review))),
      cycleSeconds: median(items.flatMap((i) => closedSeconds(i.cycle))),
      pauseSeconds: median(items.flatMap((i) => (i.pauses.count > 0 ? closedSeconds(i.pauses) : []))),
      reviewRounds: median(items.flatMap((i) => (i.cycle && !i.cycle.open ? [i.reviewRounds] : []))),
      postShipLatencySeconds: median(items.flatMap((i) => (typeof i.postShip.latencySeconds === "number" && !i.postShip.pending ? [i.postShip.latencySeconds] : []))),
    },
  };
}
