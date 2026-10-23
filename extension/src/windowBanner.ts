import type { SessionDoctorModel } from "./sessionDoctorModel.js";
import type { ModelProfilesModel } from "./modelProfilesTree.js";
import { ROLE_FOREGROUND_COLOR, roleBannerColor } from "./statusStyle.js";

export const BANNER_CLICK_COMMAND = "agento.sessionDoctor.focus";

export interface WindowBannerModel {
  tone: string;
  title: string;
  detail: string;
  tooltip: string;
  colorId: string;
  /** The optional third banner line naming the model profile in effect. */
  models?: string;
}

const CLICK_HINT = "Click to open Session & Doctor";

function toneOf(colorId: string): string {
  return colorId.slice("agento.role.".length);
}

/**
 * The banner tooltip hint for the opt-in `agento.chatModelPreselect` setting. It
 * names the setting and `agento.mjs models resolve <command>`; for `local`/`copilot`
 * it says preselection targets that harness only (the other still needs the picker).
 */
export function modelPreselectHint(setting: "off" | "local" | "copilot"): string {
  switch (setting) {
    case "local":
      return "Model preselection targets Local sessions only — Copilot sessions still need the model picker (agento.mjs models resolve <command> names it)";
    case "copilot":
      return "Model preselection targets Copilot sessions only — Local sessions still need the model picker (agento.mjs models resolve <command> names it)";
    default:
      return "Model preselection is off — set the model picker by hand (agento.mjs models resolve <command> names it; set agento.chatModelPreselect to local or copilot to automate)";
  }
}

/**
 * True when a configuration change touches `agento.chatModelPreselect`, the one
 * section whose banner hint must be rebuilt immediately (the dispatch resolver
 * already reads the setting live on each call).
 */
export function affectsPreselectHint(event: { affectsConfiguration(section: string): boolean }): boolean {
  return event.affectsConfiguration("agento.chatModelPreselect");
}

export function createWindowBannerModel(model: SessionDoctorModel, models?: string, hint?: string): WindowBannerModel {
  if (model.kind === "error") {
    const colorId = roleBannerColor("");
    return {
      tone: toneOf(colorId),
      title: "AGENTO UNAVAILABLE",
      detail: model.message,
      tooltip: `${model.message}\n${CLICK_HINT}`,
      colorId,
    };
  }

  const { session } = model;
  const colorId = roleBannerColor(session.role);
  const parts =
    session.role === "unmanaged"
      ? ["Agento commands are disabled here — open the primary checkout"]
      : [session.deliverySlug, session.branch, session.lifecycle === "no-delivery" ? null : session.lifecycle].filter(
          (part): part is string => part !== null && part.length > 0,
        );
  if (session.hosted) {
    parts.push("hosted");
  }
  const tooltip = [session.worktreePath, models, hint, CLICK_HINT].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
  return {
    tone: toneOf(colorId),
    title: `${session.role.toUpperCase()} WINDOW`,
    detail: parts.join(" · "),
    tooltip,
    colorId,
    ...(models ? { models } : {}),
  };
}

// The third banner line: the profile in effect in this window, or null when the
// model profiles view is not ready (no line is rendered then).
export function modelsBannerLine(model: ModelProfilesModel): string | null {
  if (model.state !== "ready" || model.roles === null) return null;
  const primaryLabel = model.roles.primary === "custom" ? "custom pins" : model.roles.primary ?? "picker default";
  if (model.windowRole === "secondary") {
    if (model.roles.secondaryState === "on") return `Models: ${model.roles.secondary} (secondary)`;
    if (model.roles.secondaryState === "off") return `Models: secondary off → primary pins: ${primaryLabel}`;
    if (model.roles.secondaryState === "dangling") return `Models: secondary ${model.roles.secondary} missing → primary pins: ${primaryLabel}`;
    return `Models: secondary invalid → primary pins: ${primaryLabel}`;
  }
  if (model.roles.primary === "custom") return "Models: custom pins (primary)";
  if (model.roles.primary === null) return "Models: picker default (primary off)";
  return `Models: ${model.roles.primary} (primary)`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// VS Code webviews replace only the first dot of a color id (`--vscode-agento-role.build`); fall back for both spellings.
function cssColor(colorId: string): string {
  const [prefix, ...rest] = colorId.split(".");
  return `var(--vscode-${colorId.replaceAll(".", "-")}, var(--vscode-${prefix}-${rest.join("\\.")}))`;
}

export function renderWindowBannerHtml(banner: WindowBannerModel, nonce: string): string {
  const safeNonce = escapeHtml(nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${safeNonce}">
html, body { height: 100%; margin: 0; padding: 0; }
body {
  background: ${cssColor(banner.colorId)};
  color: ${cssColor(ROLE_FOREGROUND_COLOR)};
  font-family: var(--vscode-font-family);
}
a.banner {
  display: flex;
  flex-direction: column;
  justify-content: center;
  box-sizing: border-box;
  height: 100%;
  padding: 4px 12px;
  color: inherit;
  text-decoration: none;
}
a.banner:focus-visible { outline: 2px solid ${cssColor(ROLE_FOREGROUND_COLOR)}; outline-offset: -4px; }
.title { display: block; font-weight: 800; font-size: 1.2em; line-height: 1.2; letter-spacing: 0.08em; text-transform: uppercase; }
.detail { display: block; margin-top: 2px; font-size: 0.95em; overflow-wrap: anywhere; }
.models { display: block; margin-top: 2px; font-size: 0.9em; opacity: 0.95; overflow-wrap: anywhere; }
</style>
</head>
<body>
<a class="banner" href="command:${BANNER_CLICK_COMMAND}" title="${escapeHtml(banner.tooltip)}">
<span class="title">${escapeHtml(banner.title)}</span>
<span class="detail">${escapeHtml(banner.detail)}</span>
${banner.models ? `<span class="models">${escapeHtml(banner.models)}</span>` : ""}
</a>
</body>
</html>
`;
}
