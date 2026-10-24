import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ctx = {};
vm.runInNewContext(fs.readFileSync(new URL("../public/cabinets.js", import.meta.url), "utf8"), ctx);
const { resize, cutList, isoSvg, limitsProblems, toOption } = ctx.Cabinets;
const catalog = JSON.parse(fs.readFileSync(new URL("./sample-catalog.json", import.meta.url)));
const base60 = catalog.cabinet_types[0].presets[0];
const part = (cab, key) => cab.parts.find(p => p.key === key);

test("resizing keeps boards 18 mm and legs at their height", () => {
  const big = resize(base60, 900, 874, 600);
  assert.equal(part(big, "sideL").w, 18);
  assert.equal(part(big, "sideR").x, 900 - 18);
  assert.equal(part(big, "bottom").w, 900 - 36);
  assert.equal(part(big, "bottom").h, 18);
  assert.equal(part(big, "leg0").h, 110);
  assert.equal(part(big, "sideL").h, 874 - 110);
  assert.equal(part(big, "sideL").d, 600 - 18);
});
test("two doors share the extra width", () => {
  const big = resize(base60, 900, 774, 580);
  const [a, b] = [part(big, "door0"), part(big, "door1")];
  assert.ok(Math.abs(a.w - b.w) <= 1);
  assert.ok(a.w > 400 && a.w < 460);
  assert.equal(a.d, 18);
});
test("cut list groups identical parts and leaves hardware out", () => {
  const rows = cutList(base60);
  assert.equal(rows.find(r => r.name === "جنب").qty, 2);
  assert.equal(rows.find(r => r.name === "ضلفة").qty, 2);
  assert.ok(!rows.some(r => r.name === "رجل"));
});
test("size limits and the iso view", () => {
  const wall = catalog.cabinet_types[2];
  assert.equal(limitsProblems(wall, 1300, 710, 350).length, 1);
  assert.match(isoSvg(base60), /<svg[\s\S]*polygon/);
  const opt = toOption(catalog.cabinet_types[0], base60, "x");
  assert.equal(opt.source, "cabinet_maker");
  assert.ok(opt.front.shapes.length > 0 && opt.parts3d.length === base60.parts.length);
});
test("doors keep Cabinet Maker's gaps and cut sizes when resized", () => {
  const big = resize(base60, 900, 774, 580);
  const [a, b] = [part(big, "door0"), part(big, "door1")];
  assert.deepEqual([a.x, a.w, b.x, b.w], [1.5, 447, 451.5, 447]);
  assert.equal(a.cut.width, 445);
  assert.equal(a.cut.length, 625.5);
  const doors = cutList(big).find(r => r.name === "ضلفة");
  assert.deepEqual([doors.qty, doors.length, doors.width], [2, 625.5, 445]);
  assert.equal(cutList(base60).find(r => r.name === "ضلفة").width, 295);
  assert.equal(part(big, "sideL").cut.width, 562);
});
