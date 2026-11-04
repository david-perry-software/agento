import assert from "node:assert/strict";
import test from "node:test";

import { BRIEF_BUDGET, BRIEF_POLICY_PRIORITY, DISPATCH_MODES, dispatchMode, paginateBrief, splitText } from "./brief.mjs";

const byteLength = (text) => Buffer.byteLength(text, "utf8");

// Markdown of about `size` bytes with headings, paragraphs, and wrapped lines so
// the paginator has `##`/paragraph/line boundaries to split at.
function mkText(size) {
  const parts = [];
  let used = 0;
  let section = 0;
  while (used < size) {
    const heading = `## Section ${section}\n\n`;
    const lines = [];
    while (lines.length < 6) {
      lines.push("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt");
      if (byteLength(lines.join("\n")) + used + byteLength(heading) >= size) break;
    }
    const body = `${lines.join("\n")}\n\n`;
    parts.push(heading + body);
    used += byteLength(heading) + byteLength(body);
    section += 1;
  }
  return parts.join("");
}

function policyBlock(n, size) {
  return { kind: "policy", id: String(n), title: `Section ${n}`, bytes: size, text: `## ${n}. Section ${n}\n\n${"p".repeat(size - 30)}` };
}

const receipt = "Receipt: accepted brief:widget:abcdef";
const session = "Session:\n- role: build\n- worktree: /tmp/wt";
const delivery = "Delivery:\n- slug: widget\n- current step: 1.1";

test("dispatchMode maps the router's agent table", () => {
  assert.equal(dispatchMode(undefined), "inline");
  assert.equal(dispatchMode("agent"), "inline");
  assert.equal(dispatchMode("📋 Agento Planner"), "inline-as-agent");
  assert.equal(dispatchMode("🏛️ Agento Architect"), "inline-as-agent");
  assert.equal(dispatchMode("🛠️ Agento Mechanic"), "inline-as-agent");
  assert.equal(dispatchMode("🤖 Agento Autopilot"), "inline-as-agent");
  assert.equal(dispatchMode("🔨 Agento Builder"), "subagent");
  assert.equal(dispatchMode("🔍 Agento Reviewer"), "subagent");
  assert.equal(dispatchMode("some unknown agent"), "inline");
  assert.equal(Object.keys(DISPATCH_MODES).length, 6);
});

test("splitText splits an oversized single paragraph at line boundaries within the budget", () => {
  const text = mkText(BRIEF_BUDGET * 3);
  const chunks = splitText(text, BRIEF_BUDGET);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(byteLength(chunk) <= BRIEF_BUDGET, `chunk ${byteLength(chunk)} bytes`);
});

test("splitText hard-cuts a single oversized line at the budget", () => {
  const text = "x".repeat(BRIEF_BUDGET * 2 + 100);
  const chunks = splitText(text, BRIEF_BUDGET);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(byteLength(chunk) <= BRIEF_BUDGET);
});

test("paginateBrief keeps every page within budget and the receipt on page 1 only", () => {
  const result = paginateBrief({
    blocks: [
      { kind: "receipt", id: "receipt", text: receipt },
      { kind: "session", id: "session", text: session },
      { kind: "delivery", id: "delivery", text: delivery },
      { kind: "command", id: "command", text: `## Command\n\nRun the widget command.\n\n${"c".repeat(2000)}` },
      { kind: "agent", id: "agent", text: mkText(12600) },
      { kind: "policy", id: "9", title: "Execution receipts", bytes: 900, text: "## 9. Execution receipts\n\n" + "r".repeat(860) },
      { kind: "policy", id: "7", title: "Git rules", bytes: 900, text: "## 7. Git rules\n\n" + "g".repeat(860) },
      { kind: "policy", id: "1", title: "Who does the work", bytes: 900, text: "## 1. Who does the work\n\n" + "w".repeat(860) },
    ],
    pageCommand: "node scripts/agento.mjs brief build-feature widget",
    agent: "🔨 Agento Builder",
  });

  assert.ok(result.pages.length > 1, "a 12.6 KB agent body must paginate");
  for (const page of result.pages) {
    assert.ok(byteLength(page) <= BRIEF_BUDGET, `page is ${byteLength(page)} bytes (budget ${BRIEF_BUDGET})`);
  }
  assert.ok(result.pages[0].startsWith(receipt), "receipt must open page 1");
  for (const page of result.pages.slice(1)) {
    assert.ok(!page.includes(receipt), "receipt must not repeat on continuation pages");
  }
});

test("paginateBrief's footer lists every continuation page", () => {
  const result = paginateBrief({
    blocks: [
      { kind: "receipt", id: "receipt", text: receipt },
      { kind: "session", id: "session", text: session },
      { kind: "delivery", id: "delivery", text: delivery },
      { kind: "agent", id: "agent", text: mkText(12600) },
    ],
    pageCommand: "node scripts/agento.mjs brief build-feature widget",
  });

  assert.ok(result.more.length >= 1);
  for (const n of result.more) {
    assert.ok(result.pages[0].includes(`--page ${n}`), `page 1 footer must name page ${n}`);
  }
  assert.equal(result.pages.length, result.more.length + 1);
});

test("paginateBrief honours the role's policy priority order", () => {
  const policy = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].map((n) => policyBlock(n, 600));
  const result = paginateBrief({
    blocks: [
      { kind: "receipt", id: "receipt", text: receipt },
      { kind: "session", id: "session", text: session },
      { kind: "delivery", id: "delivery", text: delivery },
      ...policy,
    ],
    budget: 2600,
    pageCommand: "node scripts/agento.mjs brief build-feature widget",
    agent: "🔨 Agento Builder",
  });

  const priority = BRIEF_POLICY_PRIORITY["🔨 Agento Builder"];
  assert.ok(result.included.length > 0 && result.included.length < policy.length);
  assert.deepEqual(
    result.included.map((s) => s.n),
    priority.slice(0, result.included.length),
    "included sections must be the highest-priority prefix",
  );
  const union = [...result.included.map((s) => s.n), ...result.onDemand.map((s) => s.n)].sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(union, policy.map((p) => p.id).sort((a, b) => Number(a) - Number(b)), "included + on-demand must cover the declared set");
});

test("paginateBrief is deterministic", () => {
  const blocks = [
    { kind: "receipt", id: "receipt", text: receipt },
    { kind: "session", id: "session", text: session },
    { kind: "delivery", id: "delivery", text: delivery },
    { kind: "command", id: "command", text: mkText(5000) },
    { kind: "agent", id: "agent", text: mkText(12600) },
    ...["9", "7", "1", "2", "3"].map((n) => policyBlock(Number(n), 800)),
  ];
  const one = paginateBrief({ blocks, pageCommand: "node scripts/agento.mjs brief build-feature widget", agent: "🔨 Agento Builder" });
  const two = paginateBrief({ blocks, pageCommand: "node scripts/agento.mjs brief build-feature widget", agent: "🔨 Agento Builder" });
  assert.deepEqual(one.pages, two.pages);
  assert.deepEqual(one.onDemand, two.onDemand);
  assert.deepEqual(one.placement, two.placement);
});
