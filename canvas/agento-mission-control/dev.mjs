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

const server = await startServer({
  port,
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
