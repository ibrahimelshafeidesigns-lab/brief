// Cabinet library geometry: draws a Cabinet Maker cabinet (parts as boxes, mm, origin front-left-bottom, x right,
// y back, z up) as an iso view, resizes it, and turns it into a cut list and the job format the app already uses.
// Plain script: the page reads it as window.Cabinets, the tests run it in a vm context.
(function (g) {
  "use strict";
  const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
  const isFront = p => /door|drawer_front|front/.test(p.role || "");
  const isHardware = p => /hardware|leg|handle|hinge|slide/.test(p.role || "");
  const r1 = v => Math.round(v * 2) / 2;

  /* ---------- resize ---------- */

  // Edge zones keep their size (side panels, back, toe kick, legs); the space between them stretches, and a part
  // that is a board's thickness along an axis keeps its thickness and only moves. That keeps 18 mm boards 18 mm,
  // legs at their height and fronts at their thickness while the cabinet grows or shrinks.
  function axisMap(lo, hi, size, newSize) {
    const inner = size - lo - hi, newInner = newSize - lo - hi;
    return v => {
      if (v <= lo) return v;
      if (v >= size - hi) return v + (newSize - size);
      return lo + (v - lo) * (inner > 0 ? newInner / inner : 1);
    };
  }
  function resize(preset, W, H, D) {
    const parts = preset.parts || [];
    const legTop = Math.max(0, ...parts.filter(p => /leg|toe|plinth|kick/.test((p.role || "") + (p.key || ""))).map(p => p.z + p.h));
    const maps = {
      x: axisMap(20, 20, preset.width, W),
      y: axisMap(20, 20, preset.depth, D),
      z: axisMap(legTop || 20, 20, preset.height, H)
    };
    const axes = [["x", "w"], ["y", "d"], ["z", "h"]];
    return {
      ...preset, width: W, height: H, depth: D,
      parts: parts.map(p => {
        const q = { ...p };
        for (const [a, s] of axes) {
          const m = maps[a];
          if (p[s] <= 25 || isHardware(p)) {
            const c = m(p[a] + p[s] / 2);
            q[a] = r1(c - p[s] / 2);
          } else {
            const a0 = m(p[a]), a1 = m(p[a] + p[s]);
            q[a] = r1(a0); q[s] = r1(a1 - a0);
          }
        }
        return q;
      })
    };
  }

  // Type limits may come as {width: [min, max]} or {width: {min, max}}.
  function limitsProblems(type, W, H, D) {
    const out = [], lim = type.size_limits || {};
    const names = { width: "العرض", height: "الارتفاع", depth: "العمق" };
    for (const [k, v] of Object.entries({ width: W, height: H, depth: D })) {
      const l = lim[k]; if (!l) continue;
      const min = Array.isArray(l) ? l[0] : l.min, max = Array.isArray(l) ? l[1] : l.max;
      if (min != null && v < min) out.push(`${names[k]} أقل من ${min} مم`);
      if (max != null && v > max) out.push(`${names[k]} أكبر من ${max} مم`);
    }
    return out;
  }

  /* ---------- iso view ---------- */

  // Painter's order for boxes seen from the front-left, above: a box is behind another when it lies wholly past it
  // to the right (x), to the back (y) or below it (z). Draw every box after all the boxes behind it.
  function paintOrder(parts) {
    const e = 0.5, n = parts.length;
    const behind = (a, b) => a.x >= b.x + b.w - e || a.y >= b.y + b.d - e || a.z + a.h <= b.z + e;
    const after = parts.map(() => []), deps = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i !== j && behind(parts[i], parts[j]) && !behind(parts[j], parts[i])) { after[i].push(j); deps[j]++; }
    }
    const out = [], ready = [];
    for (let i = 0; i < n; i++) if (!deps[i]) ready.push(i);
    while (out.length < n) {
      if (!ready.length) { // a cycle (touching or overlapping boxes): take the farthest remaining one
        let k = -1;
        for (let i = 0; i < n; i++) if (deps[i] > 0 && (k < 0 || far(parts[i]) > far(parts[k]))) k = i;
        deps[k] = 0; ready.push(k);
      }
      ready.sort((a, b) => far(parts[b]) - far(parts[a]));
      const i = ready.shift(); out.push(parts[i]);
      for (const j of after[i]) if (--deps[j] === 0) ready.push(j);
      deps[i] = -1;
    }
    return out;
  }
  const far = p => p.x + p.w / 2 + p.y + p.d / 2 - (p.z + p.h / 2);

  // Seen from the front-left, above: x goes up-right, y (back) up-left, z up.
  const P = (x, y, z) => [(x - y) * C30, -(x + y) * S30 - z];
  function isoSvg(cab, opts = {}) {
    const { small = false, open = false } = opts;
    const parts = (cab.parts || []).filter(p => !(open && isFront(p)));
    if (!parts.length) return "";
    const sorted = paintOrder(parts);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, body = "";
    const sw = small ? 6 : 2.5;
    for (const p of sorted) {
      const x0 = p.x, x1 = p.x + p.w, y0 = p.y, y1 = p.y + p.d, z0 = p.z, z1 = p.z + p.h;
      const faces = [
        { pts: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], cls: "t" },
        { pts: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], cls: "f" },
        { pts: [P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)], cls: "s" }
      ];
      const kind = isFront(p) ? " fr" : isHardware(p) ? " hw" : "";
      for (const f of faces) {
        for (const [u, v] of f.pts) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
        body += `<polygon class="${f.cls}${kind}" points="${f.pts.map(([u, v]) => `${u.toFixed(1)},${v.toFixed(1)}`).join(" ")}"/>`;
      }
    }
    let dims = "";
    if (!small) {
      const W = cab.width, D = cab.depth, H = cab.height;
      const lbl = (a, b, text, dx, dy) => {
        const mid = [(a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dy];
        return `<line class="dl" x1="${a[0] + dx}" y1="${a[1] + dy}" x2="${b[0] + dx}" y2="${b[1] + dy}"/><text class="dt" x="${mid[0]}" y="${mid[1]}">${text}</text>`;
      };
      dims += lbl(P(0, 0, 0), P(W, 0, 0), Math.round(W), 0, 60);
      dims += lbl(P(0, 0, 0), P(0, D, 0), Math.round(D), -40, 60);
      dims += lbl(P(0, D, 0), P(0, D, H), Math.round(H), -70, 0);
      minU -= 220; maxV += 140; maxU += 40; minV -= 40;
    }
    const pad = small ? 30 : 20;
    return `<svg viewBox="${(minU - pad).toFixed(0)} ${(minV - pad).toFixed(0)} ${(maxU - minU + 2 * pad).toFixed(0)} ${(maxV - minV + 2 * pad).toFixed(0)}" ${small ? 'width="84" height="84"' : ""} role="img" aria-label="منظور الدولاب" style="direction:ltr">
<style>polygon{stroke:var(--ink);stroke-width:${sw};stroke-linejoin:round}.t{fill:var(--iso-top)}.f{fill:var(--iso-front)}.s{fill:var(--iso-side)}.fr.t{fill:var(--iso-door-top)}.fr.f{fill:var(--iso-door)}.fr.s{fill:var(--iso-door-side)}.hw{fill:var(--muted)}.dl{stroke:var(--muted);stroke-width:3}.dt{fill:var(--ink);font:500 46px var(--mono);text-anchor:middle;dominant-baseline:middle;paint-order:stroke;stroke:var(--sheet);stroke-width:12px}</style>${body}${dims}</svg>`;
  }

  /* ---------- cut list and job ---------- */

  function cutList(cab) {
    const rows = new Map();
    for (const p of cab.parts || []) {
      if (isHardware(p)) continue;
      const [t, wid, len] = [p.w, p.d, p.h].sort((a, b) => a - b);
      const key = [p.name, len, wid, t, p.material].join("|");
      const row = rows.get(key);
      if (row) row.qty += 1;
      else rows.set(key, { name: p.name, qty: 1, length: len, width: wid, thickness: p.thickness || t, material: p.material, role: (p.role || "other").replace(/\s+/g, "_"), edge_band: Array.isArray(p.edge_band) ? p.edge_band.join("، ") : (p.edge_band || "") });
    }
    return [...rows.values()];
  }

  function views(cab) {
    const kind = p => /drawer.?front/.test(p.role || "") ? "drawer" : isFront(p) ? "door" : isHardware(p) ? "hidden" : "panel";
    const parts = cab.parts || [];
    return {
      front: { width: cab.width, height: cab.height, shapes: parts.map(p => ({ x: p.x, y: p.z, w: p.w, h: p.h, kind: kind(p), label: "" })) },
      side: { width: cab.depth, height: cab.height, shapes: parts.filter(p => !isFront(p)).map(p => ({ x: p.y, y: p.z, w: p.d, h: p.h, kind: kind(p), label: "" })) }
    };
  }

  function toOption(type, cab, label) {
    const v = views(cab);
    return {
      id: type.id, source: "cabinet_maker", name: label,
      summary: `${type.name_ar || type.name} من مكتبة Cabinet Maker`,
      overall: { width: cab.width, depth: cab.depth, height: cab.height },
      parts: cutList(cab).map(({ thickness, ...p }) => ({ ...p, name: `${p.name} (${thickness} مم)` })),
      hardware: (cab.hardware || []).map(h => `${h.name} × ${h.qty}`),
      steps: [], build_days: 1, front: v.front, side: v.side, parts3d: cab.parts
    };
  }

  const api = { resize, limitsProblems, isoSvg, cutList, views, toOption };
  g.Cabinets = api;
})(typeof window !== "undefined" ? window : this);
