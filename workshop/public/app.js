"use strict";
const $ = s => document.querySelector(s);
const main = $("#main");
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const STATUS = { new: "جديد", cutting: "تقطيع", assembly: "تجميع", done: "خلص" };
const ORDER = ["new", "cutting", "assembly", "done"];

const state = {
  pin: store.get("pin", ""), role: null, rules: null,
  tab: "design", view: "chat", option: null, drawing: "side", job: null,
  lib: { types: null, q: "", sel: null, size: null, open: false, problems: [] },
  chat: store.get("chat", []), jobs: [], me: store.get("me", null), busy: false, error: ""
};

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function toast(t) { const el = document.createElement("div"); el.className = "toast"; el.textContent = t; $("#app").appendChild(el); setTimeout(() => el.remove(), 2600); }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-app-pin": state.pin, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "حصلت مشكلة"), { status: res.status });
  return data;
}

/* ---------- drawings (mm, origin bottom-left) ---------- */
const matName = id => state.rules?.materials.find(m => m.id === id)?.name || id;

function svgWrap(minX, minY, w, h, body, small) {
  return `<svg viewBox="${minX} ${minY} ${w} ${h}" ${small ? 'width="80" height="70"' : ""} role="img" aria-label="رسمة تنفيذية">
  <style>.o{fill:none;stroke:var(--blue);stroke-width:${small ? 22 : 9}}.f{fill:var(--blue);fill-opacity:.07;stroke:var(--blue);stroke-width:${small ? 22 : 9}}.d{fill:var(--blue);fill-opacity:.16;stroke:var(--blue);stroke-width:${small ? 22 : 9}}.m{fill:var(--muted);fill-opacity:.12;stroke:var(--muted);stroke-width:${small ? 18 : 7}}.h{fill:none;stroke:var(--blue);stroke-width:5;stroke-dasharray:30 20}.dim line{stroke:var(--muted);stroke-width:4}.dim text{fill:var(--ink);font:500 64px var(--mono)}.lbl{fill:var(--muted);font:500 52px var(--body)}</style>${body}</svg>`;
}
function dimH(x1, x2, y, label) {
  return `<g class="dim"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line x1="${x1}" y1="${y - 40}" x2="${x1}" y2="${y + 40}"/><line x1="${x2}" y1="${y - 40}" x2="${x2}" y2="${y + 40}"/><text x="${(x1 + x2) / 2}" y="${y - 24}" text-anchor="middle">${label}</text></g>`;
}
function dimV(x, y1, y2, label) {
  return `<g class="dim"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><line x1="${x - 40}" y1="${y1}" x2="${x + 40}" y2="${y1}"/><line x1="${x - 40}" y1="${y2}" x2="${x + 40}" y2="${y2}"/><text x="${x - 30}" y="${(y1 + y2) / 2}" text-anchor="end" dominant-baseline="middle">${label}</text></g>`;
}
function renderView(v, small) {
  if (!v || !v.shapes?.length) return small ? "" : `<p class="empty">مفيش رسمة</p>`;
  const W = v.width, H = v.height;
  const cls = { panel: "f", door: "d", drawer: "d", opening: "o", mattress: "m", hidden: "h" };
  let b = "";
  // hidden first, mattress last so fronts stay readable
  const order = ["hidden", "panel", "opening", "door", "drawer", "mattress"];
  [...v.shapes].sort((a, c) => order.indexOf(a.kind) - order.indexOf(c.kind)).forEach(s => {
    const y = H - (s.y + s.h);
    b += `<rect class="${cls[s.kind] || "f"}" x="${s.x}" y="${y}" width="${s.w}" height="${s.h}"/>`;
    if (s.kind === "drawer") b += `<line class="o" x1="${s.x + s.w / 2 - 100}" y1="${y + s.h / 2}" x2="${s.x + s.w / 2 + 100}" y2="${y + s.h / 2}"/>`;
    if (!small && s.label && s.w > 300 && s.h > 120) b += `<text class="lbl" x="${s.x + s.w / 2}" y="${y + s.h / 2 + 18}" text-anchor="middle">${esc(s.label)}</text>`;
  });
  if (small) { const p = Math.max(W, H) * 0.05; return svgWrap(-p, -p, W + 2 * p, H + 2 * p, b, true); }
  b += `<line x1="-200" y1="${H}" x2="${W + 100}" y2="${H}" stroke="var(--muted)" stroke-width="3"/>`;
  b += dimH(0, W, H + 160, Math.round(W));
  b += dimV(-120, H, 0, Math.round(H));
  return svgWrap(-560, -120, W + 700, H + 400, b);
}
function sheetLayout(parts) {
  const S = state.rules.sheet, kerf = S.kerf || 4;
  const mats = [...new Set(parts.map(p => p.material))].filter(m => !["slats", "solid_pine"].includes(m));
  const result = { html: "", count: 0 };
  mats.forEach(mat => {
    const list = [];
    parts.filter(p => p.material === mat).forEach(p => { for (let i = 0; i < p.qty; i++) list.push({ n: p.name, w: Math.max(p.length, p.width), h: Math.min(p.length, p.width) }); });
    list.sort((a, c) => c.h - a.h || c.w - a.w);
    const sheets = [[]]; let x = 0, y = 0, rowH = 0;
    list.forEach(p => {
      if (x + p.w > S.length) { x = 0; y += rowH + kerf; rowH = 0; }
      if (y + p.h > S.width) { sheets.push([]); x = 0; y = 0; rowH = 0; }
      sheets[sheets.length - 1].push({ ...p, x, y }); x += p.w + kerf; rowH = Math.max(rowH, p.h);
    });
    result.count += sheets.length;
    result.html += sheets.map((s, i) => {
      let b = `<rect x="0" y="0" width="${S.length}" height="${S.width}" fill="none" stroke="var(--muted)" stroke-width="8"/>`;
      s.forEach(p => { b += `<rect class="f" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>`; if (p.h > 150 && p.w > 400) b += `<text class="lbl" x="${p.x + p.w - 30}" y="${p.y + 80}" text-anchor="end">${esc(p.n)}</text><text class="lbl" style="font-family:var(--mono)" x="${p.x + 30}" y="${p.y + p.h - 30}">${p.w}×${p.h}</text>`; });
      return `<div class="sheetcard"><div class="cap"><span>${esc(matName(mat))} · لوح ${i + 1} من ${sheets.length}</span><span class="n">${S.length} × ${S.width}</span></div>${svgWrap(-40, -40, S.length + 80, S.width + 80, b)}</div>`;
    }).join("");
  });
  return result;
}

/* ---------- views ---------- */
function renderLogin() {
  return `<div class="view login"><h2>أهلاً بيك</h2><p class="sub" style="margin:0">اكتب الرقم السري بتاع الورشة</p>
    <input id="pin" type="password" inputmode="numeric" autocomplete="current-password">
    ${state.error ? `<div class="err">${esc(state.error)}</div>` : ""}
    <button class="primary" data-login>دخول</button></div>`;
}
function optionCard(o, i, mi) {
  const sheets = sheetLayout(o.parts).count;
  const ok = !o.problems?.length;
  return `<button class="opt" data-opt="${mi}:${i}"><div class="thumb">${renderView(o.side?.shapes?.length ? o.side : o.front, true)}</div><div><h3>${esc(o.id)}. ${esc(o.name)}</h3><p>${esc(o.summary)}</p><div class="chips">${ok ? '<span class="chip ok">✓ قواعد الورشة</span>' : `<span class="chip bad">${o.problems.length} ملاحظة</span>`}<span class="chip">${sheets} ألواح</span><span class="chip">حوالي ${esc(o.build_days)} أيام</span></div></div></button>`;
}
function renderChat() {
  let h = `<div class="view">`;
  if (!state.chat.length) h += `<div class="msg ai"><div class="who">Claude</div>قولّي عايز تعمل إيه: سرير، دولاب، مطبخ، مكتبة... واكتب المقاسات لو تعرفها. وتقدر تدوس على المايك وتتكلم.</div>`;
  state.chat.forEach((m, mi) => {
    if (m.role === "user") { h += `<div class="msg me">${esc(m.text)}</div>`; return; }
    h += `<div class="msg ai"><div class="who">Claude</div>${esc(m.result.reply)}</div>`;
    if (m.result.options?.length) h += `<div class="options">${m.result.options.map((o, i) => optionCard(o, i, mi)).join("")}</div>`;
  });
  if (state.busy) h += `<div class="msg ai"><span class="typing"><i></i><i></i><i></i></span> <span class="wait">بيصمم... ممكن ياخد دقيقة</span></div>`;
  if (state.error) h += `<div class="err">${esc(state.error)}</div>`;
  return h + `</div>`;
}
function optionBody(o) {
  const sheets = sheetLayout(o.parts);
  const iso = !!o.parts3d?.length;
  const drawing = state.drawing === "iso" && iso ? isoPanel({ ...o.overall, parts: o.parts3d })
    : state.drawing === "side" ? renderView(o.side) : state.drawing === "front" ? renderView(o.front) : null;
  const tabs = [...(iso ? [["iso", "منظور"]] : []), ["side", "من الجنب"], ["front", "من قدام"], ["sheets", "ألواح التقطيع"]];
  const count = o.parts.reduce((s, p) => s + p.qty, 0);
  return `
    <p class="sub">المقاس الكلي <span class="n">${o.overall.width} × ${o.overall.depth} × ${o.overall.height}</span> مم (عرض × عمق × ارتفاع)</p>
    <div class="seg" role="group" aria-label="الرسمة">
      ${tabs.map(([k, l]) => `<button data-draw="${k}" aria-pressed="${state.drawing === k}">${l}</button>`).join("")}
    </div>
    ${drawing != null ? (state.drawing === "iso" ? drawing : `<div class="sheetcard"><div class="cap"><span>${state.drawing === "side" ? "واجهة جانبية" : "واجهة أمامية"}</span><span>المقاسات بالمللي</span></div>${drawing}</div>`) : sheets.html}
    <div class="totals">
      <div><b>${sheets.count}</b><span>ألواح</span></div>
      <div><b>${count}</b><span>قطعة</span></div>
      <div><b>~${esc(o.build_days)}</b><span>أيام شغل</span></div>
    </div>
    ${o.problems?.length ? `<div class="panel"><h4>ملاحظات على القواعد</h4><ul class="rules">${o.problems.map(p => `<li><span class="tick" style="color:var(--warn)">!</span>${esc(p)}</li>`).join("")}</ul></div>` : ""}
    <div class="panel"><h4>قائمة التقطيع</h4><ul class="cuts">${o.parts.map(p => `<li>
      <div class="cut-top"><b>${esc(p.name)}</b><span class="cut-qty">× ${p.qty}</span></div>
      <div class="cut-size">${p.length} × ${p.width} <small>مم</small></div>
      <div class="cut-meta">${esc(matName(p.material))}${p.edge_band ? ` · شريط حرف: ${esc(p.edge_band)}` : ""}</div>
    </li>`).join("")}</ul></div>
    ${o.hardware.length ? `<div class="panel"><h4>الخردوات</h4><ul class="rules">${o.hardware.map(x => `<li><span class="tick">•</span><span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
    ${o.steps.length ? `<div class="panel"><h4>خطوات التنفيذ</h4><ol class="steps-list">${o.steps.map(x => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}`;
}
/* ---------- cabinet library ---------- */
function isoPanel(cab) {
  return `<div class="sheetcard iso"><div class="cap"><span>منظور</span><button class="linkbtn" data-open>${state.lib.open ? "اقفل الضلف" : "افتح الضلف"}</button></div>${Cabinets.isoSvg(cab, { open: state.lib.open })}</div>`;
}
const typeName = t => t.name_ar || t.name;
function renderLibrary() {
  const L = state.lib;
  if (!L.types) return `<div class="view"><p class="empty">بيحمّل الدواليب...</p></div>`;
  if (!L.types.length) return `<div class="view"><h2>مكتبة الدواليب</h2><p class="empty">الدواليب لسه ما وصلتش من Cabinet Maker. افتح SketchUp مرة على كمبيوتر الورشة.</p></div>`;
  const q = L.q.trim();
  const groups = L.types.map((t, ti) => ({ t, ti, presets: (t.presets || []).map((p, pi) => ({ p, pi })).filter(({ p }) => p.parts?.length && (!q || (typeName(t) + " " + p.name).includes(q))) }))
    .filter(g => g.presets.length);
  return `<div class="view"><h2>مكتبة الدواليب</h2>
    <p class="src" style="margin:-8px 0 0">من Cabinet Maker · ${L.types.reduce((n, t) => n + (t.presets || []).filter(p => p.parts?.length).length, 0)} دولاب جاهز</p>
    <input id="libq" class="search" type="search" placeholder="دوّر: أرضي، علوي، حوض، فرن..." value="${esc(L.q)}">
    ${groups.map(g => `<section class="libgroup"><h3>${esc(typeName(g.t))}</h3><div class="libgrid">${g.presets.map(({ p, pi }) =>
      `<button class="libcard" data-cab="${g.ti}:${pi}"><span class="thumb">${Cabinets.isoSvg(p, { small: true })}</span><b>${esc(p.name)}</b><span class="n">${p.width}×${p.height}×${p.depth}</span></button>`).join("")}</div></section>`).join("") || `<p class="empty">مفيش نتيجة</p>`}
  </div>`;
}
function currentCabinet() {
  const L = state.lib, t = L.types[L.sel.ti], base = t.presets[L.sel.pi];
  const { W, H, D } = L.size;
  const cab = (W === base.width && H === base.height && D === base.depth) ? base : Cabinets.resize(base, W, H, D);
  return { t, base, cab };
}
function renderCabinet() {
  const L = state.lib, { t, base, cab } = currentCabinet();
  const changed = cab !== base;
  const opt = Cabinets.toOption(t, cab, `${typeName(t)} ${base.name}${changed ? ` (${cab.width}×${cab.height}×${cab.depth})` : ""}`);
  opt.problems = [...Cabinets.limitsProblems(t, cab.width, cab.height, cab.depth), ...(L.problems || [])];
  state.option = opt;
  const field = (k, label) => `<label class="dim-in"><span>${label}</span><input id="sz-${k}" type="number" inputmode="numeric" min="50" step="1" value="${L.size[k]}"></label>`;
  return `<div class="view">
    <button class="back" data-libback>› رجوع للمكتبة</button>
    <h2>${esc(typeName(t))} · ${esc(base.name)}</h2>
    <div class="panel"><h4>المقاس</h4><div class="dims">${field("W", "عرض")}${field("H", "ارتفاع")}${field("D", "عمق")}</div>
      <div class="row2" style="margin-top:8px"><button class="secondary" data-resize>طبّق المقاس</button><button class="secondary" data-reset ${changed ? "" : "disabled"}>المقاس الأصلي</button></div>
      ${changed ? `<p class="src" style="margin:8px 0 0">اتعدّل من مقاس Cabinet Maker: الألواح فضلت 18 مم والجوانب والأرجل زي ما هي، والباقي اتمدّ. راجع خلوص الضلف قبل التقطيع.</p>` : ""}
    </div>
    ${optionBody(opt)}
    <button class="secondary" data-askcab>اسأل Claude يعدّل فيه</button>
    <button class="primary big" data-assign>ابعت للصنايعية</button>
  </div>`;
}
async function loadLibrary() {
  try { const r = await api("/api/library"); state.lib.types = r.types; } catch (e) { state.lib.types = []; toast(e.message); }
}

function renderDetail() {
  const o = state.option;
  return `<div class="view">
    <button class="back" data-back>› رجوع للاختيارات</button>
    <h2>${esc(o.name)}</h2>
    ${optionBody(o)}
    <button class="secondary" data-change>غيّر حاجة في التصميم ده</button>
    <button class="primary big" data-assign>ابعت للصنايعية</button>
  </div>`;
}
function renderJobs() {
  const mine = state.role === "worker";
  if (mine && !state.me) {
    return `<div class="view"><h2>انت مين؟</h2>${state.rules.workers.map(w => `<button class="worker" data-me="${w.id}"><span class="avatar">${esc(w.name[0])}</span><b>${esc(w.name)}</b></button>`).join("")}</div>`;
  }
  const jobs = mine ? state.jobs.filter(j => j.worker_id === state.me) : state.jobs;
  const step = s => ORDER.indexOf(s) + 1;
  return `<div class="view"><h2>${mine ? "شغلي" : "الشغل في الورشة"}</h2>
    ${jobs.length ? jobs.map(j => `<button class="job" style="text-align:start" data-job="${j.id}"><div class="head"><h3>${esc(j.title)}</h3><span class="status s-${j.status === "done" ? "done" : j.status === "new" ? "new" : "cut"}">${STATUS[j.status]}</span></div>
      <div class="steps">${[1, 2, 3, 4].map(i => `<i class="${i <= step(j.status) ? "on" : ""}"></i>`).join("")}</div>
      <div class="meta">${esc(j.worker)} · ${new Date(j.created).toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" })}</div></button>`).join("") : `<p class="empty">مفيش شغل لسه</p>`}
    ${mine ? `<button class="secondary" data-notme>مش أنا؟ غيّر الاسم</button>` : ""}</div>`;
}
function renderJob() {
  const j = state.job, i = ORDER.indexOf(j.status), next = ORDER[i + 1];
  return `<div class="view">
    <button class="back" data-backjobs>› رجوع للشغل</button>
    <h2>${esc(j.title)}</h2>
    <p class="sub">${esc(j.worker)} · <span class="status s-${j.status === "done" ? "done" : "cut"}">${STATUS[j.status]}</span></p>
    ${next ? `<button class="primary big" data-advance="${next}">خلصت، ابدأ ${STATUS[next]}</button>` : ""}
    ${optionBody(j.option)}
  </div>`;
}
function renderRules() {
  const r = state.rules;
  return `<div class="view"><h2>قواعد الورشة</h2><p class="sub">Claude بيمشي على القواعد دي، والتطبيق بيراجع كل قطعة عليها.</p>
    <div class="panel"><ul class="rules">${r.text_rules.map(x => `<li><span class="tick">✓</span>${esc(x)}</li>`).join("")}</ul></div>
    ${r.catalog_summary ? `<div class="panel"><h4>دواليب Cabinet Maker</h4><p class="src" style="margin:0 0 8px">متزامنة مع البرنامج · آخر تحديث ${esc(new Date(r.catalog_summary.exported_at).toLocaleString("ar-EG", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }))}</p><ul class="rules">${r.catalog_summary.types.map(t => `<li><span class="tick">${t.status === "planned" ? "○" : "✓"}</span><span>${esc(t.name)}${t.presets ? ` <span class="src">(${t.presets} مقاس جاهز)</span>` : ""}</span></li>`).join("")}</ul></div>` : `<p class="src">دواليب Cabinet Maker لسه مش متوصلة.</p>`}
    <div class="panel"><h4>الخامات</h4><ul class="rules">${r.materials.map(m => `<li><span class="tick">•</span><span><b>${esc(m.name)}</b> <span class="n">${m.thickness}</span> مم: ${esc(m.use)}</span></li>`).join("")}</ul></div></div>`;
}
function render() {
  const logged = !!state.role;
  $("#tabs").hidden = !logged || state.role === "worker";
  $("#newchat").hidden = !(logged && state.role === "owner" && state.tab === "design" && state.chat.length);
  $("#composer").hidden = !(logged && state.role === "owner" && state.tab === "design" && state.view === "chat");
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  $("#jobcount").textContent = state.jobs.filter(j => j.status !== "done").length;
  if (!logged) main.innerHTML = renderLogin();
  else if (state.view === "job") main.innerHTML = renderJob();
  else if (state.tab === "jobs") main.innerHTML = renderJobs();
  else if (state.tab === "rules") main.innerHTML = renderRules();
  else if (state.tab === "library") main.innerHTML = state.view === "cabinet" ? renderCabinet() : renderLibrary();
  else if (state.view === "detail") main.innerHTML = renderDetail();
  else main.innerHTML = renderChat();
  main.scrollTop = (state.tab === "design" && state.view === "chat") ? main.scrollHeight : 0;
}

/* ---------- actions ---------- */
async function login(pin) {
  state.pin = pin; state.error = "";
  try {
    const me = await api("/api/me");
    state.role = me.role; store.set("pin", pin);
    state.rules = await api("/api/rules");
    if (state.role === "worker") state.tab = "jobs";
    await loadJobs();
  } catch (e) { state.role = null; state.error = e.status === 401 ? "الرقم السري غلط" : e.message; }
  render();
}
async function loadJobs() { try { state.jobs = await api("/api/jobs"); } catch {} }

async function send(text) {
  text = text.trim(); if (!text || state.busy) return;
  state.chat.push({ role: "user", text }); state.busy = true; state.error = ""; render();
  const messages = state.chat.map(m => m.role === "user" ? { role: "user", content: m.text }
    : { role: "assistant", content: JSON.stringify({ reply: m.result.reply, options: m.result.options.map(({ problems, ...o }) => o) }) });
  try {
    const result = await api("/api/design", { method: "POST", body: JSON.stringify({ messages }) });
    state.chat.push({ role: "assistant", result });
  } catch (e) {
    state.chat.pop(); state.error = e.message; $("#prompt").value = text;
  }
  state.busy = false; store.set("chat", state.chat); render();
}

function openAssign() {
  const o = state.option; let picked = state.rules.workers[0].id;
  const scrim = document.createElement("div"); scrim.className = "scrim";
  const draw = () => { scrim.innerHTML = `<div class="sheet" role="dialog" aria-label="ابعت للصنايعية">
    <h2>مين يبدأ الشغلانة دي؟</h2><p class="sub" style="margin:0">${esc(o.name)} · الرسومات وقائمة التقطيع هتروح معاها</p>
    ${state.rules.workers.map(w => `<button class="worker" data-w="${w.id}" aria-pressed="${picked === w.id}"><span class="avatar">${esc(w.name[0])}</span><b>${esc(w.name)}</b></button>`).join("")}
    <button class="primary" data-confirm>ابعت الشغلانة</button><button class="secondary" data-cancel>إلغاء</button></div>`; };
  draw();
  scrim.addEventListener("click", async e => {
    if (e.target === scrim || e.target.closest("[data-cancel]")) return scrim.remove();
    const w = e.target.closest("[data-w]"); if (w) { picked = +w.dataset.w; return draw(); }
    if (e.target.closest("[data-confirm]")) {
      try {
        const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({ option: o, worker_id: picked, title: o.name }) });
        state.jobs.unshift(job); scrim.remove(); state.tab = "jobs"; state.view = "chat"; render(); toast("اتبعتت لـ " + job.worker);
      } catch (err) { toast(err.message); }
    }
  });
  $("#app").appendChild(scrim);
}

document.addEventListener("click", async e => {
  const t = e.target;
  if (t.closest("[data-login]")) return login($("#pin").value.trim());
  const tab = t.closest("[data-tab]"); if (tab) { state.tab = tab.dataset.tab; state.view = "chat"; if (state.tab === "jobs") await loadJobs(); if (state.tab === "library") { render(); await loadLibrary(); } return render(); }
  const cab = t.closest("[data-cab]");
  if (cab) {
    const [ti, pi] = cab.dataset.cab.split(":").map(Number), p = state.lib.types[ti].presets[pi];
    Object.assign(state.lib, { sel: { ti, pi }, size: { W: p.width, H: p.height, D: p.depth }, open: false, problems: [] });
    state.view = "cabinet"; state.drawing = "iso"; return render();
  }
  if (t.closest("[data-libback]")) { state.view = "chat"; return render(); }
  if (t.closest("[data-open]")) { state.lib.open = !state.lib.open; return render(); }
  if (t.closest("[data-reset]")) { const { base } = currentCabinet(); state.lib.size = { W: base.width, H: base.height, D: base.depth }; state.lib.problems = []; return render(); }
  if (t.closest("[data-resize]")) {
    const v = k => Math.round(Number($("#sz-" + k).value));
    const size = { W: v("W"), H: v("H"), D: v("D") };
    if (Object.values(size).some(n => !(n >= 50))) return toast("اكتب مقاس صحيح بالمللي");
    state.lib.size = size;
    const { t: type, cab: c } = currentCabinet();
    try { state.lib.problems = (await api("/api/check", { method: "POST", body: JSON.stringify({ option: Cabinets.toOption(type, c, "") }) })).problems; } catch { state.lib.problems = []; }
    return render();
  }
  if (t.closest("[data-askcab]")) {
    const o = state.option; state.tab = "design"; state.view = "chat"; render();
    $("#prompt").value = `عندي ${o.name} من مكتبة Cabinet Maker بمقاس ${o.overall.width}×${o.overall.height}×${o.overall.depth}. عايز `; $("#prompt").focus(); return;
  }
  const opt = t.closest("[data-opt]"); if (opt) { const [mi, i] = opt.dataset.opt.split(":").map(Number); state.option = state.chat[mi].result.options[i]; state.view = "detail"; state.drawing = "side"; return render(); }
  if (t.closest("[data-back]")) { state.view = "chat"; return render(); }
  const dr = t.closest("[data-draw]"); if (dr) { state.drawing = dr.dataset.draw; return render(); }
  if (t.closest("[data-assign]")) return openAssign();
  if (t.closest("[data-change]")) { state.view = "chat"; render(); $("#prompt").value = `في اختيار ${state.option.id} (${state.option.name}): `; $("#prompt").focus(); return; }
  const me = t.closest("[data-me]"); if (me) { state.me = +me.dataset.me; store.set("me", state.me); return render(); }
  if (t.closest("[data-notme]")) { state.me = null; store.set("me", null); return render(); }
  const job = t.closest("[data-job]"); if (job) { state.job = state.jobs.find(j => j.id === job.dataset.job); state.view = "job"; state.drawing = state.job.option.parts3d?.length ? "iso" : "side"; return render(); }
  if (t.closest("[data-backjobs]")) { state.view = "chat"; await loadJobs(); return render(); }
  const adv = t.closest("[data-advance]");
  if (adv) {
    try { const j = await api(`/api/jobs/${state.job.id}`, { method: "PATCH", body: JSON.stringify({ status: adv.dataset.advance }) }); Object.assign(state.job, j); toast("اتسجل: " + STATUS[j.status]); }
    catch (err) { toast(err.message); }
    return render();
  }
});
document.addEventListener("input", e => {
  if (e.target.id !== "libq") return;
  state.lib.q = e.target.value; const pos = e.target.selectionStart; render();
  const el = $("#libq"); el.focus(); el.setSelectionRange(pos, pos);
});
$("#newchat").addEventListener("click", () => { state.chat = []; state.error = ""; store.set("chat", []); render(); });
$("#send").addEventListener("click", () => { const v = $("#prompt").value; $("#prompt").value = ""; send(v); });
$("#prompt").addEventListener("keydown", e => { if (e.key === "Enter") { const v = e.target.value; e.target.value = ""; send(v); } });
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pin") login(e.target.value.trim()); });

// Voice input: Chrome on Android supports Egyptian Arabic speech recognition.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
$("#mic").addEventListener("click", () => {
  if (!Speech) return toast("الموبايل ده مش بيدعم الكلام، اكتب");
  const rec = new Speech(); rec.lang = "ar-EG"; rec.interimResults = true;
  $("#mic").style.opacity = ".6"; toast("اتكلم دلوقتي...");
  rec.onresult = ev => { $("#prompt").value = [...ev.results].map(r => r[0].transcript).join(" "); };
  rec.onend = () => { $("#mic").style.opacity = ""; const v = $("#prompt").value.trim(); if (v) { $("#prompt").value = ""; send(v); } };
  rec.onerror = () => toast("مسمعتش كويس، جرب تاني");
  rec.start();
});

render();
login(state.pin).then(() => { if (!state.pin && !state.role) { state.error = ""; render(); } });
