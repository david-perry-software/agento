import type { SessionDoctorModel } from "./sessionDoctorModel.js";
import { ROLE_FOREGROUND_COLOR, roleBannerColor } from "./statusStyle.js";

export const BANNER_CLICK_COMMAND = "agento.sessionDoctor.focus";

export interface WindowBannerModel {
  tone: string;
  title: string;
  detail: string;
  tooltip: string;
  colorId: string;
}

const CLICK_HINT = "Click to open Session & Doctor";

function toneOf(colorId: string): string {
  return colorId.slice("agento.role.".length);
}

export function createWindowBannerModel(model: SessionDoctorModel): WindowBannerModel {
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
  return {
    tone: toneOf(colorId),
    title: `${session.role.toUpperCase()} WINDOW`,
    detail: parts.join(" · "),
    tooltip: `${session.worktreePath}\n${CLICK_HINT}`,
    colorId,
  };
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
  padding: 10px 14px;
  color: inherit;
  text-decoration: none;
}
a.banner:focus-visible { outline: 2px solid ${cssColor(ROLE_FOREGROUND_COLOR)}; outline-offset: -4px; }
.title { display: block; font-weight: 800; font-size: 1.6em; line-height: 1.2; letter-spacing: 0.08em; text-transform: uppercase; }
.detail { display: block; margin-top: 6px; font-size: 0.95em; overflow-wrap: anywhere; }
</style>
</head>
<body>
<a class="banner" href="command:${BANNER_CLICK_COMMAND}" title="${escapeHtml(banner.tooltip)}">
<span class="title">${escapeHtml(banner.title)}</span>
<span class="detail">${escapeHtml(banner.detail)}</span>
</a>
</body>
</html>
`;
}
