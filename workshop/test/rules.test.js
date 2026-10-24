import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkOption } from "../server.js";

const rules = JSON.parse(fs.readFileSync(new URL("../rules.json", import.meta.url)));
const sample = JSON.parse(fs.readFileSync(new URL("./sample-design.json", import.meta.url)));

test("sample bed passes the shop rules", () => {
  assert.deepEqual(checkOption(sample.options[0], rules), []);
});
test("a part bigger than the sheet is flagged", () => {
  const o = { parts: [{ name: "جنب", qty: 1, length: 2600, width: 600, material: "carcass", role: "carcass" }] };
  assert.equal(checkOption(o, rules).length, 1);
});
test("an unknown material and a narrow door are flagged", () => {
  const o = { parts: [
    { name: "x", qty: 1, length: 500, width: 400, material: "oak", role: "carcass" },
    { name: "ضلفة", qty: 1, length: 700, width: 80, material: "front", role: "door" }
  ] };
  assert.equal(checkOption(o, rules).length, 2);
});
test("a door not in PVC is flagged", () => {
  const o = { parts: [{ name: "ضلفة", qty: 2, length: 700, width: 400, material: "carcass", role: "door" }] };
  assert.equal(checkOption(o, rules).length, 1);
});
