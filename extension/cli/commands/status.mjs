// The `status`, `initiative`, `metrics`, and `dashboard` subcommands, moved
// unchanged from the legacy switch in `scripts/agento.mjs`.

import { emit, options, rest, usage } from "../lib/context.mjs";
import { dashboardDocument, initiativeDetailDocument, initiativeListDocument, initiativeRoadmaps, metricsDocument, statusDocument } from "../lib/documents.mjs";
import { requireSlug, requireType } from "../lib/resolve.mjs";

export const commands = {
  status() {
    const typeFilter = rest[0] ? requireType(rest[0]) : null;
    const slugFilter = rest[1] ? requireSlug(rest[1]) : null;
    emit(statusDocument({ typeFilter, slugFilter, pr: Boolean(options.pr) }));
  },
  initiative() {
    const slug = rest[0] ? requireSlug(rest[0]) : null;
    const roadmaps = initiativeRoadmaps();
    const document = slug ? initiativeDetailDocument(slug, roadmaps) : initiativeListDocument(roadmaps);
    emit(document, document.status === "ok" ? 0 : 3);
  },
  metrics() {
    if (rest.length > 1) usage(`metrics takes at most one slug, got ${JSON.stringify(rest.slice(1).join(" "))}`);
    const document = metricsDocument({ slugFilter: rest[0] ? requireSlug(rest[0]) : null });
    emit(document, document.status === "ok" ? 0 : 3);
  },
  async dashboard() {
    if (rest.length) usage(`dashboard takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    emit(await dashboardDocument({ pr: Boolean(options.pr) }));
  },
};
