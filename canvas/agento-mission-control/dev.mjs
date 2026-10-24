// Dev server for the Mission Control canvas UI. Serves the sanitized fixture
// through the real server.mjs with a stub `send` that prints dispatched prompts
// to stdout instead of pushing them into a chat session, so the panels can be
// exercised locally without the Copilot canvas runtime (steps 4.2–4.7 run against
// local:3103). Not used by the real canvas (extension.mjs wires the real session).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalize } from "./snapshot.mjs";
import { startServer } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const port = Number.parseInt(argValue("port", "3103"), 10);
const fixturePath = path.join(here, "fixtures", "dashboard.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

let snapshot = normalize(fixture);
const primaryPath = () => snapshot.worktrees.entries.find((w) => w.isPrimary)?.path ?? null;

function sampleArtifacts(slug) {
  const plan = `# ${slug} — sample plan

## Problem

The dev server has no artifact checkout, so this **sample** plan stands in. It has
*emphasis*, \`inline code\`, a [link to the roadmap](roadmap.md), an
[external link](https://github.com), and an [evidence file](evidence/shot.png).

## Acceptance

| # | Criterion | Verify |
|---|-----------|:------:|
| 1 | Renders tables | \`node --test\` |
| 2 | Escapes <script>alert(1)</script> | browser |

## Approach

1. Read the plan.
2. Render it:
   - headings, lists, and tables
   - code blocks

\`\`\`js
const safe = "<b>not bold</b>";
\`\`\`

> Note: the real canvas reads these files through \`agento.mjs artifacts\`.

---

Skills consulted: none — no matching domain
`;
  const roadmap = `\`\`\`yaml
status: in-progress
branch: feature/${slug}
\`\`\`

# Roadmap: ${slug}

## Phase 1

- [x] 1.1 First step — verify: \`node --test\`
- [ ] 1.2 Second step — verify: see the [plan](plan.md)
`;
  return {
    plan: { exists: true, content: plan },
    roadmap: { exists: true, content: roadmap },
    review: slug === "canvas-review-fixture" ? { exists: true, content: "# Review\n\nVerdict: request-changes\n\n- Fix the thing.\n" } : { exists: false },
  };
}

const server = await startServer({
  port,
  // Dev-only stand-ins for `agento.mjs windows` / `handoff`: the primary checkout
  // reads as open, every other window as closed, and a handoff is printed.
  windows: async (checkouts) => checkouts.map((checkout) => ({ checkout, known: true, open: checkout === primaryPath(), target: checkout })),
  handoff: async ({ checkout, command }) => {
    process.stdout.write(`handoff: ${command} -> ${checkout}\n`);
    return { status: "ok", wasOpen: checkout === primaryPath(), opened: true, target: checkout };
  },
  // Dev-only stand-in for `agento.mjs artifacts`: sample documents that exercise
  // every Markdown feature the delivery page renders.
  artifacts: async ({ type, slug }) => ({ status: "ok", type, slug, source: "checkout", files: sampleArtifacts(slug) }),
  send: async ({ prompt }) => {
    // A dispatched prompt in dev is printed, never sent anywhere.
    process.stdout.write(`dispatch: ${prompt}\n`);
  },
  onRefresh: async () => {
    // There is no live CLI in dev; refreshing re-reads the fixture.
    snapshot = normalize(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
    server.setState(snapshot);
  },
  log: (line) => process.stdout.write(`${line}\n`),
  onExtra: async ({ req, res, url, respond, readBody, broadcast }) => {
    // Dev-only simulation of the agent's `post_note` and `focus` actions so the
    // feed panel can be exercised without the Copilot canvas runtime.
    if (req.method === "POST" && url.pathname === "/_dev/note") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        respond(res, 400, JSON.stringify({ ok: false, errors: ["json"] }), { "content-type": "application/json; charset=utf-8" });
        return true;
      }
      broadcast("note", { text: String(body?.text ?? ""), at: new Date().toISOString(), level: body?.level ?? "info" });
      respond(res, 204, "", {});
      return true;
    }
    if (req.method === "POST" && url.pathname === "/_dev/focus") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        respond(res, 400, JSON.stringify({ ok: false, errors: ["json"] }), { "content-type": "application/json; charset=utf-8" });
        return true;
      }
      broadcast("focus", { kind: String(body?.kind ?? "delivery"), id: String(body?.id ?? "") });
      respond(res, 204, "", {});
      return true;
    }
    return false;
  },
});

server.setState(snapshot);

process.stdout.write(
  `Mission Control dev server on http://127.0.0.1:${server.port}/ (${snapshot.lanes.length} lanes, ${snapshot.cards.length} cards)\n`
);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
