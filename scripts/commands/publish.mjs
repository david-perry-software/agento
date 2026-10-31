// The `sync`, `step-commit`, `plan-publish`, `review-publish`, and
// `publish-pr` subcommands and their delivery-run choreography, moved unchanged
// from the legacy switch in `scripts/agento.mjs`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { windowVerdict } from "../session-state.mjs";
import {
  artifacts,
  artifactsRoot,
  config,
  emit,
  git,
  options,
  rest,
  root,
  source,
  startDir,
  usage,
} from "../lib/context.mjs";
import { fetchOrigin, mergeRef, pushRef, SHIP_EXIT } from "../lib/delivery-run.mjs";
import { gitRun, isAncestor } from "../lib/git.mjs";
import { ghRun } from "../lib/github.mjs";
import { deliveryBranch } from "../lib/layout.mjs";
import { originOf } from "../lib/paths.mjs";
import { header } from "../lib/records.mjs";
import { once } from "../lib/release.mjs";
import { requireSlug, requireType } from "../lib/resolve.mjs";
import { sessionRecord, treeState } from "../lib/session.mjs";
import { confirmTokenFor, isConflicting, parseRoadmapSteps, prSummary, roadmapPathOnRef, shipPrLookup, stampChangelog, utcDate, waitForChecks } from "../lib/ship.mjs";

// --- sync and step-commit: the Builder's integration and commit choreography --

const STEP_EXIT = { ok: 0, reverify: 2, rejected: 3, failed: 3 };
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: \S/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The slug's build window (§11) on the roadmap's branch in every half; never the
// default branch, never detached — the guard cannot see the git this CLI runs.
function buildWindow(type, slug, command = `build-${type}`) {
  const record = sessionRecord();
  const verdict = windowVerdict({ command, record, slug, defaultBranch: config.branches.default });
  const base = { record, allowed: verdict.allowed, elsewhere: verdict.elsewhere, warnings: [...record.warnings] };
  const reject = (reason, message = reason) => ({ ok: false, reason, message, ...base });
  if (!verdict.match) return reject(verdict.reason);
  const { worktree, delivery, companion } = record;
  if (delivery?.type !== type || !delivery.roadmap) return reject(`wrong window: this ${record.role} window holds no roadmap for ${type}/${slug} (${worktree.path})`);
  const { branch } = delivery;
  const defaultBranch = config.branches.default;
  const halves = [{ label: "product", path: worktree.path, branch: worktree.branch, detached: worktree.detached }];
  if (artifacts.external) {
    if (!companion?.registered || !fs.existsSync(companion.path)) return reject("companion-missing", `the companion half for ${type}/${slug} is not a registered worktree on disk (${companion?.path ?? "none"})`);
    halves.push({ label: "companion", path: companion.path, branch: companion.branch, detached: companion.detached });
  }
  for (const half of halves) {
    if (half.detached || !half.branch) return reject("detached-head", `the ${half.label} half ${half.path} is on a detached HEAD; switch it to ${branch} first`);
    if (half.branch === defaultBranch) return reject("default-branch", `the ${half.label} half ${half.path} is on ${defaultBranch}; never commit or push to the default branch`);
    if (half.branch !== branch) return reject("branch-mismatch", `the ${half.label} half ${half.path} is on ${half.branch}, but the roadmap names ${branch}`);
  }
  return { ok: true, ...base, branch, defaultBranch, delivery, halves: halves.map(({ label, path: p }) => ({ label, path: p })), artifactHalf: halves.at(-1).path, slugDir: delivery.dir, roadmapRel: delivery.roadmap };
}

// One JSON document per call; every stop emits it with the exit code of its status.
function deliveryRun(command, type, slug, fields) {
  const out = { status: "ok", command, phase: "window", outcome: null, type, slug, branch: deliveryBranch(type, slug), mode: artifacts.external ? "companion" : "in-repo", ...fields, halves: { product: null, companion: null }, conflicts: [], actions: [], reason: null, message: null, fix: null, reauth: null, next: [], allowed: [], elsewhere: [], warnings: [], root, configSource: source };
  const finish = (extra = {}) => {
    for (const half of Object.values(out.halves)) if (half) half.head = git(half.path, "rev-parse", "HEAD") || null;
    const result = { ...out, ...extra };
    emit(result, STEP_EXIT[result.status]);
  };
  return {
    out,
    finish,
    reject: (reason, extra = {}) => finish({ status: "rejected", reason, ...extra }),
    fail: (reason, message, extra = {}) => finish({ status: "failed", reason, message, ...extra }),
    act: (step, detail) => out.actions.push({ step, detail }),
  };
}

// The window check shared by the delivery subcommands; returns the halves as live result entries.
function openDeliveryRun(run, type, slug, command = `build-${type}`) {
  const win = buildWindow(type, slug, command);
  Object.assign(run.out, { allowed: win.allowed, elsewhere: win.elsewhere, warnings: win.warnings });
  if (!win.ok) run.reject(win.reason, { message: win.message });
  run.out.branch = win.branch;
  const halves = win.halves.map((h) => (run.out.halves[h.label] = { label: h.label, path: h.path, head: null, merged: [], pushed: false }));
  return { win, halves };
}

// Fetch every half, then merge origin/<branch> and origin/<default> where they are not
// ancestors of HEAD (never a rebase); a conflict is aborted and stops the run unpushed.
// `defaultHalves` limits the origin/<default> merge to those half labels (null: every half).
function integrateHalves(run, win, halves, { defaultHalves = null } = {}) {
  run.out.phase = "integrate";
  for (const half of halves) {
    const fetched = fetchOrigin(half.path);
    if (fetched.ok) continue;
    if (fetched.auth) run.fail("fetch-auth", `${fetched.message}; nothing was pushed`, { reauth: fetched.reauth });
    run.fail("fetch-failed", `${fetched.message}; nothing was pushed — re-send once origin is reachable`);
  }
  const merged = [];
  for (const half of halves) {
    for (const [ref, kind] of [[`origin/${win.branch}`, "branch"], [`origin/${win.defaultBranch}`, "default"]]) {
      if (kind === "default" && defaultHalves && !defaultHalves.includes(half.label)) continue;
      if (!git(half.path, "rev-parse", "--verify", "--quiet", ref) || isAncestor(half.path, ref, "HEAD")) continue;
      const result = mergeRef(half.path, ref);
      if (!result.ok) {
        const files = result.conflicts.length ? result.conflicts.join(", ") : "(no paths reported)";
        run.reject("integration-conflict", { half: half.label, ref, conflicts: result.conflicts, message: `merging ${ref} into ${win.branch} at ${half.path} conflicts in ${files} (${result.stderr || "merge failed"}); the merge was aborted${result.clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; nothing was pushed — resolve it by hand per the concurrent-delivery hotspot recipes, then re-send`, fix: `git -C ${half.path} merge ${ref}` });
      }
      half.merged.push(ref);
      merged.push({ half: half.label, ref, kind });
      run.act("integrate", `${half.label}: merged ${ref} into ${win.branch} at ${half.path}`);
    }
  }
  return merged;
}

// Push every half whose HEAD is not on origin/<branch> yet (or has no upstream), product first.
function pushHalves(run, win, halves) {
  run.out.phase = "push";
  for (const half of halves) {
    const upstream = git(half.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    const remote = git(half.path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${win.branch}`);
    if (upstream && remote && remote === git(half.path, "rev-parse", "HEAD")) continue;
    // A full refspec, so a branch named `+x` can never become a forced push.
    const result = pushRef(half.path, `refs/heads/${win.branch}:refs/heads/${win.branch}`, { setUpstream: !upstream });
    if (!result.ok) run.fail(result.reason, `${result.message}; pushed so far: ${halves.filter((h) => h.pushed).map((h) => h.label).join(", ") || "nothing"} — re-send to resume`, result.reauth ? { reauth: result.reauth } : {});
    half.pushed = true;
    run.out.pushed?.push(half.label);
    run.act("push", `${half.label}: pushed ${win.branch} from ${half.path}`);
  }
}

function deliveryArgs(command, extra = "") {
  const type = requireType(rest[0]);
  const slug = requireSlug(rest[1]);
  if (rest.length > 2) usage(`${command} takes <feature|issue> <slug>${extra}, got extra ${JSON.stringify(rest.slice(2).join(" "))}`);
  return { type, slug };
}

function sync() {
  const { type, slug } = deliveryArgs("sync");
  const run = deliveryRun("sync", type, slug, { merged: false, pushed: [] });
  const { win, halves } = openDeliveryRun(run, type, slug);
  for (const half of halves) {
    const tree = treeState(half.path);
    if (tree?.tracked.length) run.reject("dirty", { half: half.label, paths: tree.tracked, message: `the ${half.label} half ${half.path} has uncommitted tracked changes (${tree.tracked.join(", ")}); commit them with step-commit, or discard them, then re-send` });
  }
  const merged = integrateHalves(run, win, halves);
  run.out.merged = merged.length > 0;
  pushHalves(run, win, halves);
  run.out.phase = "done";
  run.finish({ outcome: merged.length ? "merged" : run.out.pushed.length ? "pushed" : "up-to-date", message: merged.length ? `merged ${merged.map((m) => `${m.ref} (${m.half})`).join(", ")}; re-verify before the next commit` : null });
}

// The message file must sit outside both halves, or `add -A` would commit it.
function insideDir(file, dir) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(dir), path.join(real(path.dirname(file)), path.basename(file)));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// `artifact-pr: "#<n>"` into the roadmap's YAML header, after github-issue when present.
function withArtifactPr(content, number) {
  const lines = content.split("\n");
  const open = lines.findIndex((l) => /^```ya?ml\s*$/.test(l));
  const close = open === -1 ? -1 : lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  if (close === -1) return null;
  const issue = lines.findIndex((l, i) => i > open && i < close && /^github-issue:/.test(l));
  lines.splice(issue === -1 ? close : issue + 1, 0, `artifact-pr: "#${number}"`);
  return lines.join("\n");
}

function stepCommit() {
  const { type, slug } = deliveryArgs("step-commit", " [--step N.M] --message-file <file|->");
  if (!options.messageFile) usage("step-commit needs --message-file <file|-> (- reads the message from stdin)");
  const step = options.step ?? null;
  const run = deliveryRun("step-commit", type, slug, { step, commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, companionPr: null });
  const { win, halves } = openDeliveryRun(run, type, slug);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  // The message: a Conventional Commit naming the step, from outside both halves.
  run.out.phase = "message";
  let message;
  if (options.messageFile === "-") message = fs.readFileSync(0, "utf8");
  else {
    const file = path.resolve(startDir, options.messageFile);
    const holder = halves.find((h) => insideDir(file, h.path));
    if (holder) run.reject("message-file-inside-half", { message: `${file} is inside the ${holder.label} half ${holder.path}, so it would be committed; write it outside both halves or pass --message-file - on stdin` });
    if (!fs.existsSync(file)) usage(`--message-file ${file} does not exist`);
    message = fs.readFileSync(file, "utf8");
  }
  message = message.replace(/\s+$/, "");
  const subject = message.split("\n")[0];
  if (!CONVENTIONAL.test(subject)) run.reject("message-not-conventional", { message: `the first message line ${JSON.stringify(subject)} is not a Conventional Commit (<type>[(<scope>)][!]: <description>)` });
  if (step && !new RegExp(`(^|[^0-9.])${escapeRe(step)}(?![0-9])`).test(message)) run.reject("message-missing-step", { message: `--step ${step} is set but the commit message does not name ${step}` });

  // Staging (Q1): everything in the product half; in companion mode only the slug directory.
  run.out.phase = "stage";
  const productTree = treeState(product.path);
  const companionTree = companion ? treeState(companion.path) : null;
  // `--no-renames` lists a staged rename's origin as a deletion, which status -z hides.
  const staged = (half) => git(half.path, "diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
  const outsideSlug = (paths) => [...new Set(paths)].filter((p) => !p.startsWith(`${win.slugDir}/`)).sort();
  if (companionTree) {
    const outside = outsideSlug([...companionTree.tracked, ...companionTree.untracked, ...staged(companion)]);
    if (outside.length) run.reject("companion-outside-slug", { paths: outside, message: `the companion half ${companion.path} has changes outside ${win.slugDir}/: ${outside.join(", ")}; delete byproducts or move them out, then re-send` });
  }
  const changed = (tree) => Boolean(tree && tree.tracked.length + tree.untracked.length);
  const productChanged = changed(productTree);
  const companionChanged = changed(companionTree);

  // The roadmap rule (Q2): a step's tick lands in this commit; otherwise roadmap.md changed.
  if (productChanged || companionChanged) {
    const roadmapFile = path.join(artifactHalf.path, win.roadmapRel);
    const working = fs.existsSync(roadmapFile) ? fs.readFileSync(roadmapFile, "utf8") : "";
    const committed = git(artifactHalf.path, "show", `HEAD:${win.roadmapRel}`);
    if (step) {
      const tick = new RegExp(`^\\s*- \\[[xX]\\] ${escapeRe(step)}(?=\\s)`, "m");
      if (!tick.test(working) || tick.test(committed)) run.reject("step-not-ticked", { message: `${win.roadmapRel} must tick - [x] ${step} in this commit (${tick.test(committed) ? "it is already ticked at HEAD" : "it is not ticked"}); tick it after its verify: passes, or send without --step for a roadmap-only update` });
    } else if (gitRun(artifactHalf.path, ["diff", "--quiet", "HEAD", "--", win.roadmapRel]).ok) {
      run.reject("roadmap-not-updated", { message: `${win.roadmapRel} is unchanged; every delivery commit carries its roadmap.md update (next-step, status, or last-updated)` });
    }
  }

  // Commits: product first, then the companion's tick; plain commits, hooks run.
  run.out.phase = "commit";
  const messageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-step-commit-"));
  process.on("exit", () => fs.rmSync(messageDir, { recursive: true, force: true }));
  const messageFile = path.join(messageDir, "message");
  fs.writeFileSync(messageFile, `${message}\n`);
  const commit = (half, pathspec, file = messageFile) => {
    const add = gitRun(half.path, ["add", "-A", "--", pathspec]);
    if (!add.ok) run.fail("stage-failed", `git -C ${half.path} add -A -- ${pathspec}: ${add.stderr}`);
    if (half === companion) {
      const escaped = outsideSlug(staged(half));
      if (escaped.length) run.fail("companion-outside-slug", `the companion index at ${half.path} holds paths outside ${win.slugDir}/ (${escaped.join(", ")}); nothing was committed there — unstage them, then re-send`, { half: half.label, paths: escaped });
    }
    const result = gitRun(half.path, ["commit", "-q", "-F", file, "--", pathspec], 300000);
    if (!result.ok) run.fail("commit-failed", `git -C ${half.path} commit: ${result.stderr || result.stdout}; nothing was pushed — fix it and re-send`, { half: half.label });
    const sha = git(half.path, "rev-parse", "HEAD");
    const files = git(half.path, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    run.act("commit", `${half.label}: ${sha.slice(0, 7)} ${git(half.path, "log", "-1", "--format=%s")} (${files.join(", ")})`);
    return sha;
  };
  if (productChanged) run.out.commits.product = commit(product, ".");
  if (companionChanged) run.out.commits.companion = commit(companion, win.slugDir);
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);

  // Integrate both defaults; a default merge means the step's verify: runs again first.
  const merged = integrateHalves(run, win, halves);
  run.out.integrated = merged;
  const defaults = merged.filter((m) => m.kind === "default");
  if (defaults.length) {
    run.finish({ status: "reverify", outcome: "merged-default", message: `merged ${defaults.map((m) => `${m.ref} (${m.half})`).join(", ")}; nothing was pushed — rerun the step's verify:, then re-send the same step-commit to push` });
  }
  pushHalves(run, win, halves);
  ensureDeliveryPrs(run, win, { type, slug, commit, messageDir });
  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-pushed" });
}

// Clean handoff: nothing uncommitted, nothing unpushed, in every half.
function cleanHandoff(run, halves) {
  run.out.phase = "check";
  const dirty = halves.map((h) => ({ half: h, tree: treeState(h.path) })).filter(({ tree }) => !tree || tree.tracked.length || tree.untracked.length || tree.ahead);
  if (dirty.length) {
    run.fail("not-clean", dirty.map(({ half, tree }) => `${half.label} half ${half.path}: ${tree ? `tracked ${tree.tracked.join(", ") || "none"}; untracked ${tree.untracked.join(", ") || "none"}; ahead ${tree.ahead}` : "unreadable"}`).join("; "), { paths: dirty.flatMap(({ tree }) => (tree ? [...tree.tracked, ...tree.untracked] : [])) });
  }
}

// A temporary directory for commit messages, removed on exit.
function messageScratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every changed path in a half: tracked, untracked, and staged (a rename's origin too).
function changedPaths(half) {
  const tree = treeState(half.path);
  const staged = git(half.path, "diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
  return [...new Set([...(tree ? [...tree.tracked, ...tree.untracked] : []), ...staged])].sort();
}

// Reject changes outside the slug directory (artifact half) and any change in the other half.
function rejectOutsideSlug(run, win, halves, artifactHalf) {
  for (const half of halves) {
    const paths = changedPaths(half);
    const outside = half === artifactHalf ? paths.filter((p) => !p.startsWith(`${win.slugDir}/`)) : paths;
    if (outside.length) run.reject("outside-slug", { half: half.label, paths: outside, message: `the ${half.label} half ${half.path} has changes outside ${half === artifactHalf ? `${win.slugDir}/` : "the delivery artifacts (it must be clean)"}: ${outside.join(", ")}; commit, move, or delete them, then re-send` });
  }
}

// `add -A` and a plain commit (hooks run) limited to `pathspec`; null pathspec with `allowEmpty` makes an empty commit.
function commitHalf(run, half, pathspec, file, { allowEmpty = false } = {}) {
  if (pathspec) {
    const add = gitRun(half.path, ["add", "-A", "--", pathspec]);
    if (!add.ok) run.fail("stage-failed", `git -C ${half.path} add -A -- ${pathspec}: ${add.stderr}`);
  }
  const result = gitRun(half.path, ["commit", "-q", "-F", file, ...(allowEmpty ? ["--allow-empty"] : []), ...(pathspec ? ["--", pathspec] : [])], 300000);
  if (!result.ok) run.fail("commit-failed", `git -C ${half.path} commit: ${result.stderr || result.stdout}; nothing was pushed — fix it and re-send`, { half: half.label });
  const sha = git(half.path, "rev-parse", "HEAD");
  const files = git(half.path, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
  run.act("commit", `${half.label}: ${sha.slice(0, 7)} ${git(half.path, "log", "-1", "--format=%s")}${files.length ? ` (${files.join(", ")})` : ""}`);
  return sha;
}

function writeMessage(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

// The Planner's publish: commit the plan, publish both halves, open the draft PRs.
function planPublish() {
  const { type, slug } = deliveryArgs("plan-publish");
  const run = deliveryRun("plan-publish", type, slug, { commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, companionPr: null });
  const { win, halves } = openDeliveryRun(run, type, slug, `new-${type}`);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  run.out.phase = "validate";
  for (const name of ["plan.md", "roadmap.md"]) {
    if (!fs.existsSync(path.join(artifactHalf.path, win.slugDir, name))) run.reject("artifact-missing", { message: `${win.slugDir}/${name} is missing in the ${artifactHalf.label} half ${artifactHalf.path}; write plan.md and roadmap.md before publishing` });
  }
  const roadmapBranch = header(fs.readFileSync(path.join(artifactHalf.path, win.roadmapRel), "utf8"), "branch");
  if (roadmapBranch !== win.branch) run.reject("branch-mismatch", { message: `${win.roadmapRel} names branch ${JSON.stringify(roadmapBranch)}, but the halves are on ${win.branch}` });
  rejectOutsideSlug(run, win, halves, artifactHalf);

  // Commits: the slug directory in the artifact half; companion mode opens the product branch empty.
  run.out.phase = "commit";
  const messageDir = messageScratch("agento-plan-publish-");
  if (changedPaths(artifactHalf).length) {
    const published = Boolean(git(artifactHalf.path, "ls-tree", "--name-only", "HEAD", "--", `${win.slugDir}/plan.md`));
    const message = published ? `docs(${type}): revise plan ${slug}` : companion ? `docs(${type}): plan ${slug}` : `docs(delivery): plan ${slug}`;
    run.out.commits[artifactHalf.label] = commitHalf(run, artifactHalf, win.slugDir, writeMessage(messageDir, "plan", message));
  }
  if (companion && (Number.parseInt(git(product.path, "rev-list", "--count", `origin/${win.defaultBranch}..HEAD`), 10) || 0) === 0) {
    run.out.commits.product = commitHalf(run, product, null, writeMessage(messageDir, "open", `chore(${type}): open ${slug}`), { allowEmpty: true });
  }
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);

  run.out.integrated = integrateHalves(run, win, halves);
  pushHalves(run, win, halves);
  ensureDeliveryPrs(run, win, { type, slug, commit: (half, pathspec, file) => commitHalf(run, half, pathspec, file), messageDir });
  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-published" });
}

// `--body-file <file|->`: stdin, or a file outside every one of `dirs` (a later `add -A` would commit it).
function readBodyFile(dirs) {
  if (!options.bodyFile) return { text: null, inside: null };
  if (options.bodyFile === "-") return { text: fs.readFileSync(0, "utf8"), inside: null };
  const file = path.resolve(startDir, options.bodyFile);
  const inside = dirs.find((d) => insideDir(file, d)) ?? null;
  if (inside) return { text: null, inside, file };
  if (!fs.existsSync(file)) usage(`--body-file ${file} does not exist`);
  return { text: fs.readFileSync(file, "utf8"), inside: null, file };
}

function ghJson(run, cwd, args, what) {
  const result = ghRun(cwd, args, 30000);
  if (!result.ok) ghFailOf(run)(result, what);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return run.fail("gh-error", `${what} returned non-JSON output`);
  }
}

// The Reviewer's publish: commit review.md, integrate, push, and upsert one verdict comment on the code PR.
function reviewPublish() {
  const { type, slug } = deliveryArgs("review-publish", " [--body-file <file|->]");
  const run = deliveryRun("review-publish", type, slug, { verdict: null, commits: { product: null, companion: null }, integrated: [], pushed: [], pr: null, comment: null });
  const { win, halves } = openDeliveryRun(run, type, slug);
  const [product, companion = null] = halves;
  const artifactHalf = companion ?? product;

  run.out.phase = "validate";
  const body = readBodyFile(halves.map((h) => h.path));
  if (body.inside) run.reject("body-file-inside-half", { message: `${body.file} is inside ${body.inside}, so it would be committed; write it outside both halves or pass --body-file - on stdin` });
  const reviewRel = `${win.slugDir}/review.md`;
  const reviewFile = path.join(artifactHalf.path, reviewRel);
  if (!fs.existsSync(reviewFile)) run.reject("review-missing", { message: `${reviewRel} is missing in the ${artifactHalf.label} half ${artifactHalf.path}; write the review first` });
  const review = fs.readFileSync(reviewFile, "utf8");
  if (!new RegExp(`^# Review: ${escapeRe(slug)}\\s*$`, "m").test(review)) run.reject("review-heading", { message: `${reviewRel} must open with "# Review: ${slug}"` });
  const verdicts = [...review.matchAll(/^Verdict:\s*(.*?)\s*$/gm)].map((m) => m[1]);
  if (verdicts.length !== 1 || !["approve", "request-changes"].includes(verdicts[0])) {
    run.reject("verdict-invalid", { verdicts, message: `${reviewRel} must carry exactly one "Verdict: approve" or "Verdict: request-changes" line; found ${verdicts.length ? verdicts.map((v) => JSON.stringify(v)).join(", ") : "none"}` });
  }
  const verdict = verdicts[0];
  run.out.verdict = verdict;
  rejectOutsideSlug(run, win, halves, artifactHalf);

  // The code PR must exist before anything is written.
  const prResult = ghRun(product.path, ["pr", "view", win.branch, "--json", "number,state,url,isDraft"], 20000);
  if (!prResult.ok && !/no pull requests found/i.test(prResult.stderr)) ghFailOf(run)(prResult, `gh pr view ${win.branch}`);
  const pr = prResult.ok ? JSON.parse(prResult.stdout) : null;
  if (!pr) run.reject("pr-missing", { message: `no pull request for ${win.branch} in the product repository; the Builder opens the draft PR on its first step-commit` });
  if (pr.state !== "OPEN") run.reject("pr-not-open", { message: `PR #${pr.number} for ${win.branch} is ${pr.state.toLowerCase()} (${pr.url}); a review is posted on an open PR only` });
  run.out.pr = { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft), url: pr.url ?? null };

  run.out.phase = "commit";
  const messageDir = messageScratch("agento-review-publish-");
  if (changedPaths(artifactHalf).length) {
    run.out.commits[artifactHalf.label] = commitHalf(run, artifactHalf, win.slugDir, writeMessage(messageDir, "review", `docs(${type}): review ${slug} — ${verdict}`));
  }
  const committed = Boolean(run.out.commits.product || run.out.commits.companion);
  // The reviewed code never changes under the verdict: only the companion half takes its default.
  run.out.integrated = integrateHalves(run, win, halves, { defaultHalves: ["companion"] });
  pushHalves(run, win, halves);

  // One verdict comment per delivery, found by its marker and author; a re-review edits it.
  run.out.phase = "comment";
  const repoField = (cwd, field) => {
    const result = ghRun(cwd, ["repo", "view", "--json", field, "-q", `.${field}`], 15000);
    if (!result.ok) ghFailOf(run)(result, `gh repo view --json ${field} in ${cwd}`);
    return result.stdout;
  };
  const nwo = repoField(product.path, "nameWithOwner");
  const marker = `<!-- agento:review ${type}/${slug} -->`;
  const text = [`Verdict: ${verdict}`, `Review: ${repoField(artifactHalf.path, "url")}/blob/${win.branch}/${reviewRel}`, ...(body.text?.trim() ? [body.text.trim()] : []), marker].join("\n\n");
  const login = ghJson(run, product.path, ["api", "user"], "gh api user").login;
  let existing = null;
  for (let page = 1; !existing; page += 1) {
    const list = ghJson(run, product.path, ["api", `repos/${nwo}/issues/${pr.number}/comments?per_page=100&page=${page}`], `gh api repos/${nwo}/issues/${pr.number}/comments`);
    existing = list.find((c) => c.user?.login === login && (c.body ?? "").includes(marker)) ?? null;
    if (list.length < 100) break;
  }
  if (!existing) {
    const posted = ghJson(run, product.path, ["api", `repos/${nwo}/issues/${pr.number}/comments`, "-X", "POST", "-f", `body=${text}`], `gh api repos/${nwo}/issues/${pr.number}/comments -X POST`);
    run.out.comment = { id: posted.id, url: posted.html_url ?? null, action: "posted" };
    run.act("comment-post", `verdict comment posted on PR #${pr.number} (${verdict})`);
  } else if (existing.body !== text) {
    const edited = ghJson(run, product.path, ["api", `repos/${nwo}/issues/comments/${existing.id}`, "-X", "PATCH", "-f", `body=${text}`], `gh api repos/${nwo}/issues/comments/${existing.id} -X PATCH`);
    run.out.comment = { id: existing.id, url: edited.html_url ?? existing.html_url ?? null, action: "updated" };
    run.act("comment-update", `verdict comment ${existing.id} on PR #${pr.number} updated (${verdict})`);
  } else run.out.comment = { id: existing.id, url: existing.html_url ?? null, action: "unchanged" };

  cleanHandoff(run, halves);
  run.out.phase = "done";
  run.finish({ outcome: committed ? "committed" : run.out.pushed.length ? "pushed" : "already-published" });
}


function ghFailOf(run) {
  return (result, what) => {
    if (result.missing || /HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(result.stderr)) run.fail("gh-auth", `${what}: ${result.stderr.split("\n")[0]}`, { reauth: "gh auth login" });
    run.fail("gh-error", `${what}: ${result.stderr.split("\n")[0]}`);
  };
}

// Draft PRs when missing: the code PR, the companion PR, their cross-link, and artifact-pr:.
// `commit(half, pathspec, messageFile)` makes the companion header commit.
function ensureDeliveryPrs(run, win, { type, slug, commit, messageDir }) {
  run.out.phase = "pr";
  const [product, companion = null] = win.halves;
  const artifactHalf = companion ?? product;
  const ghFail = ghFailOf(run);
  const prView = (cwd) => {
    const result = ghRun(cwd, ["pr", "view", win.branch, "--json", "number,state,url,body,isDraft"], 20000);
    if (!result.ok) {
      if (/no pull requests found/i.test(result.stderr)) return null;
      ghFail(result, `gh pr view ${win.branch} in ${cwd}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return run.fail("gh-error", `gh pr view ${win.branch} in ${cwd} returned non-JSON output`);
    }
  };
  const prCreate = (cwd, base, title, body, label) => {
    const result = ghRun(cwd, ["pr", "create", "--draft", "--base", base, "--head", win.branch, "--title", title, "--body", body], 60000);
    if (!result.ok) ghFail(result, `gh pr create --draft --head ${win.branch} in ${cwd}`);
    const created = prView(cwd);
    if (!created) run.fail("gh-error", `gh pr create for ${win.branch} in ${cwd} returned but the PR cannot be looked up`);
    run.act(label, `opened draft PR #${created.number} for ${win.branch} (${created.url})`);
    return created;
  };
  const repoView = (cwd, field) => {
    const result = ghRun(cwd, ["repo", "view", "--json", field, "-q", `.${field}`], 15000);
    if (!result.ok) ghFail(result, `gh repo view --json ${field} in ${cwd}`);
    return result.stdout;
  };
  const roadmapFile = path.join(artifactHalf.path, win.roadmapRel);
  const issueNumber = type === "issue" ? header(fs.readFileSync(roadmapFile, "utf8"), "github-issue").match(/\d+/)?.[0] ?? null : null;
  let pr = prView(product.path);
  if (!pr) {
    const plan = `${win.slugDir}/plan.md`;
    const planLink = companion ? `${repoView(companion.path, "url")}/blob/${win.branch}/${plan}` : plan;
    pr = prCreate(product.path, win.defaultBranch, slug, `${issueNumber ? `Fixes #${issueNumber}\n\n` : ""}Plan: ${planLink}`, "pr-create");
  }
  let companionPr = null;
  if (companion) {
    companionPr = prView(companion.path) ?? prCreate(companion.path, win.defaultBranch, `docs(${type}): ${slug}`, `Delivery artifacts for ${slug}. Code PR: ${pr.url}`, "companion-pr-create");
    if (!(pr.body ?? "").includes(companionPr.url)) {
      const body = `${(pr.body ?? "").replace(/\s+$/, "")}\n\nCompanion PR: ${companionPr.url}`.replace(/^\n+/, "");
      const nwo = repoView(product.path, "nameWithOwner");
      const patch = ghRun(product.path, ["api", `repos/${nwo}/pulls/${pr.number}`, "-X", "PATCH", "-f", `body=${body}`], 20000);
      if (!patch.ok) ghFail(patch, `gh api repos/${nwo}/pulls/${pr.number} -X PATCH`);
      pr.body = body;
      run.act("pr-cross-link", `Companion PR: ${companionPr.url} appended to the body of PR #${pr.number}`);
    }
    const content = fs.readFileSync(roadmapFile, "utf8");
    if (!header(content, "artifact-pr")) {
      const updated = withArtifactPr(content, companionPr.number);
      if (updated === null) run.fail("roadmap-header", `${win.roadmapRel} has no YAML header block to record artifact-pr: in`);
      fs.writeFileSync(roadmapFile, updated);
      const headerMessage = path.join(messageDir, "artifact-pr");
      fs.writeFileSync(headerMessage, `docs(${type}): record artifact PR for ${slug}\n`);
      run.out.commits.companion = commit(run.out.halves.companion, win.roadmapRel, headerMessage);
      pushHalves(run, win, [run.out.halves.companion]);
    }
  }
  const summary = (p) => (p ? { number: p.number, state: p.state, isDraft: Boolean(p.isDraft), url: p.url ?? null } : null);
  run.out.pr = summary(pr);
  run.out.companionPr = summary(companionPr);
  return { pr, companionPr };
}


// --- publish-pr: a changes branch's push → PR → wait → merge → sync --------------

const normalizeRemote = (url) => (url ?? "").trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

function publishPr() {
  if (rest.length) usage(`publish-pr takes no positional arguments, got ${JSON.stringify(rest.join(" "))}`);
  const requested = path.resolve(options.dir ?? startDir);
  const checkout = git(requested, "rev-parse", "--show-toplevel") || null;
  const out = { status: "ok", command: "publish-pr", phase: "checkout", outcome: null, checkout: { path: checkout ?? requested, repo: null, linked: false, defaultBranch: null }, branch: null, merge: Boolean(options.merge), pr: null, mergeSha: null, sync: null, conflicts: [], actions: [], reason: null, message: null, fix: null, reauth: null, next: [], warnings: [], root, configSource: source };
  const finish = (extra = {}) => {
    const result = { ...out, ...extra };
    emit(result, SHIP_EXIT[result.status]);
  };
  const run = {
    out,
    finish,
    reject: (reason, extra = {}) => finish({ status: "rejected", reason, ...extra }),
    fail: (reason, message, extra = {}) => finish({ status: "failed", reason, message, ...extra }),
    act: (step, detail) => out.actions.push({ step, detail }),
  };
  const ghFail = ghFailOf(run);

  // The checkout: the product repository or the configured companion, by origin URL.
  if (!checkout) run.reject("unknown-repo", { message: `${requested} is not a git checkout` });
  const origin = normalizeRemote(originOf(checkout));
  let repo = null;
  if (origin && origin === normalizeRemote(originOf(root))) repo = "product";
  else if (artifacts.external && origin && origin === normalizeRemote(originOf(artifactsRoot))) repo = "companion";
  if (!repo) run.reject("unknown-repo", { message: `${checkout} (origin ${originOf(checkout) ?? "none"}) is a checkout of neither the product repository nor the configured companion` });
  const defaultBranch = config.branches.default;
  const absolute = (p) => path.resolve(checkout, p);
  const linked = absolute(git(checkout, "rev-parse", "--git-dir")) !== absolute(git(checkout, "rev-parse", "--git-common-dir"));
  out.checkout = { path: checkout, repo, linked, defaultBranch };

  // The branch: the current one, or --branch once the checkout is back on the default.
  out.phase = "branch";
  const current = git(checkout, "branch", "--show-current");
  if (!current) run.reject("detached-head", { message: `${checkout} is on a detached HEAD; switch to the branch to publish` });
  let branch = current;
  if (options.branch && options.branch !== current) {
    if (current !== defaultBranch) run.reject("branch-mismatch", { message: `--branch ${options.branch} is not the checked-out ${current}; --branch only resumes from ${defaultBranch} after the merge` });
    if (!gitRun(checkout, ["check-ref-format", "--branch", options.branch]).ok) usage(`--branch ${JSON.stringify(options.branch)} is not a valid branch name`);
    branch = options.branch;
  }
  out.branch = branch;
  if (branch === defaultBranch) run.reject("default-branch", { message: `${checkout} is on ${defaultBranch}; publish-pr never pushes or merges the default branch` });
  const prefix = [config.branches.feature, config.branches.issue, config.branches.postShip].find((p) => p && branch.startsWith(p));
  if (prefix) run.reject("delivery-branch", { message: `${branch} is a delivery branch (${prefix}…); its PR is merged only by /agento ship` });
  const body = readBodyFile([checkout]);
  if (body.inside) run.reject("body-file-inside-checkout", { message: `${body.file} is inside ${checkout}, so a later commit could pick it up; write it outside the checkout or pass --body-file -` });

  // State: fetch, then the branch's PR decides where this send resumes.
  out.phase = "fetch";
  const fetched = fetchOrigin(checkout);
  if (!fetched.ok) {
    if (fetched.auth) run.fail("fetch-auth", fetched.message, { reauth: fetched.reauth });
    run.fail("fetch-failed", `${fetched.message}; nothing was pushed — re-send once origin is reachable`);
  }
  const prLookup = () => {
    const result = ghRun(checkout, ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,mergeable,url,mergeCommit,baseRefName"], 20000);
    if (!result.ok) {
      if (/no pull requests found/i.test(result.stderr)) return null;
      ghFail(result, `gh pr view ${branch} in ${checkout}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return run.fail("gh-error", `gh pr view ${branch} in ${checkout} returned non-JSON output`);
    }
  };
  const defaultRef = `origin/${defaultBranch}`;
  const aheadOfDefault = () => Number.parseInt(git(checkout, "rev-list", "--count", `${defaultRef}..HEAD`), 10) || 0;
  let pr = prLookup();
  if (pr?.state === "CLOSED") run.reject("pr-closed", { pr: prSummary(pr), message: `PR #${pr.number} for ${branch} was closed without a merge (${pr.url}); reopen it or publish from a new branch` });
  if (pr?.state === "MERGED" && current === branch && aheadOfDefault()) run.reject("pr-merged", { pr: prSummary(pr), message: `PR #${pr.number} for ${branch} is already merged, yet ${branch} carries new commits; publish them from a new branch` });
  if (pr?.state !== "MERGED" && current !== branch) run.reject("default-branch", { message: `${checkout} is on ${defaultBranch} and ${branch} has no merged PR to resume; switch to ${branch} first` });

  if (pr?.state !== "MERGED") {
    out.phase = "check";
    const tree = treeState(checkout);
    if (tree?.tracked.length) run.reject("dirty", { paths: tree.tracked, message: `${checkout} has uncommitted tracked changes (${tree.tracked.join(", ")}); commit them first` });
    if (!aheadOfDefault()) run.reject("nothing-to-publish", { message: `${branch} has no commits beyond ${defaultRef}; commit first — publish-pr never opens an empty PR` });

    // push: a full refspec, never forced; -u on the first push.
    out.phase = "push";
    const push = () => {
      const upstream = git(checkout, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
      const remote = git(checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`);
      if (upstream && remote === git(checkout, "rev-parse", "HEAD")) return;
      const result = pushRef(checkout, `refs/heads/${branch}:refs/heads/${branch}`, { setUpstream: !upstream });
      if (!result.ok) run.fail(result.reason, result.message, result.reauth ? { reauth: result.reauth } : {});
      run.act("push", `pushed ${branch} from ${checkout}`);
    };
    push();

    // pr: reuse the open PR, or open one (never a draft).
    out.phase = "pr";
    if (!pr) {
      const title = options.title ?? git(checkout, "log", "--reverse", "--format=%s", `${defaultRef}..HEAD`).split("\n")[0];
      const create = ghRun(checkout, ["pr", "create", "--base", defaultBranch, "--head", branch, "--title", title, "--body", body.text ?? ""], 60000);
      if (!create.ok) ghFail(create, `gh pr create --head ${branch} in ${checkout}`);
      pr = prLookup();
      if (!pr) run.fail("gh-error", `gh pr create for ${branch} in ${checkout} returned but the PR cannot be looked up`);
      run.act("pr-create", `opened PR #${pr.number} for ${branch} (${pr.url})`);
    }
    out.pr = prSummary(pr);
    if (!options.merge) {
      out.phase = "done";
      finish({ outcome: "opened" });
    }

    // checks: a BEHIND PR takes the default by merge (never a rebase), then the bounded wait.
    out.phase = "checks";
    if (pr.mergeStateStatus === "BEHIND" && !isAncestor(checkout, defaultRef, "HEAD")) {
      const merged = mergeRef(checkout, defaultRef);
      if (!merged.ok) {
        const files = merged.conflicts.length ? merged.conflicts.join(", ") : "(no paths reported)";
        run.reject("integration-conflict", { conflicts: merged.conflicts, message: `merging ${defaultRef} into ${branch} at ${checkout} conflicts in ${files} (${merged.stderr || "merge failed"}); the merge was aborted${merged.clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; nothing was merged — resolve it by hand, push, and re-send`, fix: `git -C ${checkout} merge ${defaultRef}` });
      }
      run.act("integrate", `merged ${defaultRef} into ${branch} at ${checkout}`);
      push();
    }
    let repoArg = null;
    if (repo === "companion") {
      const nwo = ghRun(checkout, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
      if (!nwo.ok) ghFail(nwo, `gh repo view --json nameWithOwner in ${checkout}`);
      repoArg = nwo.stdout;
    }
    const checks = waitForChecks("pr", pr.number, checkout, { repo: repoArg, maxSeconds: options.wait ?? 50 });
    const resend = `node <agento-root>/scripts/agento.mjs publish-pr ${process.argv.slice(3).map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`.trim();
    if (checks.code === 2) finish({ status: "pending", message: `PR #${pr.number}: ${checks.last}`, next: [resend] });
    if (checks.code === 1) finish({ status: "blocked", reason: "checks-failed", message: `PR #${pr.number} has a failing required check (${checks.last}); nothing was merged — fix it on ${branch}, push, and re-send` });
    if (checks.code !== 0) run.fail("gh-auth", `wait-for-checks.sh pr ${pr.number}: ${checks.last}`, { reauth: "gh auth login" });

    // merge: a normal merge commit through the ruleset; never --admin, --squash, --rebase, or --auto.
    out.phase = "merge";
    const merge = ghRun(checkout, ["pr", "merge", String(pr.number), "--merge"], 120000);
    if (!merge.ok) ghFail(merge, `gh pr merge ${pr.number} --merge`);
    run.act("merge", `PR #${pr.number} merged into ${defaultBranch} with a merge commit`);
    pr = prLookup() ?? pr;
  }
  out.pr = prSummary(pr);
  out.mergeSha = pr.mergeCommit?.oid ?? null;

  // delete-branch: the remote branch goes once merged; already gone is a warning.
  out.phase = "delete-branch";
  if (gitRun(checkout, ["ls-remote", "--exit-code", "--heads", "origin", branch]).ok) {
    const del = gitRun(checkout, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) run.act("delete-branch", `origin/${branch} deleted`);
    else out.warnings.push(`delete-branch: git push origin --delete ${branch} failed (${del.stderr.split("\n")[0]})`);
  }

  // sync: the default fast-forwarded and the merged branch deleted — except in a linked
  // worktree, which keeps its branch until /agento close-session removes it.
  out.phase = "sync";
  gitRun(checkout, ["fetch", "--prune", "origin"]);
  out.sync = { switched: false, fastForwarded: false, branchDeleted: false, skipped: null };
  if (linked) {
    out.sync.skipped = `linked worktree ${checkout} stays on ${branch}; /agento close-session removes it and deletes the merged branch`;
    out.next = [`/agento close-session ${branch}`];
  } else {
    if (git(checkout, "branch", "--show-current") !== defaultBranch) {
      const sw = gitRun(checkout, ["switch", defaultBranch]);
      if (!sw.ok) run.fail("sync-failed", `git -C ${checkout} switch ${defaultBranch}: ${sw.stderr.split("\n")[0]}; switch by hand, then re-send`);
      out.sync.switched = true;
      run.act("switch", `switched ${checkout} to ${defaultBranch}`);
    }
    const before = git(checkout, "rev-parse", "HEAD");
    const ff = gitRun(checkout, ["merge", "--ff-only", defaultRef], 120000);
    if (!ff.ok) run.fail("sync-failed", `git -C ${checkout} merge --ff-only ${defaultRef}: ${ff.stderr.split("\n")[0]}; reconcile ${defaultBranch} by hand, then re-send`);
    if (git(checkout, "rev-parse", "HEAD") !== before) {
      out.sync.fastForwarded = true;
      run.act("sync", `${defaultBranch} fast-forwarded to ${defaultRef} at ${checkout}`);
    }
    if (git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
      const deletion = gitRun(checkout, ["branch", "-d", branch]);
      if (deletion.ok) {
        out.sync.branchDeleted = true;
        run.act("delete-local-branch", `local ${branch} deleted at ${checkout}`);
      } else out.warnings.push(`delete-local-branch: git branch -d ${branch} failed: ${deletion.stderr.split("\n")[0]}`);
    }
  }
  out.phase = "done";
  finish({ outcome: out.actions.some((a) => a.step === "merge") ? "merged" : "already-merged" });
}

export const commands = {
  sync() {
    sync();
  },
  "step-commit"() {
    stepCommit();
  },
  "plan-publish"() {
    planPublish();
  },
  "review-publish"() {
    reviewPublish();
  },
  "publish-pr"() {
    publishPr();
  },
};
