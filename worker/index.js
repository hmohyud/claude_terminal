// claude terminal · Cloudflare Worker
//
// Holds the Anthropic API key and the access key, relays chat to the
// Messages API, and reports spend. Nothing personal is stored here: threads,
// files and settings live in each person's own browser.
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

const SESSION_DAYS = 3650; // effectively permanent; changing the access key signs everyone out
const FREE_FAILS = 5;
// Only these beta features may be requested by the page.
const ALLOWED_BETAS = new Set(["server-side-fallback-2026-07-01"]);

// ---------------------------------------------------------------- small utils
const enc = new TextEncoder();
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max, d = "") => (typeof v === "string" ? v.slice(0, max) : d);

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

function estimateCost(modelId, u) {
  const m = catalogFor(modelId);
  if (!m || !u) return null;
  const usd = ((u.input_tokens || 0) * m.in + (u.output_tokens || 0) * m.out + (u.cache_read_input_tokens || 0) * m.cacheRead + (u.cache_creation_input_tokens || 0) * m.in * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
function pickUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  return { input_tokens: num(u.input_tokens, 0), output_tokens: num(u.output_tokens, 0), cache_read_input_tokens: num(u.cache_read_input_tokens, 0), cache_creation_input_tokens: num(u.cache_creation_input_tokens, 0) };
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With, X-Anthropic-Beta",
    "Access-Control-Expose-Headers": "X-Anthropic-RateLimit",
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

// ---------------------------------------------------------------- usage
// The browser reports each completed reply (it parses the stream; the Worker
// only relays it). These entries hold token counts only, no content.
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

// Anthropic's own figures via the Admin API (ANTHROPIC_ADMIN_KEY secret).
// Closed days come in dollars from the cost report, which never includes the
// current day; today comes from the usage report's per-minute token counts at
// list prices. Cached for five minutes.
const ADMIN_UA = "claude-terminal/2.0 (https://github.com/hmohyud/claude_terminal)";
async function officialSpend(env) {
  if (!env.ANTHROPIC_ADMIN_KEY) return null;
  const cached = await env.KV.get("usage:official", "json");
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", new Date(Math.min(monthStart, Date.now() - 30 * 86_400_000)).toISOString());
  url.searchParams.set("ending_at", new Date(Date.now() + 86_400_000).toISOString());
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");
  const headers = { "x-api-key": env.ANTHROPIC_ADMIN_KEY, "anthropic-version": "2023-06-01", "User-Agent": ADMIN_UA };
  let out;
  try {
    const r = await fetch(url, { headers });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body.error && body.error.message) || `HTTP ${r.status}`);
    const today = now.toISOString().slice(0, 10);
    // Amounts are decimal strings in cents.
    const days = (body.data || [])
      .map((b) => ({ day: String(b.starting_at || "").slice(0, 10), cost: Math.round(b.results.reduce((s, x) => s + Number(x.amount || 0), 0)) / 100 }))
      .filter((d) => d.day < today);
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

async function usageReport(env) {
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
  const all = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const s of Object.values(months || {})) for (const k of Object.keys(all)) all[k] += s[k] || 0;
  all.cost = Math.round(all.cost * 1e6) / 1e6;
  const exact = official && !official.error ? official : null;
  const monthCost = exact ? exact.month : summarize(monthEntries).cost;
  const budget = Number(env.MONTHLY_LIMIT_USD) > 0 ? Number(env.MONTHLY_LIMIT_USD) : null;
  return {
    now, month: cur,
    totals: {
      today: summarize(recent.filter((e) => e.ts >= startOfDay)),
      week: summarize(recent.filter((e) => e.ts >= now - 7 * 86_400_000)),
      month: summarize(monthEntries),
      all,
    },
    official,
    budget: { monthly: budget, spent: monthCost, remaining: budget == null ? null : Math.round((budget - monthCost) * 1e6) / 1e6, source: exact ? "anthropic" : "estimate" },
  };
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

  if (!env.ACCESS_KEY || env.ACCESS_KEY.length < 8) return json({ error: "The Worker has no ACCESS_KEY secret (or it is shorter than 8 characters)." }, 503);

  if (path === "/api/me" && method === "GET") {
    return json({ authed: await isAuthed(env, request), defaultModel: DEFAULT_MODEL, legalPrompt: LEGAL_SYSTEM_PROMPT, hasApiKey: !!env.ANTHROPIC_API_KEY, hasAdminKey: !!env.ANTHROPIC_ADMIN_KEY });
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

  // ---- models (cached 10 minutes)
  if (path === "/api/models" && method === "GET") {
    const cached = await env.KV.get("models:cache", "json");
    if (cached) return json(cached);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The Worker has no ANTHROPIC_API_KEY secret." }, 503);
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
      const msg = e instanceof Anthropic.APIError ? (e.error && e.error.error && e.error.error.message) || e.message : e.message;
      return json({ error: `Could not list models: ${msg}` }, 502);
    }
  }

  // ---- usage
  if (path === "/api/usage" && method === "GET") return json(await usageReport(env));
  if (path === "/api/usage" && method === "POST") {
    const b = (await request.json().catch(() => null)) || {};
    const usage = pickUsage(b.usage) || {};
    const entry = {
      ts: Date.now(), model: str(b.model, 80, "unknown"),
      input: usage.input_tokens || 0, output: usage.output_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
      cost: estimateCost(b.model, usage) || 0, ms: Math.max(0, num(b.ms, 0)), stop: str(b.stop, 40) || null,
    };
    await appendUsage(env, entry);
    const report = await usageReport(env);
    const exact = report.official && !report.official.error ? report.official : null;
    return json({ ok: true, cost: entry.cost, budget: report.budget, today: exact ? exact.today : report.totals.today.cost });
  }

  // ---- chat and token counting: relayed to the Messages API without
  // buffering, so attachments of any size cost the Worker no CPU. The page
  // builds the request body; it is trusted because it holds the access key.
  if ((path === "/api/chat" || path === "/api/count") && method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The Worker has no ANTHROPIC_API_KEY secret." }, 503);
    if (!/^application\/json/i.test(request.headers.get("Content-Type") || "")) return json({ error: "Send JSON" }, 400);
    const headers = { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json", "User-Agent": ADMIN_UA };
    const betas = (request.headers.get("X-Anthropic-Beta") || "").split(",").map((s) => s.trim()).filter((s) => ALLOWED_BETAS.has(s));
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    const upstream = await fetch(path === "/api/chat" ? "https://api.anthropic.com/v1/messages" : "https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", headers, body: request.body, signal: request.signal,
    });
    if (!upstream.ok) {
      const body = await upstream.json().catch(() => ({}));
      const message = (body.error && body.error.message) || `Anthropic returned HTTP ${upstream.status}`;
      // Never pass 401/403 through: the page treats 401 as "signed out".
      if (upstream.status === 401 || upstream.status === 403) return json({ error: `Anthropic rejected the API key: ${message}`, status: upstream.status }, 502);
      return json({ error: message, status: upstream.status }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }
    const rate = {};
    upstream.headers.forEach((v, k) => {
      if (k.startsWith("anthropic-ratelimit-")) rate[k.slice(20)] = v;
    });
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store", "X-Anthropic-RateLimit": JSON.stringify(rate) },
    });
  }

  return json({ error: "Not found" }, 404);
}
