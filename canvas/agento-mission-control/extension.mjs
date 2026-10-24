// Agento Mission Control — canvas wiring (step 5.1).
//
// This module is wiring only: it joins the session and registers the canvas
// declared by `defineMissionControl` (canvas.mjs). The canvas contract forbids
// stdout, so the only output is `session.log`; startup failures are named on
// stderr, which is what the host log captures.
//
// `remoteSession: "off"` stays: the extension process has its sensitive env
// stripped, so remote-export setup during `session.resume` fails. The spike
// (steps 1.2/1.4) confirmed this is required for the canvas to register.

import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";

import { defineMissionControl } from "./canvas.mjs";

let session;
try {
  session = await joinSession({
    // Explicitly opt out of remote sessions so resume stays local (see above).
    remoteSession: "off",
    canvases: [
      defineMissionControl({
        createCanvas,
        CanvasError,
        deps: {
          send: ({ prompt }) => session.send({ prompt }),
          log: (line) => session.log(line),
        },
      }),
    ],
  });
} catch (err) {
  process.stderr.write(
    `agento-mission-control: joinSession failed: ${err && err.stack ? err.stack : String(err)}\n`
  );
  throw err;
}
