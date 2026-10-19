// claude terminal · Cloudflare Worker
//
// Holds the Anthropic API key and the access key, proxies chat to the
// Messages API, and keeps threads, files, settings and usage in KV.
// The frontend is static (GitHub Pages, or this Worker's own assets).
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- catalog
// Prices are USD per million tokens (first-party API rates).
const EFFORT_5 = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_4 = ["low", "medium", "high", "max"];
const CATALOG = [
  { id: "claude-opus-5-5",   name: "Opus 5.5",   in: 4,    out: 20,   cacheRead: 0.20, thinking: "adaptive", efforts: EFFORT_5, fallbacks: true,  defaultEffort: "medium" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", in: 2,    out: 10,   cacheRead: 0.20, thinking: "adaptive", efforts: EFFORT_5, fallbacks: true,  defaultEffort: "high" },
  { id: "claude-haiku-5-5",  name: "Haiku 5.5",  in: 0.10, out: 0.50, cacheRead: 0.01, thinking: "adaptive", efforts: EFFORT_5, fallbacks: false, defaultEffort: "medium" },
  { id: "claude-fable-5-1",  name: "Fable 5.1",  in: 10,   out: 50,   cacheRead: 0.25, thinking: "always",   efforts: EFFORT_5, fallbacks: true,  defaultEffort: "high" },
  { id: "claude-fable-5",    name: "Fable 5",    in: 10,   out: 50,   cacheRead: 1.00, thinking: "always",   efforts: EFFORT_5, fallbacks: false, defaultEffort: "high" },
  { id: "claude-opus-5",     name: "Opus 5",     in: 5,    out: 25,   cacheRead: 0.50, thinking: "adaptive", efforts: EFFORT_5, fallbacks: true,  defaultEffort: "high" },
  { id: "claude-sonnet-5",   name: "Sonnet 5",   in: 2,    out: 10,   cacheRead: 0.20, thinking: "adaptive", efforts: EFFORT_5, fallbacks: false, defaultEffort: "high" },
  { id: "claude-opus-4-8",   name: "Opus 4.8",   in: 5,    out: 25,   cacheRead: 0.50, thinking: "adaptive", efforts: EFFORT_5, fallbacks: false, defaultEffort: "high" },
  { id: "claude-opus-4-7",   name: "Opus 4.7",   in: 5,    out: 25,   cacheRead: 0.50, thinking: "adaptive", efforts: EFFORT_5, fallbacks: false, defaultEffort: "high" },
  { id: "claude-opus-4-6",   name: "Opus 4.6",   in: 5,    out: 25,   cacheRead: 0.50, thinking: "adaptive", efforts: EFFORT_4, fallbacks: false, defaultEffort: "high" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", in: 3,    out: 15,   cacheRead: 0.30, thinking: "adaptive", efforts: EFFORT_4, fallbacks: false, defaultEffort: "high" },
  { id: "claude-opus-4-5",   name: "Opus 4.5",   in: 5,    out: 25,   cacheRead: 0.50, thinking: "budget",   efforts: ["low", "medium", "high"], fallbacks: false, defaultEffort: "high" },
  { id: "claude-haiku-4-5",  name: "Haiku 4.5",  in: 1,    out: 5,    cacheRead: 0.10, thinking: "budget",   efforts: [], fallbacks: false, defaultEffort: null },
];
const DEFAULT_MODEL = "claude-opus-5-5";
const catalogFor = (id) => (id ? CATALOG.find((m) => id === m.id || id.startsWith(m.id + "-")) || null : null);

const LEGAL_SYSTEM_PROMPT = `You are a careful legal research and drafting assistant for someone working on United States legal matters.

How to work:
- When the jurisdiction matters and is not stated, ask; otherwise use the default jurisdiction given below. Distinguish federal law from state law and say where states differ.
- Cite authority precisely: case name, reporter citation, court and year; statute title and section; rule number. Never invent or guess a citation. If you are not confident a citation is real and says what you claim, say so plainly and describe the authority in general terms instead.
- Flag anything that may have changed after your knowledge cutoff, and anything that turns on facts you do not have.
- Separate what the law says from how it likely applies to the facts, and give your level of confidence. For analysis questions use a clear structure such as Issue, Rule, Analysis, Conclusion; for simple questions answer in plain prose.
- When documents are attached, rely on their exact text, quote the relevant language, and say where it appears.
- Be direct and concise. Use headings and lists only where they help. Write drafts in a professional register that is ready to edit.
- You assist a person who makes the decisions. Note when something warrants review by a licensed attorney in the relevant jurisdiction, but do not pad answers with repeated disclaimers.`;

const SETTING_DEFAULTS = {
  monthlyBudget: null, model: null, effort: "high", showThinking: true, maxTokens: 32000, fallbacks: true,
  theme: "light", jurisdiction: "Federal (U.S.)", systemPrompt: null, highlight: true,
};

// How long a sign-in lasts. Default is effectively permanent (ten years);
// changing the access key still signs every browser out.
const SESSION_DAYS = 3650;
const MAX_TEXT = 400_000;
const MAX_MESSAGES = 400;
const FREE_FAILS = 5;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "html", "htm", "css", "js", "mjs", "ts", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "php", "sh", "ps1", "sql", "r", "swift", "lua", "tex", "rst", "diff", "patch", "rtf"]);
// Size caps in bytes (KV values max 25 MiB, and files are stored base64).
const CAPS = { image: 5 * 1048576, pdf: 15 * 1048576, docx: 10 * 1048576, text: 2 * 1048576 };

// ---------------------------------------------------------------- small utils
const enc = new TextEncoder();
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max, d = "") => (typeof v === "string" ? v.slice(0, max) : d);
const intEnv = (env, k, d, min) => Math.max(min, Number(env[k]) || d);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const safeName = (name) => String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
const randomId = (n = 12) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

function classifyFile(name, mime) {
  const ext = (name.includes(".") ? name.split(".").pop() : name).toLowerCase();
  mime = (mime || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(mime)) return { kind: "image", mime };
  if (mime === "image/jpg" || ext === "jpg" || ext === "jpeg") return { kind: "image", mime: "image/jpeg" };
  if (ext === "png") return { kind: "image", mime: "image/png" };
  if (ext === "gif") return { kind: "image", mime: "image/gif" };
  if (ext === "webp") return { kind: "image", mime: "image/webp" };
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  if (mime === DOCX_MIME || ext === "docx") return { kind: "docx", mime: DOCX_MIME };
  if (mime === "application/msword" || ext === "doc") return { error: `"${name}" is an old-style .doc file. Open it in Word and save it as .docx first.` };
  if (mime.startsWith("text/") || TEXT_EXT.has(ext) || ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/rtf"].includes(mime)) {
    return { kind: "text", mime: mime || "text/plain" };
  }
  return null;
}

function estimateCost(modelId, u) {
  const m = catalogFor(modelId);
  if (!m || !u) return null;
  const usd = ((u.input_tokens || 0) * m.in + (u.output_tokens || 0) * m.out + (u.cache_read_input_tokens || 0) * m.cacheRead + (u.cache_creation_input_tokens || 0) * m.in * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// ---------------------------------------------------------------- CORS
function allowedOrigins(env, request) {
  const self = new URL(request.url).origin;
  const list = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([self, ...list]);
}
function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env, request).has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Expose-Headers": "Content-Disposition, X-Anthropic-RateLimit",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const withHeaders = (res, headers) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
};

// ---------------------------------------------------------------- auth
// The token never contains the access key. It is exp.nonce.signature, where
// the HMAC key is derived from the access key (and SESSION_SECRET if set), so
// changing the access key signs every browser out.
const keyCache = new Map();
async function signingKey(env) {
  const material = `${env.SESSION_SECRET || "claude-terminal"}\n${env.ACCESS_KEY}`;
  if (!keyCache.has(material)) {
    keyCache.set(material, await crypto.subtle.importKey("raw", enc.encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  return keyCache.get(material);
}
async function sign(env, data) {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(data))));
}
async function issueToken(env) {
  const body = `${Date.now() + SESSION_DAYS * 86_400_000}.${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return { token: `${body}.${await sign(env, body)}`, days: SESSION_DAYS };
}
async function verifyToken(env, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!/^\d{1,17}$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env, `${exp}.${nonce}`));
}
async function isAuthed(env, request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") && verifyToken(env, h.slice(7).trim());
}
async function accessKeyMatches(env, candidate) {
  if (typeof candidate !== "string") return false;
  return safeEqual(await sha256hex(candidate), await sha256hex(env.ACCESS_KEY));
}

// Brute-force protection: a per-IP rate limiter (binding) plus a lockout
// record in KV that doubles after every failure past the fifth.
async function lockState(env, ip) {
  const s = await env.KV.get(`login:${ip}`, "json");
  if (!s) return { locked: false, fails: 0 };
  if (s.lockUntil > Date.now()) return { locked: true, fails: s.fails, retryAfter: Math.ceil((s.lockUntil - Date.now()) / 1000) };
  return { locked: false, fails: s.fails };
}
async function recordFail(env, ip, fails) {
  const s = { fails: fails + 1, lockUntil: 0 };
  if (s.fails >= FREE_FAILS) s.lockUntil = Date.now() + Math.min(3_600_000, 60_000 * 2 ** (s.fails - FREE_FAILS));
  await env.KV.put(`login:${ip}`, JSON.stringify(s), { expirationTtl: 7200 });
  return s;
}

// ---------------------------------------------------------------- settings
async function loadSettings(env) {
  const s = { ...SETTING_DEFAULTS, ...((await env.KV.get("settings", "json")) || {}) };
  // The monthly limit behind the "remaining" readout comes from the Worker
  // config (MONTHLY_LIMIT_USD) unless a value was saved explicitly.
  if (s.monthlyBudget == null && Number(env.MONTHLY_LIMIT_USD) > 0) s.monthlyBudget = Number(env.MONTHLY_LIMIT_USD);
  return s;
}

function applySettingsPatch(settings, b) {
  const errors = [];
  const s = (k, max) => {
    if (b[k] === undefined) return;
    if (b[k] === null || b[k] === "") settings[k] = null;
    else if (typeof b[k] === "string") settings[k] = b[k].slice(0, max);
    else errors.push(k);
  };
  const bool = (k) => {
    if (b[k] !== undefined) settings[k] = !!b[k];
  };
  if (b.monthlyBudget !== undefined) {
    if (b.monthlyBudget === null || b.monthlyBudget === "") settings.monthlyBudget = null;
    else if (Number.isFinite(Number(b.monthlyBudget)) && Number(b.monthlyBudget) >= 0) settings.monthlyBudget = Number(b.monthlyBudget);
    else errors.push("monthlyBudget");
  }
  if (b.maxTokens !== undefined) {
    const n = Math.floor(Number(b.maxTokens));
    if (Number.isFinite(n)) settings.maxTokens = Math.max(256, Math.min(128000, n));
    else errors.push("maxTokens");
  }
  if (b.effort !== undefined) {
    if (b.effort === null || b.effort === "" || EFFORT_5.includes(b.effort)) settings.effort = b.effort || null;
    else errors.push("effort");
  }
  if (b.theme !== undefined) settings.theme = b.theme === "dark" ? "dark" : "light";
  s("model", 80);
  s("jurisdiction", 60);
  s("systemPrompt", 40_000);
  bool("showThinking");
  bool("fallbacks");
  bool("highlight");
  return errors;
}

// ---------------------------------------------------------------- threads
const THREAD_ID = /^[a-z0-9]{6,24}$/;
const summaryOf = (t) => ({
  id: t.id, title: t.title || "Untitled", createdAt: t.createdAt, updatedAt: t.updatedAt, cost: t.cost || 0,
  count: (t.messages || []).filter((m) => m.role !== "note").length, jurisdiction: t.jurisdiction || null, model: t.model || null,
});

function pickUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  return { input_tokens: num(u.input_tokens, 0), output_tokens: num(u.output_tokens, 0), cache_read_input_tokens: num(u.cache_read_input_tokens, 0), cache_creation_input_tokens: num(u.cache_creation_input_tokens, 0) };
}

function cleanThread(id, b) {
  if (!b || typeof b !== "object") return { error: "Bad thread body" };
  if (!Array.isArray(b.messages) || b.messages.length > 2000) return { error: "Bad messages" };
  const messages = [];
  for (const m of b.messages) {
    if (!m || !["user", "assistant", "note"].includes(m.role)) return { error: "Bad message role" };
    const files = [];
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (!f || !/^[a-f0-9]{24}$/.test(String(f.id))) continue;
      files.push({ id: f.id, name: str(f.name, 120, "file"), kind: str(f.kind, 10), mime: str(f.mime, 100), size: num(f.size, 0) });
    }
    const meta = m.meta && typeof m.meta === "object" ? m.meta : {};
    messages.push({
      id: str(m.id, 24, randomId(6)), role: m.role, text: str(m.text, MAX_TEXT), thinking: str(m.thinking, 200_000), files, ts: num(m.ts, Date.now()),
      meta: {
        model: str(meta.model, 80), usage: pickUsage(meta.usage), cost: meta.cost == null ? undefined : num(meta.cost, 0), ms: meta.ms == null ? undefined : num(meta.ms, 0),
        stop_reason: str(meta.stop_reason, 40) || undefined, error: str(meta.error, 2000) || undefined, fallback: str(meta.fallback, 200) || undefined, stopped: meta.stopped ? true : undefined,
      },
    });
  }
  return {
    thread: {
      id, title: str(b.title, 120, "Untitled"), createdAt: num(b.createdAt, Date.now()), updatedAt: Date.now(), model: str(b.model, 80) || null,
      system: str(b.system, 40_000), jurisdiction: str(b.jurisdiction, 60) || null, messages, cost: num(b.cost, 0),
      tokens: { in: num(b.tokens && b.tokens.in, 0), out: num(b.tokens && b.tokens.out, 0) },
    },
  };
}

async function threadIndex(env) {
  return (await env.KV.get("threads:index", "json")) || [];
}

// ---------------------------------------------------------------- files
async function fileIndex(env) {
  return (await env.KV.get("files:index", "json")) || [];
}
async function removeFile(env, id) {
  await Promise.all([env.KV.delete(`file:${id}`), env.KV.delete(`file:${id}:text`)]);
}
// First in, first out: drop the oldest uploads once the count or size cap is hit.
async function enforceFileCaps(env, index) {
  const maxFiles = intEnv(env, "MAX_FILES", 300, 5);
  const maxBytes = intEnv(env, "MAX_FILES_MB", 1024, 10) * 1048576;
  const sorted = index.slice().sort((a, b) => a.ts - b.ts);
  let total = sorted.reduce((s, f) => s + (f.size || 0), 0);
  const removed = [];
  while (sorted.length && (sorted.length > maxFiles || total > maxBytes)) {
    const f = sorted.shift();
    total -= f.size || 0;
    removed.push(f);
  }
  if (!removed.length) return { index, evicted: 0 };
  const gone = new Set(removed.map((f) => f.id));
  const kept = index.filter((f) => !gone.has(f.id));
  await env.KV.put("files:index", JSON.stringify(kept));
  await Promise.all(removed.map((f) => removeFile(env, f.id)));
  return { index: kept, evicted: removed.length };
}

async function fileToBlock(env, entry) {
  if (entry.kind === "image" || entry.kind === "pdf") {
    const data = await env.KV.get(`file:${entry.id}`);
    if (data == null) return null;
    return entry.kind === "image"
      ? { type: "image", source: { type: "base64", media_type: entry.mime, data } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: entry.name };
  }
  const text = await env.KV.get(`file:${entry.id}:text`);
  if (text == null) return null;
  return { type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: entry.name };
}

// ---------------------------------------------------------------- usage ledger
const monthKey = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
function summarize(entries) {
  const s = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const e of entries) {
    s.requests += 1;
    s.input += e.input || 0;
    s.output += e.output || 0;
    s.cacheRead += e.cacheRead || 0;
    s.cacheWrite += e.cacheWrite || 0;
    s.cost += e.cost || 0;
  }
  s.cost = Math.round(s.cost * 1e6) / 1e6;
  return s;
}
async function appendUsage(env, entry) {
  const mk = monthKey(entry.ts);
  const entries = (await env.KV.get(`usage:${mk}`, "json")) || [];
  entries.push(entry);
  const months = (await env.KV.get("usage:months", "json")) || {};
  months[mk] = summarize(entries);
  await Promise.all([env.KV.put(`usage:${mk}`, JSON.stringify(entries)), env.KV.put("usage:months", JSON.stringify(months))]);
}
// Anthropic's own cost figures, via the Admin API cost report. Needs an
// Admin API key (ANTHROPIC_ADMIN_KEY secret). Cached for five minutes; the
// report itself lags real usage by a few minutes.
async function officialSpend(env) {
  if (!env.ANTHROPIC_ADMIN_KEY) return null;
  const cached = await env.KV.get("usage:official", "json");
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const startingAt = new Date(Math.min(monthStart, Date.now() - 30 * 86_400_000)).toISOString();
  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", startingAt);
  url.searchParams.set("ending_at", new Date(Date.now() + 86_400_000).toISOString());
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");
  const headers = { "x-api-key": env.ANTHROPIC_ADMIN_KEY, "anthropic-version": "2023-06-01", "User-Agent": "claude-terminal/2.0 (https://github.com/hmohyud/claude_terminal)" };
  let out;
  try {
    // 1. Closed days in dollars from the cost report (it never includes the
    //    current day).
    const r = await fetch(url, { headers });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body.error && body.error.message) || `HTTP ${r.status}`);
    const today = now.toISOString().slice(0, 10);
    // Amounts are decimal strings in cents.
    const days = (body.data || [])
      .map((b) => ({ day: String(b.starting_at || "").slice(0, 10), cost: Math.round(b.results.reduce((s, x) => s + Number(x.amount || 0), 0)) / 100 }))
      .filter((d) => d.day < today);
    // 2. Today from the usage report, per minute up to the current minute:
    //    Anthropic's exact token counts at list prices.
    const u = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
    u.searchParams.set("starting_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString());
    u.searchParams.set("ending_at", new Date(Date.now() + 60_000).toISOString());
    u.searchParams.set("bucket_width", "1m");
    u.searchParams.set("limit", "1440");
    u.searchParams.append("group_by[]", "model");
    const ur = await fetch(u, { headers });
    const ub = await ur.json().catch(() => ({}));
    if (!ur.ok) throw new Error((ub.error && ub.error.message) || `HTTP ${ur.status}`);
    let todayCost = 0;
    for (const b of ub.data || []) {
      for (const x of b.results || []) {
        const m = catalogFor(x.model);
        if (!m) continue;
        const cc = x.cache_creation || {};
        todayCost += ((x.uncached_input_tokens || 0) * m.in + (x.cache_read_input_tokens || 0) * m.cacheRead + (cc.ephemeral_5m_input_tokens || 0) * m.in * 1.25 + (cc.ephemeral_1h_input_tokens || 0) * m.in * 2 + (x.output_tokens || 0) * m.out) / 1e6;
      }
    }
    days.push({ day: today, cost: Math.round(todayCost * 10000) / 10000, live: true });
    const month = today.slice(0, 7);
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const sum = (f) => Math.round(days.filter(f).reduce((s, d) => s + d.cost, 0) * 10000) / 10000;
    out = { at: Date.now(), source: "anthropic", today: sum((d) => d.day === today), week: sum((d) => d.day >= weekAgo), month: sum((d) => d.day.startsWith(month)), last30: sum(() => true), days };
  } catch (e) {
    out = { at: Date.now(), error: e.message };
  }
  await env.KV.put("usage:official", JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}

async function usageReport(env, settings) {
  const official = await officialSpend(env);
  const now = Date.now();
  const cur = monthKey(now);
  const prev = monthKey(now - 31 * 86_400_000);
  const [curEntries, prevEntries, months] = await Promise.all([
    env.KV.get(`usage:${cur}`, "json"), prev === cur ? null : env.KV.get(`usage:${prev}`, "json"), env.KV.get("usage:months", "json"),
  ]);
  const recent = [...(prevEntries || []), ...(curEntries || [])];
  const d = new Date(now);
  const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthEntries = curEntries || [];
  const byModel = {};
  for (const e of monthEntries) (byModel[e.model || "unknown"] ||= []).push(e);
  const all = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const s of Object.values(months || {})) for (const k of Object.keys(all)) all[k] += s[k] || 0;
  all.cost = Math.round(all.cost * 1e6) / 1e6;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d0 = startOfDay - i * 86_400_000;
    const slice = recent.filter((e) => e.ts >= d0 && e.ts < d0 + 86_400_000);
    days.push({ day: new Date(d0).toISOString().slice(0, 10), cost: summarize(slice).cost, requests: slice.length });
  }
  const estimatedMonth = summarize(monthEntries).cost;
  const exact = official && !official.error ? official : null;
  const monthCost = exact ? exact.month : estimatedMonth;
  const budget = settings.monthlyBudget;
  return {
    now, month: cur,
    totals: {
      today: summarize(recent.filter((e) => e.ts >= startOfDay)),
      week: summarize(recent.filter((e) => e.ts >= now - 7 * 86_400_000)),
      month: summarize(monthEntries),
      all,
    },
    byModel: Object.entries(byModel).map(([model, entries]) => ({ model, ...summarize(entries) })).sort((a, b) => b.cost - a.cost),
    days,
    official,
    budget: {
      monthly: budget, spent: monthCost, estimated: estimatedMonth,
      remaining: budget == null ? null : Math.round((budget - monthCost) * 1e6) / 1e6,
      source: exact ? "anthropic" : "estimate",
    },
    recent: recent.slice(-25).reverse(),
  };
}

// ---------------------------------------------------------------- chat
async function parseChatRequest(env, body) {
  if (!body || typeof body !== "object") return { error: "Bad request body" };
  const model = typeof body.model === "string" && /^[a-z0-9.-]{3,80}$/i.test(body.model) ? body.model : DEFAULT_MODEL;
  const system = typeof body.system === "string" ? body.system.slice(0, MAX_TEXT) : "";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: "messages must be a non-empty array" };
  if (body.messages.length > MAX_MESSAGES) return { error: `Too many messages (max ${MAX_MESSAGES})` };
  const files = await fileIndex(env);
  const messages = [];
  for (const m of body.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return { error: "Each message needs role user|assistant" };
    let content;
    if (typeof m.content === "string") {
      if (m.content.length > MAX_TEXT) return { error: "Message too long" };
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = [];
      for (const b of m.content) {
        if (!b || typeof b !== "object") return { error: "Unsupported content block" };
        if (b.type === "text") {
          if (typeof b.text !== "string" || b.text.length > MAX_TEXT) return { error: "Unsupported content block" };
          content.push({ type: "text", text: b.text });
        } else if (b.type === "file") {
          const f = files.find((x) => x.id === b.id);
          const block = f ? await fileToBlock(env, f) : null;
          if (!block) return { error: `Attached file no longer exists (${b.name || b.id}). Remove it from the message.` };
          content.push(block);
        } else return { error: "Unsupported content block" };
      }
      if (!content.length) return { error: "Empty message" };
    } else return { error: "Message content must be a string or block array" };
    messages.push({ role: m.role, content });
  }
  if (messages[0].role !== "user") return { error: "Conversation must start with a user message" };
  if (messages[messages.length - 1].role !== "user") return { error: "Last message must be from the user" };
  const info = catalogFor(model);
  let effort = typeof body.effort === "string" ? body.effort : null;
  if (effort && (!info || !info.efforts.includes(effort))) effort = null;
  let maxTokens = Number(body.maxTokens);
  if (!Number.isFinite(maxTokens)) maxTokens = 32000;
  maxTokens = Math.max(256, Math.min(128000, Math.floor(maxTokens)));
  const showThinking = body.showThinking !== false;
  const fallbacks = body.fallbacks !== false && !!(info && info.fallbacks);
  return { model, system, messages, effort, maxTokens, showThinking, fallbacks, info };
}

function buildParams(p) {
  const params = { model: p.model, max_tokens: p.maxTokens, messages: p.messages };
  if (p.system) params.system = p.system;
  if (p.effort) params.output_config = { effort: p.effort };
  const mode = p.info ? p.info.thinking : "unknown";
  if (mode === "always") {
    if (p.showThinking) params.thinking = { type: "adaptive", display: "summarized" };
  } else if (mode === "adaptive") {
    params.thinking = p.showThinking ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
  } else if (mode === "budget" && p.showThinking) {
    params.thinking = { type: "enabled", budget_tokens: Math.min(8000, Math.max(1024, p.maxTokens - 1)) };
  }
  return params;
}

function describeError(e) {
  if (e instanceof Anthropic.APIError) {
    const nested = e.error && e.error.error && e.error.error.message;
    return { status: e.status || 0, message: nested || e.message };
  }
  return { status: 0, message: (e && e.message) || String(e) };
}

// ---------------------------------------------------------------- router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Static frontend (used by `wrangler dev`, and as a fallback to GitHub Pages).
      if (!env.ASSETS) return new Response("Not found", { status: 404 });
      const res = await env.ASSETS.fetch(request);
      return withHeaders(res, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    }
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.headers.get("Origin") && !cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403);
    if (request.method !== "GET" && request.headers.get("X-Requested-With") !== "claude-terminal") {
      return json({ error: "Missing X-Requested-With header" }, 403, cors);
    }
    try {
      const res = await route(request, env, ctx, url);
      return withHeaders(res, cors);
    } catch (e) {
      return json({ error: e && e.message ? e.message : "Server error" }, 500, cors);
    }
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limits = { threads: intEnv(env, "MAX_THREADS", 200, 5), files: intEnv(env, "MAX_FILES", 300, 5), filesMb: intEnv(env, "MAX_FILES_MB", 1024, 10) };

  if (!env.ACCESS_KEY || env.ACCESS_KEY.length < 8) return json({ error: "The Worker has no ACCESS_KEY secret (or it is shorter than 8 characters)." }, 503);

  if (path === "/api/me" && method === "GET") {
    return json({ authed: await isAuthed(env, request), defaultModel: DEFAULT_MODEL, legalPrompt: LEGAL_SYSTEM_PROMPT, limits, hasApiKey: !!env.ANTHROPIC_API_KEY, hasAdminKey: !!env.ANTHROPIC_ADMIN_KEY });
  }

  if (path === "/api/login" && method === "POST") {
    if (env.LOGIN_LIMIT) {
      const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
      if (!success) return json({ error: "Too many attempts. Wait a minute and try again.", retryAfter: 60 }, 429, { "Retry-After": "60" });
    }
    const state = await lockState(env, ip);
    if (state.locked) return json({ error: `Too many failed attempts. Try again in ${state.retryAfter}s.`, retryAfter: state.retryAfter }, 429, { "Retry-After": String(state.retryAfter) });
    const body = await request.json().catch(() => ({}));
    const key = body.key != null ? body.key : body.password;
    if (!(await accessKeyMatches(env, key))) {
      const s = await recordFail(env, ip, state.fails);
      if (s.lockUntil > Date.now()) {
        const retryAfter = Math.ceil((s.lockUntil - Date.now()) / 1000);
        return json({ error: `Wrong access key. Locked for ${retryAfter}s.`, retryAfter }, 429, { "Retry-After": String(retryAfter) });
      }
      const remaining = Math.max(0, FREE_FAILS - s.fails);
      return json({ error: remaining > 0 ? `Wrong access key (${remaining} tries left before lockout).` : "Wrong access key.", remaining }, 401);
    }
    ctx.waitUntil(env.KV.delete(`login:${ip}`));
    return json({ ok: true, ...(await issueToken(env)) });
  }

  if (!(await isAuthed(env, request))) return json({ error: "Not logged in" }, 401);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || "missing" });

  // ---- models
  if (path === "/api/models" && method === "GET") {
    const cached = await env.KV.get("models:cache", "json");
    if (cached) return json(cached);
    try {
      const live = [];
      for await (const m of client.models.list({ limit: 100 })) live.push(m);
      const out = [];
      const seen = new Set();
      for (const m of live) {
        const c = catalogFor(m.id);
        if (c) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          out.push({ ...c, liveId: m.id, display: m.display_name || c.name });
        } else out.push({ id: m.id, liveId: m.id, name: m.display_name || m.id, display: m.display_name || m.id, in: null, out: null, cacheRead: null, thinking: "unknown", efforts: [], fallbacks: false, defaultEffort: null });
      }
      out.sort((a, b) => {
        const ia = CATALOG.findIndex((c) => c.id === a.id);
        const ib = CATALOG.findIndex((c) => c.id === b.id);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
      ctx.waitUntil(env.KV.put("models:cache", JSON.stringify(out), { expirationTtl: 600 }));
      return json(out);
    } catch (e) {
      return json({ error: `Could not list models: ${describeError(e).message}` }, 502);
    }
  }

  // ---- settings
  if (path === "/api/settings" && method === "GET") return json(await loadSettings(env));
  if (path === "/api/settings" && method === "PUT") {
    const settings = await loadSettings(env);
    const errors = applySettingsPatch(settings, (await request.json().catch(() => null)) || {});
    if (errors.length) return json({ error: `Invalid value for ${errors.join(", ")}` }, 400);
    await env.KV.put("settings", JSON.stringify(settings));
    return json(settings);
  }

  // ---- usage
  if (path === "/api/usage" && method === "GET") return json(await usageReport(env, await loadSettings(env)));
  if (path === "/api/usage" && method === "POST") {
    // The browser reports each completed reply (it parses the stream; the
    // Worker only pipes it through).
    const b = (await request.json().catch(() => null)) || {};
    const usage = pickUsage(b.usage) || {};
    const entry = {
      ts: Date.now(), model: str(b.model, 80, "unknown"), conv: str(b.conv, 40) || null,
      input: usage.input_tokens || 0, output: usage.output_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
      cost: estimateCost(b.model, usage) || 0, ms: Math.max(0, num(b.ms, 0)), stop: str(b.stop, 40) || null,
    };
    await appendUsage(env, entry);
    const report = await usageReport(env, await loadSettings(env));
    return json({ ok: true, cost: entry.cost, budget: report.budget, today: report.totals.today.cost });
  }

  // ---- threads
  if (path === "/api/threads" && method === "GET") {
    const index = await threadIndex(env);
    return json({ threads: index.sort((a, b) => b.updatedAt - a.updatedAt), limit: limits.threads });
  }
  let m = path.match(/^\/api\/threads\/([a-z0-9]{6,24})$/);
  if (m) {
    const id = m[1];
    if (method === "GET") {
      const t = await env.KV.get(`thread:${id}`, "json");
      return t ? json(t) : json({ error: "No such thread" }, 404);
    }
    if (method === "PUT") {
      const r = cleanThread(id, await request.json().catch(() => null));
      if (r.error) return json({ error: r.error }, 400);
      const index = await threadIndex(env);
      const existing = index.find((s) => s.id === id);
      if (existing) r.thread.createdAt = existing.createdAt || r.thread.createdAt;
      const next = [...index.filter((s) => s.id !== id), summaryOf(r.thread)];
      // First in, first out past the cap.
      next.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const evicted = [];
      while (next.length > limits.threads) evicted.push(next.shift());
      await env.KV.put(`thread:${id}`, JSON.stringify(r.thread));
      await env.KV.put("threads:index", JSON.stringify(next));
      if (evicted.length) ctx.waitUntil(Promise.all(evicted.map((s) => env.KV.delete(`thread:${s.id}`))));
      return json({ ...summaryOf(r.thread), evicted: evicted.length });
    }
    if (method === "DELETE") {
      const index = await threadIndex(env);
      if (!index.find((s) => s.id === id)) return json({ error: "No such thread" }, 404);
      await env.KV.put("threads:index", JSON.stringify(index.filter((s) => s.id !== id)));
      await env.KV.delete(`thread:${id}`);
      return json({ ok: true });
    }
  }

  // ---- files
  if (path === "/api/files" && method === "GET") {
    const index = await fileIndex(env);
    return json({ files: index.sort((a, b) => b.ts - a.ts), limit: limits.files, limitMb: limits.filesMb, usedBytes: index.reduce((s, f) => s + (f.size || 0), 0) });
  }
  if (path === "/api/upload" && method === "POST") {
    const b = (await request.json().catch(() => null)) || {};
    const name = safeName(b.name);
    const cls = classifyFile(name, String(b.type || ""));
    if (!cls) return json({ error: `Unsupported file type for "${name}". Supported: images (png/jpg/gif/webp), PDF, Word (.docx), and text files.` }, 415);
    if (cls.error) return json({ error: cls.error }, 415);
    if (typeof b.b64 !== "string" || !b.b64.length) return json({ error: "Empty upload" }, 400);
    const size = Math.floor((b.b64.length * 3) / 4) - (b.b64.endsWith("==") ? 2 : b.b64.endsWith("=") ? 1 : 0);
    const cap = CAPS[cls.kind];
    if (size > cap) return json({ error: `"${name}" is too large (${(size / 1048576).toFixed(1)} MB; the limit is ${(cap / 1048576).toFixed(0)} MB for ${cls.kind} files).` }, 413);
    let text = null;
    if (cls.kind === "text") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0)));
      } catch {
        return json({ error: `"${name}" is not readable text.` }, 415);
      }
    } else if (cls.kind === "docx") {
      if (typeof b.text !== "string") return json({ error: `"${name}" could not be read as a Word document.` }, 415);
      text = b.text.slice(0, MAX_TEXT);
    }
    const entry = { id: randomId(12), name, kind: cls.kind, mime: cls.mime, size, ts: Date.now(), source: b.source === "assistant" ? "assistant" : "upload" };
    await env.KV.put(`file:${entry.id}`, b.b64);
    if (text != null) await env.KV.put(`file:${entry.id}:text`, text);
    const index = [...(await fileIndex(env)), entry];
    await env.KV.put("files:index", JSON.stringify(index));
    const { evicted } = await enforceFileCaps(env, index);
    return json({ ...entry, evicted });
  }
  m = path.match(/^\/api\/files\/([a-f0-9]{24})$/);
  if (m) {
    const id = m[1];
    const index = await fileIndex(env);
    const f = index.find((x) => x.id === id);
    if (!f) return json({ error: "No such file" }, 404);
    if (method === "GET") {
      const [b64, text] = await Promise.all([env.KV.get(`file:${id}`), f.kind === "image" || f.kind === "pdf" ? null : env.KV.get(`file:${id}:text`)]);
      if (b64 == null) return json({ error: "File content is missing" }, 404);
      return json({ ...f, b64, text: text == null ? undefined : text });
    }
    if (method === "DELETE") {
      await env.KV.put("files:index", JSON.stringify(index.filter((x) => x.id !== id)));
      await removeFile(env, id);
      return json({ ok: true });
    }
  }

  // ---- chat: pipe the Messages API stream straight through
  if (path === "/api/chat" && method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The Worker has no ANTHROPIC_API_KEY secret." }, 503);
    const parsed = await parseChatRequest(env, await request.json().catch(() => null));
    if (parsed.error) return json({ error: parsed.error }, 400);
    const params = { ...buildParams(parsed), stream: true };
    try {
      const { response } = parsed.fallbacks
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal: request.signal }).withResponse()
        : await client.messages.create(params, { signal: request.signal }).withResponse();
      const rate = {};
      response.headers.forEach((v, k) => {
        if (k.startsWith("anthropic-ratelimit-")) rate[k.slice(20)] = v;
      });
      return new Response(response.body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Anthropic-RateLimit": JSON.stringify(rate) },
      });
    } catch (e) {
      const err = describeError(e);
      return json({ error: err.message, status: err.status }, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
  }

  if (path === "/api/count" && method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The Worker has no ANTHROPIC_API_KEY secret." }, 503);
    const parsed = await parseChatRequest(env, await request.json().catch(() => null));
    if (parsed.error) return json({ error: parsed.error }, 400);
    try {
      const p = { model: parsed.model, messages: parsed.messages };
      if (parsed.system) p.system = parsed.system;
      const r = await client.messages.countTokens(p);
      return json({ input_tokens: r.input_tokens });
    } catch (e) {
      return json({ error: describeError(e).message }, 502);
    }
  }

  return json({ error: "Not found" }, 404);
}
