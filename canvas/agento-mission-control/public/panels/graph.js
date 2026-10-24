// Initiative wave graph panel: one SVG DAG per initiative, with a column per
// wave, edges for `requires`/`recommendedAfter` dependencies, glowing `blocking`
// edges, and a pulsing highlight on the initiative's `next` member. Ready
// members get a "Plan" button only when `/agento new-feature` is in the live
// allowed union; clicking it dispatches `/agento new-feature`.

import { escapeHtml, registerPanel, dispatch } from "/app.js";

const NODE_W = 150;
const NODE_H = 44;
const COL_W = 190;
const ROW_H = 76;
const MARGIN = 64;

function layout(nodes) {
  const waves = [...new Set((nodes ?? []).map((n) => n.wave).filter((w) => w !== null && w !== undefined))]
    .sort((a, b) => a - b);
  const byWave = new Map();
  for (const node of nodes ?? []) {
    const wave = node.wave ?? 0;
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push(node);
  }
  for (const members of byWave.values()) {
    members.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.slug.localeCompare(b.slug));
  }
  const positions = new Map();
  let maxRows = 0;
  for (const [wave, members] of byWave) {
    maxRows = Math.max(maxRows, members.length);
    const col = waves.indexOf(wave);
    members.forEach((node, row) => {
      positions.set(node.slug, { x: MARGIN + col * COL_W, y: MARGIN + row * ROW_H });
    });
  }
  return { waves, positions, width: MARGIN * 2 + waves.length * COL_W, height: MARGIN * 2 + Math.max(1, maxRows) * ROW_H };
}

function edgeMarkup(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return "";
  const kind = edge.kind ?? "requires";
  const cls = kind === "blocking"
    ? "mc-edge mc-edge-blocking"
    : kind === "recommendedAfter"
      ? "mc-edge mc-edge-recommended"
      : "mc-edge";
  return `<line class="${cls}" x1="${from.x + NODE_W}" y1="${from.y + NODE_H / 2}" x2="${to.x}" y2="${to.y + NODE_H / 2}"></line>`;
}

function nodeMarkup(node, pos, { initiative, planAllowed }) {
  const classes = ["mc-node"];
  if (initiative.next != null && initiative.next === node.slug) classes.push("mc-node-next");
  const plan = node.ready && planAllowed
    ? `<g class="mc-plan" role="button" tabindex="0" aria-label="Plan ${escapeHtml(node.slug)}" transform="translate(${NODE_W - 46}, ${NODE_H + 8})">
        <rect width="46" height="20" rx="10"></rect>
        <text x="23" y="14" text-anchor="middle">Plan</text>
      </g>`
    : "";
  return `<g class="${classes.join(" ")}" data-slug="${escapeHtml(node.slug)}" transform="translate(${pos.x}, ${pos.y})">
    <rect class="mc-node-rect" width="${NODE_W}" height="${NODE_H}" rx="6"></rect>
    <text class="mc-node-text" x="8" y="${NODE_H / 2 + 4}">${escapeHtml(node.slug)}</text>
    ${plan}
  </g>`;
}

function initiativeMarkup(initiative, planAllowed) {
  const { waves, positions, width, height } = layout(initiative.nodes);
  const edges = (initiative.edges ?? []).map((edge) => edgeMarkup(edge, positions)).join("");
  const nodes = (initiative.nodes ?? []).map((node) => {
    const pos = positions.get(node.slug);
    return pos ? nodeMarkup(node, pos, { initiative, planAllowed }) : "";
  }).join("");
  return `<section class="mc-graph" data-initiative="${escapeHtml(initiative.slug)}" aria-label="Initiative ${escapeHtml(initiative.slug)} wave graph">
    <h3 class="mc-graph-heading">${escapeHtml(initiative.slug)}</h3>
    <svg class="mc-graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(initiative.slug)} waves ${waves.join(", ")}">
      <g class="mc-edges">${edges}</g>
      <g class="mc-nodes">${nodes}</g>
    </svg>
  </section>`;
}

function render(state) {
  const root = document.createElement("div");
  root.className = "mc-graphs";
  const planAllowed = Array.isArray(state.allowed) && state.allowed.includes("/agento new-feature");
  const initiatives = state.initiatives ?? [];
  root.innerHTML = initiatives.map((initiative) => initiativeMarkup(initiative, planAllowed)).join("");

  const status = document.getElementById("status");
  root.querySelectorAll(".mc-plan").forEach((button) => {
    const activate = () => {
      button.classList.add("mc-plan-busy");
      dispatch("/agento new-feature")
        .then(() => {
          if (status) status.textContent = "dispatched /agento new-feature";
        })
        .catch((err) => {
          if (status) status.textContent = err?.message ?? String(err);
          button.classList.remove("mc-plan-busy");
        });
    };
    button.addEventListener("click", activate);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });

  return root;
}

registerPanel("graph", render);
