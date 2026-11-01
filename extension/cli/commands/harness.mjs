// The `harness` subcommand, moved unchanged from the legacy switch in
// `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { linkState, linkType } from "../harness.mjs";
import { emit, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import { harnessFacts, LOCAL_TAKEOVER, primaryCheckoutOf } from "../lib/copilot.mjs";

export const commands = {
  harness() {
    const [verb, ...extra] = rest;
    const verbs = { status: 0, install: 0, uninstall: 0 };
    if (!Object.hasOwn(verbs, verb)) usage(`harness: unknown verb ${verb ?? "none"}; known: ${Object.keys(verbs).join(", ")}`);
    if (extra.length) usage(`harness ${verb} takes no arguments`);
    if (options.force && verb !== "install") usage(`harness ${verb}: --force is only valid with install`);
    const facts = harnessFacts(options.pluginRoot ?? PLUGIN_ROOT);
    const router = { ...linkState(facts.link, facts.expected), link: facts.link, expected: facts.expected, changed: false };
    const canvas = { ...linkState(facts.canvasLink, facts.canvasExpected), link: facts.canvasLink, expected: facts.canvasExpected, changed: false };
    const doc = {
      status: "ok",
      verb,
      link: facts.link,
      expected: facts.expected,
      state: router.state,
      target: router.target,
      pluginRoot: facts.pluginRoot,
      changed: false,
      localTakeover: LOCAL_TAKEOVER,
      canvas: { link: canvas.link, expected: canvas.expected, state: canvas.state, target: canvas.target, changed: false },
    };

    if (verb === "status") emit(doc);

    if (verb === "install") {
      if (!facts.hasSkill) emit({ ...doc, status: "missing", changed: false, message: `no router skill at ${path.join(facts.pluginRoot, "skills", "agento", "SKILL.md")}` }, 3);
      const primary = primaryCheckoutOf(facts.pluginRoot);
      if (primary) emit({ ...doc, status: "worktree", primaryCheckout: primary, changed: false, message: `${facts.pluginRoot} is a linked worktree of ${primary}, not the registered plugin clone; linked worktrees share the clone's skill — run harness install on the primary clone with --plugin-root ${primary}` }, 3);

      let routerWrite = false;
      if (router.state === "not-a-link") emit({ ...doc, status: "refused", changed: false, message: `${facts.link} is a real directory or file, not a symlink; it is never deleted — move it away, then re-run harness install` }, 3);
      if (router.state === "installed") routerWrite = false;
      else if ((router.state === "foreign" || router.state === "dangling") && !options.force) emit({ ...doc, status: "refused", changed: false, message: `${facts.link} resolves to ${router.target ?? "a missing target"}; re-run harness install with --force to replace it` }, 3);
      else routerWrite = true;

      let canvasWrite = false;
      if (canvas.state === "not-a-link") emit({ ...doc, status: "refused", changed: false, message: `${facts.canvasLink} is a real directory or file, not a symlink; it is never deleted — move it away, then re-run harness install` }, 3);
      if (canvas.state === "installed") canvasWrite = false;
      else if ((canvas.state === "foreign" || canvas.state === "dangling") && !options.force) emit({ ...doc, status: "refused", changed: false, message: `${facts.canvasLink} resolves to ${canvas.target ?? "a missing target"}; re-run harness install with --force to replace it` }, 3);
      else if (facts.hasCanvas) canvasWrite = true; // absent with the canvas present → create the link

      if (routerWrite) {
        if (router.state === "foreign" || router.state === "dangling") fs.unlinkSync(facts.link);
        fs.mkdirSync(facts.skillsDir, { recursive: true });
        fs.symlinkSync(facts.expected, facts.link, linkType());
      }
      if (canvasWrite) {
        if (canvas.state === "foreign" || canvas.state === "dangling") fs.unlinkSync(facts.canvasLink);
        fs.mkdirSync(facts.extensionsDir, { recursive: true });
        fs.symlinkSync(facts.canvasExpected, facts.canvasLink, linkType());
      }

      emit({
        ...doc,
        status: "ok",
        changed: routerWrite,
        state: "installed",
        target: facts.expected,
        canvas: { link: facts.canvasLink, expected: facts.canvasExpected, state: canvasWrite || canvas.state === "installed" ? "installed" : "absent", target: facts.canvasExpected, changed: canvasWrite },
      });
    }

    // uninstall removes each link only when it is installed; anything else is
    // refused and left untouched (absent is a no-op).
    const routerRemove = router.state === "installed";
    const canvasRemove = canvas.state === "installed";
    const refusedRouter = router.state !== "installed" && router.state !== "absent";
    const refusedCanvas = canvas.state !== "installed" && canvas.state !== "absent";
    if (refusedRouter || refusedCanvas) {
      const which = refusedRouter ? facts.link : facts.canvasLink;
      const state = refusedRouter ? router.state : canvas.state;
      emit({ ...doc, status: "refused", changed: false, message: `only an installed link is ever removed; ${which} is ${state === "not-a-link" ? "a real directory or file" : "not the installed link (it resolves elsewhere)"}` }, 3);
    }
    if (routerRemove) fs.unlinkSync(facts.link);
    if (canvasRemove) fs.unlinkSync(facts.canvasLink);
    emit({
      ...doc,
      status: "ok",
      changed: routerRemove || canvasRemove,
      state: "absent",
      target: null,
      canvas: { link: facts.canvasLink, expected: facts.canvasExpected, state: "absent", target: null, changed: canvasRemove },
      warning: routerRemove ? "harness uninstall removed the router link; /agento will no longer resolve in any session" : undefined,
    });
  },
};
