// Role colors for the Mission Control canvas UI. The canvas is vanilla JS and
// cannot import the extension's TypeScript, so these constants mirror the
// `agento.role.*` color defaults declared in extension/package.json. The parity
// is enforced by roles.test.mjs, which reads the same defaults and compares them.
export const ROLE_COLORS = Object.freeze({
  primary: { background: "#0063B1", foreground: "#FFFFFF" },
  plan: { background: "#7B2CBF", foreground: "#FFFFFF" },
  build: { background: "#1E7B34", foreground: "#FFFFFF" },
  freehand: { background: "#00796B", foreground: "#FFFFFF" },
  unmanaged: { background: "#C62828", foreground: "#FFFFFF" },
  unavailable: { background: "#5F6368", foreground: "#FFFFFF" },
});

// Resolve a role to its color pair, falling back to the "unavailable" colors for
// any role the UI does not know about.
export function roleColor(role) {
  return ROLE_COLORS[role] ?? ROLE_COLORS.unavailable;
}
