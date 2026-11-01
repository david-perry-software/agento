// The `config`, `resolve`, `find`, and `ports` subcommands, moved
// unchanged from the legacy switch in `scripts/agento.mjs`.

import { emit, rest, withExit } from "../lib/context.mjs";
import { configDocument, requireSlug, requireType, resolveDocument } from "../lib/resolve.mjs";

export const commands = {
  config() {
    emit(configDocument());
  },
  resolve() {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(resolveDocument(type, slug));
  },
  find() {
    withExit(resolveDocument(null, requireSlug(rest[0])));
  },
  ports() {
    // Stable per-slug ports so concurrent sessions never collide and a resumed
    // session reuses the same numbers (see concurrent-delivery.instructions.md).
    const slug = requireSlug(rest[0]);
    let hash = 0;
    for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const offset = hash % 90;
    emit({ status: "ok", slug, WEB_PORT: 3100 + offset, API_PORT: 4100 + offset, offset });
  },
};
