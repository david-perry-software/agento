// The `release` subcommand, moved unchanged from the legacy switch in
// `scripts/agento.mjs`.

import { emit, options, rest, root, source, usage } from "../lib/context.mjs";
import { releaseVerdict } from "../lib/release.mjs";

export const commands = {
  release() {
    const [shaArg, ...extra] = rest;
    if (!shaArg || extra.length) usage("release takes exactly one <merge-sha>");
    if (!/^[0-9a-f]{7,40}$/.test(shaArg)) usage(`release: <merge-sha> must be 7-40 lowercase hex characters, got ${JSON.stringify(shaArg)}`);
    const { fields, code } = releaseVerdict(shaArg, { wait: options.wait ?? 0, interval: options.interval ?? 10 });
    emit({ ...fields, root, configSource: source }, code);
  },
};
