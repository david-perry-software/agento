import assert from "node:assert/strict";
import test from "node:test";

import { createTreeIdScope } from "../../src/treeItemIds.js";

test("tree id scope formats ids as agento:<nonce>:<parts joined by '/'>", () => {
  const treeId = createTreeIdScope("nonce-1");
  assert.equal(treeId("initiatives", "group", "agento-extension", "ready"), "agento:nonce-1:initiatives/group/agento-extension/ready");
});

test("one tree id scope yields identical ids for the same parts", () => {
  const treeId = createTreeIdScope();
  assert.equal(treeId("deliveries", "group", "in-flight"), treeId("deliveries", "group", "in-flight"));
  assert.notEqual(treeId("deliveries", "group", "in-flight"), treeId("deliveries", "group", "planned"));
});

test("two tree id scopes yield different ids for the same parts", () => {
  const first = createTreeIdScope();
  const second = createTreeIdScope();
  assert.notEqual(first("sessionDoctor", "group", "session"), second("sessionDoctor", "group", "session"));
  assert.match(first("sessionDoctor", "group", "session"), /^agento:[0-9a-f-]{36}:sessionDoctor\/group\/session$/);
});
