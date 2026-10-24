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

test("the Cabinet Maker catalog reaches the rules and is re-read when it changes", async () => {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(new URL("file://" + os.tmpdir() + "/cat-").pathname);
  const file = dir + "/catalog.json";
  fs.copyFileSync(new URL("./sample-catalog.json", import.meta.url), file);
  process.env.CATALOG_PATH = file;
  const { loadRules } = await import("../server.js?catalog");
  assert.equal((await loadRules()).catalog.cabinet_types.length, 3);
  const changed = JSON.parse(fs.readFileSync(file));
  changed.cabinet_types.push({ id: "wall", name: "Wall cabinet", status: "ready" });
  fs.writeFileSync(file, JSON.stringify(changed));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await loadRules()).catalog.cabinet_types.length, 4);
});

test("the prompt gets the catalog without the library's 3D parts", async () => {
  const { promptCatalog } = await import("../server.js");
  const catalog = JSON.parse(fs.readFileSync(new URL("./sample-catalog.json", import.meta.url)));
  catalog.shop_items = [{ name: "مفصلة", code: "HNG", unit: "pc", price: 12 }];
  const slim = promptCatalog(catalog);
  const preset = slim.cabinet_types[0].presets[0];
  assert.equal(preset.parts, undefined);
  assert.equal(preset.width, 600);
  assert.equal(slim.shop_items[0].price, undefined);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(catalog).length / 3);
  assert.ok(catalog.cabinet_types[0].presets[0].parts.length > 0); // the library copy is untouched
});
