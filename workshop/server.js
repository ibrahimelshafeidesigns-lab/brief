// Shop design app: a phone web app where the owner chats with Claude to design furniture within the shop's rules,
// gets drawings and a cut list, and sends the job to a worker. No framework: node:http plus the Anthropic SDK.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const OWNER_PIN = process.env.OWNER_PIN || "";
const WORKER_PIN = process.env.WORKER_PIN || "";
const MODEL = process.env.MODEL || "claude-opus-5-5";
const EFFORT = process.env.EFFORT || "medium";
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

const client = new Anthropic();

/* ---------- rules ---------- */

// The Cabinet Maker plugin writes its cabinet catalog (types, presets, construction numbers, the owner's Settings) to
// CATALOG_PATH every time it loads or a cabinet or setting changes. Read it again whenever the file changes.
const CATALOG_PATH = process.env.CATALOG_PATH || "";
let catalogCache = { mtime: 0, data: null };

async function loadCatalog() {
  if (!CATALOG_PATH) return null;
  try {
    const { mtimeMs } = await fs.stat(CATALOG_PATH);
    if (mtimeMs !== catalogCache.mtime) {
      catalogCache = { mtime: mtimeMs, data: JSON.parse(await fs.readFile(CATALOG_PATH, "utf8")) };
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("catalog:", err.message);
    // a half-written file keeps the last good copy
  }
  return catalogCache.data;
}

export async function loadRules() {
  const rules = JSON.parse(await fs.readFile(path.join(here, "rules.json"), "utf8"));
  rules.catalog = await loadCatalog();
  return rules;
}

// Checks Claude's parts against the shop rules in code, so a design never reaches the shop on the model's word alone.
export function checkOption(option, rules) {
  const problems = [];
  const mats = new Map(rules.materials.map(m => [m.id, m]));
  const { length: SL, width: SW } = rules.sheet;
  const c = rules.construction;
  for (const p of option.parts) {
    const label = `${p.name} (${p.length}×${p.width})`;
    // Library cabinets carry Cabinet Maker's own material names; the plugin already chose them.
    const mat = mats.get(p.material) || (option.source === "cabinet_maker" ? { id: p.material } : null);
    if (!mat) { problems.push(`${label}: خامة مش من خامات الورشة (${p.material})`); continue; }
    if (!(p.qty >= 1) || !Number.isInteger(p.qty)) problems.push(`${label}: العدد لازم رقم صحيح`);
    if (!(p.length > 0 && p.width > 0)) { problems.push(`${label}: مقاس غلط`); continue; }
    if (mat.id !== "slats" && mat.id !== "solid_pine") {
      const long = Math.max(p.length, p.width), short = Math.min(p.length, p.width);
      if (long > SL || short > SW) problems.push(`${label}: أكبر من اللوح ${SL}×${SW}`);
    }
    if (p.role === "door" && Math.min(p.length, p.width) < c.min_door_width) problems.push(`${label}: الضلفة أضيق من ${c.min_door_width} مم`);
    if (p.role === "drawer_front" && Math.min(p.length, p.width) < c.min_drawer_front) problems.push(`${label}: وش الدرج أقل من ${c.min_drawer_front} مم`);
    if (p.role === "door" && p.material !== "front" && option.source !== "cabinet_maker") problems.push(`${label}: الضلف لازم PVC كريمي`);
  }
  return problems;
}

/* ---------- Claude ---------- */

const shape = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "w", "h", "kind", "label"],
  properties: {
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
    kind: { type: "string", enum: ["panel", "door", "drawer", "opening", "mattress", "hidden"] },
    label: { type: "string" }
  }
};
const view = {
  type: "object",
  additionalProperties: false,
  required: ["width", "height", "shapes"],
  properties: { width: { type: "number" }, height: { type: "number" }, shapes: { type: "array", items: shape } }
};
const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "options"],
  properties: {
    reply: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "summary", "overall", "parts", "hardware", "steps", "build_days", "front", "side"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          summary: { type: "string" },
          overall: {
            type: "object", additionalProperties: false, required: ["width", "depth", "height"],
            properties: { width: { type: "number" }, depth: { type: "number" }, height: { type: "number" } }
          },
          parts: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["name", "qty", "length", "width", "material", "role", "edge_band"],
              properties: {
                name: { type: "string" }, qty: { type: "integer" },
                length: { type: "number" }, width: { type: "number" },
                material: { type: "string" },
                role: { type: "string", enum: ["carcass", "door", "drawer_front", "drawer_box", "back", "shelf", "support", "other"] },
                edge_band: { type: "string" }
              }
            }
          },
          hardware: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          build_days: { type: "number" },
          front: view,
          side: view
        }
      }
    }
  }
};

function systemPrompt(rules) {
  return `You are the design assistant of a small Egyptian cabinetry and furniture workshop. The workshop owner talks to you on his phone. He is an experienced craftsman, not a computer user.

Language: always answer in simple Egyptian Arabic. Part names and labels in Arabic, the way a workshop says them. Numbers in English digits.

When he asks for a piece of furniture, give 2 or 3 genuinely different options (style, storage, cost), each one buildable in this shop with these rules. If an important size is missing and you cannot assume a standard one, ask one short question in "reply" and return no options. Otherwise assume standard sizes and say what you assumed in one line.

For each option give:
- a complete cut list: every board part, with finished length and width in mm, quantity, material id, role, and which edges get edge band (in Arabic, e.g. "الطول الأمامي" or "كل الحروف" or "ولا حاجة");
- the hardware (Arabic, with quantities);
- short assembly steps for the workers (Arabic, 4 to 8 steps);
- build days for one worker;
- a front view and a side view as rectangles in mm, origin at the bottom-left, y pointing up, covering the whole piece. Use kind "door" and "drawer" for fronts, "panel" for visible boards, "mattress" for a mattress, "hidden" for parts behind others. Labels short Arabic, or empty.

Never use a material that is not in the list. Every board part must fit the sheet (it may be turned). Split long parts and say so in the part name. Follow the construction numbers exactly (clearances, thicknesses, back in a groove).

Shop rules (JSON, sizes in mm):
${JSON.stringify({ sheet: rules.sheet, materials: rules.materials, construction: rules.construction, rules: rules.text_rules })}${rules.catalog ? `

Cabinet Maker catalog. This is the shop's own cabinet design program and it wins over the shop rules above wherever
they differ. For any kitchen, wardrobe, vanity or other cabinet work, build each cabinet as one of these types, within
its size limits and allowed counts, using its construction numbers exactly (panel and back thicknesses, groove, door
and drawer clearances, drawer box sizes, legs, shelves, edge banding by cabinet kind), so the cut list matches what
Cabinet Maker would produce. Name each cabinet's parts after its type (e.g. "B1 جنب"). Still use the material ids from
the shop rules in the cut list.
${JSON.stringify(rules.catalog)}` : ""}`;
}

async function design(history, rules) {
  if (process.env.MOCK_DESIGN) { // offline testing without an API key
    const result = JSON.parse(await fs.readFile(process.env.MOCK_DESIGN, "utf8"));
    for (const o of result.options) o.problems = checkOption(o, rules);
    return result;
  }
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: DESIGN_SCHEMA } },
    // The catalog is large and changes rarely: cache it so each design request only pays for the conversation.
    system: [{ type: "text", text: systemPrompt(rules), cache_control: { type: "ephemeral" } }],
    messages: history
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw Object.assign(new Error("refused"), { status: 422 });
  if (msg.stop_reason === "max_tokens") throw Object.assign(new Error("too long"), { status: 502 });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const result = JSON.parse(text);
  for (const o of result.options) o.problems = checkOption(o, rules);
  return result;
}

/* ---------- jobs ---------- */

async function readJobs() {
  try { return JSON.parse(await fs.readFile(JOBS_FILE, "utf8")); } catch { return []; }
}
async function writeJobs(jobs) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = JOBS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(jobs, null, 1));
  await fs.rename(tmp, JOBS_FILE);
}
const STATUSES = ["new", "cutting", "assembly", "done"];

/* ---------- http ---------- */

function role(req) {
  const pin = req.headers["x-app-pin"] || "";
  if (OWNER_PIN && pin === OWNER_PIN) return "owner";
  if (WORKER_PIN && pin === WORKER_PIN) return "worker";
  if (!OWNER_PIN) return "owner"; // no PIN set: local testing only
  return null;
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 2e6) throw Object.assign(new Error("too big"), { status: 413 }); }
  return s ? JSON.parse(s) : {};
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (!p || p.endsWith("/")) p += "index.html";
  const file = path.join(here, "public", p);
  if (!file.startsWith(path.join(here, "public"))) return send(res, 404, { error: "not found" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { send(res, 404, { error: "not found" }); }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
  const who = role(req);
  if (!who) return send(res, 401, { error: "الرقم السري غلط" });

  if (url.pathname === "/api/me") return send(res, 200, { role: who });
  if (url.pathname === "/api/rules" && req.method === "GET") {
    const { catalog, ...rules } = await loadRules();
    rules.catalog_summary = catalog ? {
      exported_at: catalog.exported_at || null,
      plugin_version: catalog.plugin_version || null,
      types: (catalog.cabinet_types || []).map(t => ({ id: t.id, name: t.name_ar || t.name, status: t.status, presets: (t.presets || []).length }))
    } : null;
    return send(res, 200, rules);
  }

  if (url.pathname === "/api/library" && req.method === "GET") {
    const catalog = await loadCatalog();
    return send(res, 200, { exported_at: catalog?.exported_at || null, types: catalog?.cabinet_types || [] });
  }

  if (url.pathname === "/api/check" && req.method === "POST") {
    const { option } = await body(req);
    if (!option?.parts) return send(res, 400, { error: "بيانات ناقصة" });
    return send(res, 200, { problems: checkOption(option, await loadRules()) });
  }

  if (url.pathname === "/api/design" && req.method === "POST") {
    if (who !== "owner") return send(res, 403, { error: "للمصمم بس" });
    const { messages } = await body(req);
    if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: "مفيش رسالة" });
    const history = messages.slice(-20).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
    return send(res, 200, await design(history, await loadRules()));
  }

  if (url.pathname === "/api/jobs" && req.method === "GET") {
    const jobs = await readJobs();
    const w = Number(url.searchParams.get("worker"));
    return send(res, 200, w ? jobs.filter(j => j.worker_id === w) : jobs);
  }
  if (url.pathname === "/api/jobs" && req.method === "POST") {
    if (who !== "owner") return send(res, 403, { error: "للمصمم بس" });
    const { option, worker_id, title } = await body(req);
    const rules = await loadRules();
    const worker = rules.workers.find(w => w.id === worker_id);
    if (!worker || !option?.parts) return send(res, 400, { error: "بيانات ناقصة" });
    const jobs = await readJobs();
    const now = new Date().toISOString();
    const job = { id: crypto.randomUUID(), title: String(title || option.name), option, worker_id, worker: worker.name, status: "new", created: now, history: [{ status: "new", at: now }] };
    jobs.unshift(job);
    await writeJobs(jobs);
    return send(res, 201, job);
  }
  const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (m && req.method === "PATCH") {
    const { status } = await body(req);
    if (!STATUSES.includes(status)) return send(res, 400, { error: "حالة غلط" });
    const jobs = await readJobs();
    const job = jobs.find(j => j.id === m[1]);
    if (!job) return send(res, 404, { error: "مش موجودة" });
    job.status = status;
    job.history.push({ status, at: new Date().toISOString() });
    await writeJobs(jobs);
    return send(res, 200, job);
  }
  send(res, 404, { error: "not found" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error(err);
      const status = err.status || (err instanceof Anthropic.APIError ? 502 : 500);
      const msg = status === 422 ? "Claude رفض الطلب ده، جرّب تكتبه بطريقة تانية"
        : err instanceof Anthropic.RateLimitError ? "Claude مشغول دلوقتي، استنى دقيقة وجرب تاني"
        : err instanceof Anthropic.AuthenticationError ? "مفتاح Claude مش شغال، كلم إبراهيم"
        : err instanceof Anthropic.APIConnectionError ? "مفيش اتصال بـ Claude، اتأكد من النت"
        : "حصلت مشكلة، جرب تاني";
      if (!res.headersSent) send(res, status, { error: msg });
    });
  }).listen(PORT, () => console.log(`Shop design app on http://localhost:${PORT}`));
}
