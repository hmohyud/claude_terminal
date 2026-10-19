import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const log = (...a) => console.log("[claude-terminal]", ...a);
const fatal = (msg) => {
  console.error(`\n[claude-terminal] ${msg}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || "127.0.0.1";
const PASSWORD = process.env.TERMINAL_PASSWORD || "";
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS) || 30);
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const COOKIE_NAME = "ct_session";
const DATA_DIR = path.join(here, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const LEDGER_PATH = path.join(DATA_DIR, "usage.jsonl");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FILE_INDEX_PATH = path.join(DATA_DIR, "files.json");

if (!process.env.ANTHROPIC_API_KEY) fatal("ANTHROPIC_API_KEY is missing. Copy .env.example to .env and fill it in.");
if (!PASSWORD || PASSWORD === "change-me") fatal("TERMINAL_PASSWORD is missing. Set it in .env.");
if (PASSWORD.length < 8) fatal("TERMINAL_PASSWORD must be at least 8 characters.");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  try {
    let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (/^SESSION_SECRET=.*$/m.test(text)) {
      text = text.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${SESSION_SECRET}`);
    } else {
      if (text && !text.endsWith("\n")) text += "\n";
      text += `SESSION_SECRET=${SESSION_SECRET}\n`;
    }
    fs.writeFileSync(envPath, text);
    log("Generated SESSION_SECRET and saved it to .env");
  } catch {
    log("Warning: could not save SESSION_SECRET to .env; logins will not survive a restart.");
  }
}

// ---------------------------------------------------------------- small JSON stores
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const settings = readJson(SETTINGS_PATH, {});
if (settings.monthlyBudget === undefined) settings.monthlyBudget = Number(process.env.MONTHLY_BUDGET_USD) || null;

// ---------------------------------------------------------------- model catalog
// Prices are USD per million tokens (first-party API rates). cacheRead is the
// per-million price for cache hits; cache writes are billed at 1.25x input.
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

function catalogFor(modelId) {
  if (!modelId) return null;
  return CATALOG.find((m) => modelId === m.id || modelId.startsWith(m.id + "-")) || null;
}

function estimateCost(modelId, usage) {
  const m = catalogFor(modelId);
  if (!m || !usage) return null;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const usd = (inTok * m.in + outTok * m.out + cacheRead * m.cacheRead + cacheWrite * m.in * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

function pickUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  };
}

// ---------------------------------------------------------------- usage ledger
// One JSON line per completed request. Loaded into memory at boot; appended on
// every request. This is an estimate from token counts at list prices, not a
// billing statement.
const ledger = [];
try {
  for (const line of fs.readFileSync(LEDGER_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      ledger.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
} catch {
  /* no ledger yet */
}

function recordUsage(entry) {
  ledger.push(entry);
  fs.appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", (err) => {
    if (err) log("Warning: could not write usage ledger:", err.message);
  });
}

let lastRateLimit = null;
function captureRateLimit(headers) {
  if (!headers) return;
  const out = {};
  let any = false;
  headers.forEach((v, k) => {
    if (k.startsWith("anthropic-ratelimit-")) {
      out[k.slice("anthropic-ratelimit-".length)] = v;
      any = true;
    }
  });
  if (any) lastRateLimit = { at: Date.now(), ...out };
}

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

function usageReport() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const today = ledger.filter((e) => e.ts >= startOfDay);
  const week = ledger.filter((e) => e.ts >= weekAgo);
  const month = ledger.filter((e) => e.ts >= startOfMonth);
  const byModel = {};
  for (const e of month) {
    const k = e.model || "unknown";
    (byModel[k] ||= []).push(e);
  }
  const monthCost = summarize(month).cost;
  const budget = settings.monthlyBudget;
  // Daily buckets for the last 30 days (for the sparkline).
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d0 = startOfDay - i * 86_400_000;
    const d1 = d0 + 86_400_000;
    const slice = ledger.filter((e) => e.ts >= d0 && e.ts < d1);
    days.push({ day: new Date(d0).toISOString().slice(0, 10), cost: summarize(slice).cost, requests: slice.length });
  }
  return {
    now: now.getTime(),
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    totals: {
      today: summarize(today),
      week: summarize(week),
      month: summarize(month),
      all: summarize(ledger),
    },
    byModel: Object.entries(byModel)
      .map(([model, entries]) => ({ model, ...summarize(entries) }))
      .sort((a, b) => b.cost - a.cost),
    days,
    budget: {
      monthly: budget,
      spent: monthCost,
      remaining: budget == null ? null : Math.round((budget - monthCost) * 1e6) / 1e6,
    },
    rateLimit: lastRateLimit,
    recent: ledger.slice(-25).reverse(),
  };
}

// ---------------------------------------------------------------- file store
// Uploaded files live in data/uploads/<id>; files.json is the index. Messages
// reference uploads as {type:"file", id} and the server expands them into
// image / document blocks when it talks to the API.
let fileIndex = readJson(FILE_INDEX_PATH, []);
const saveFileIndex = () => writeJson(FILE_INDEX_PATH, fileIndex);

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
  "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "hpp", "cc", "cs", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "r", "swift", "scala", "lua", "pl", "env",
  "dockerfile", "makefile", "gitignore", "svg", "tex", "rst", "org", "diff", "patch",
]);
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_PDF = 32 * 1024 * 1024;
const MAX_TEXT_FILE = 2 * 1024 * 1024;

function classifyFile(name, mime) {
  const ext = (name.includes(".") ? name.split(".").pop() : name).toLowerCase();
  mime = (mime || "").split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(mime)) return { kind: "image", mime };
  if (mime === "image/jpg") return { kind: "image", mime: "image/jpeg" };
  if (ext === "jpg" || ext === "jpeg") return { kind: "image", mime: "image/jpeg" };
  if (ext === "png") return { kind: "image", mime: "image/png" };
  if (ext === "gif") return { kind: "image", mime: "image/gif" };
  if (ext === "webp") return { kind: "image", mime: "image/webp" };
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  if (mime.startsWith("text/") || TEXT_EXT.has(ext) || ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/toml"].includes(mime)) {
    return { kind: "text", mime: mime || "text/plain" };
  }
  return null;
}

function safeName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
}

function fileToBlock(entry) {
  const buf = fs.readFileSync(path.join(UPLOAD_DIR, entry.id));
  if (entry.kind === "image") {
    return { type: "image", source: { type: "base64", media_type: entry.mime, data: buf.toString("base64") } };
  }
  if (entry.kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: entry.name };
  }
  return { type: "document", source: { type: "text", media_type: "text/plain", data: buf.toString("utf8") }, title: entry.name };
}

// ---------------------------------------------------------------- auth
// The cookie never contains the password. It holds an expiry + nonce signed
// with an HMAC whose key is derived from SESSION_SECRET *and* the password,
// so changing either one invalidates every existing login.
const sessionKey = crypto.createHmac("sha256", SESSION_SECRET).update(PASSWORD).digest();
const sign = (data) => crypto.createHmac("sha256", sessionKey).update(data).digest("base64url");

function issueToken() {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const body = `${exp}.${nonce}`;
  return `${body}.${sign(body)}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyToken(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!/^\d{1,16}$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(`${exp}.${nonce}`));
}

function passwordMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function cookieHeader(value, maxAgeSec) {
  const bits = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (COOKIE_SECURE) bits.push("Secure");
  return bits.join("; ");
}

const isAuthed = (req) => verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not logged in" });
}

// Login brute-force protection: 5 free tries per IP, then an exponential
// lockout (1 min, 2 min, 4 min ... capped at 1 hour).
const attempts = new Map();
const FREE_FAILS = 5;
function lockState(ip) {
  const s = attempts.get(ip);
  if (!s) return { locked: false, fails: 0 };
  if (s.lockUntil > Date.now()) {
    return { locked: true, fails: s.fails, retryAfter: Math.ceil((s.lockUntil - Date.now()) / 1000) };
  }
  return { locked: false, fails: s.fails };
}
function recordFail(ip) {
  const s = attempts.get(ip) || { fails: 0, lockUntil: 0, last: 0 };
  s.fails += 1;
  s.last = Date.now();
  if (s.fails >= FREE_FAILS) {
    const n = s.fails - FREE_FAILS;
    s.lockUntil = Date.now() + Math.min(3_600_000, 60_000 * 2 ** n);
  }
  attempts.set(ip, s);
  return s;
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 3_600_000;
  for (const [ip, s] of attempts) if (s.last < cutoff && s.lockUntil < Date.now()) attempts.delete(ip);
}, 600_000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- app
const client = new Anthropic();
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "font-src 'self' https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Every /api route is no-store, and every non-GET needs a custom header that a
// cross-site form cannot set (CSRF belt-and-braces on top of SameSite=Strict).
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.get("x-requested-with") !== "claude-terminal") {
    return res.status(403).json({ error: "Missing X-Requested-With header" });
  }
  next();
});

app.use("/api/upload", express.raw({ type: () => true, limit: "40mb" }));
app.use(express.json({ limit: "5mb" }));

app.get("/api/me", (req, res) => {
  res.json({ authed: isAuthed(req), defaultModel: DEFAULT_MODEL });
});

app.post("/api/login", async (req, res) => {
  const ip = req.ip || "unknown";
  const state = lockState(ip);
  if (state.locked) {
    res.setHeader("Retry-After", String(state.retryAfter));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${state.retryAfter}s.`, retryAfter: state.retryAfter });
  }
  const { password } = req.body || {};
  // A small delay on every attempt slows online guessing further.
  await sleep(250 + Math.floor(Math.random() * 150));
  if (!passwordMatches(password)) {
    const s = recordFail(ip);
    const remaining = Math.max(0, FREE_FAILS - s.fails);
    const now = lockState(ip);
    if (now.locked) {
      res.setHeader("Retry-After", String(now.retryAfter));
      return res.status(429).json({ error: `Wrong password. Locked for ${now.retryAfter}s.`, retryAfter: now.retryAfter });
    }
    return res.status(401).json({ error: remaining > 0 ? `Wrong password (${remaining} tries left before lockout).` : "Wrong password.", remaining });
  }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", cookieHeader(issueToken(), SESSION_DAYS * 86_400));
  res.json({ ok: true, days: SESSION_DAYS });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", cookieHeader("", 0));
  res.json({ ok: true });
});

function describeError(e) {
  if (e instanceof Anthropic.APIError) {
    const nested = e.error && e.error.error && e.error.error.message;
    return { status: e.status || 0, message: nested || e.message };
  }
  return { status: 0, message: (e && e.message) || String(e) };
}

// Curated catalog, filtered to what the key can actually see. Cached 10 min.
let modelCache = { at: 0, data: null };
app.get("/api/models", requireAuth, async (req, res) => {
  if (modelCache.data && Date.now() - modelCache.at < 600_000) return res.json(modelCache.data);
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
      } else {
        out.push({
          id: m.id, liveId: m.id, name: m.display_name || m.id, display: m.display_name || m.id,
          in: null, out: null, cacheRead: null, thinking: "unknown", efforts: [], fallbacks: false, defaultEffort: null,
        });
      }
    }
    out.sort((a, b) => {
      const ia = CATALOG.findIndex((c) => c.id === a.id);
      const ib = CATALOG.findIndex((c) => c.id === b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    modelCache = { at: Date.now(), data: out };
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: `Could not list models: ${describeError(e).message}` });
  }
});

// ---------------------------------------------------------------- usage + budget
app.get("/api/usage", requireAuth, (req, res) => res.json(usageReport()));

app.post("/api/budget", requireAuth, (req, res) => {
  const v = req.body && req.body.monthly;
  if (v === null || v === "" || v === undefined) settings.monthlyBudget = null;
  else {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "Budget must be a non-negative number" });
    settings.monthlyBudget = n;
  }
  try {
    writeJson(SETTINGS_PATH, settings);
  } catch (e) {
    return res.status(500).json({ error: `Could not save settings: ${e.message}` });
  }
  res.json({ ok: true, monthly: settings.monthlyBudget });
});

// ---------------------------------------------------------------- files
app.get("/api/files", requireAuth, (req, res) => {
  res.json(fileIndex.slice().sort((a, b) => b.ts - a.ts));
});

app.post("/api/upload", requireAuth, (req, res) => {
  const name = safeName(req.query.name);
  const mime = String(req.query.type || req.get("content-type") || "");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) return res.status(400).json({ error: "Empty upload" });
  const cls = classifyFile(name, mime);
  if (!cls) return res.status(415).json({ error: `Unsupported file type for "${name}". Supported: images (png/jpg/gif/webp), PDF, and text/code files.` });
  const limit = cls.kind === "image" ? MAX_IMAGE : cls.kind === "pdf" ? MAX_PDF : MAX_TEXT_FILE;
  if (body.length > limit) return res.status(413).json({ error: `"${name}" is too large (${(body.length / 1048576).toFixed(1)} MB; limit ${(limit / 1048576).toFixed(0)} MB for ${cls.kind}).` });
  if (cls.kind === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return res.status(415).json({ error: `"${name}" is not valid UTF-8 text.` });
    }
  }
  const entry = {
    id: crypto.randomBytes(12).toString("hex"),
    name,
    kind: cls.kind,
    mime: cls.mime,
    size: body.length,
    ts: Date.now(),
    source: req.query.source === "assistant" ? "assistant" : "upload",
  };
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, entry.id), body);
    fileIndex.push(entry);
    saveFileIndex();
  } catch (e) {
    return res.status(500).json({ error: `Could not store file: ${e.message}` });
  }
  res.json(entry);
});

function findFile(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  return fileIndex.find((f) => f.id === id) || null;
}

app.get("/api/files/:id", requireAuth, (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "No such file" });
  const inline = req.query.inline === "1" && f.kind === "image";
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.sendFile(path.join(UPLOAD_DIR, f.id));
});

app.delete("/api/files/:id", requireAuth, (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "No such file" });
  fileIndex = fileIndex.filter((x) => x.id !== f.id);
  saveFileIndex();
  fs.rm(path.join(UPLOAD_DIR, f.id), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- request validation
const MAX_MESSAGES = 400;
const MAX_TEXT = 400_000;

function cleanBlock(b) {
  if (!b || typeof b !== "object") return null;
  if (b.type === "text") {
    if (typeof b.text !== "string" || b.text.length > MAX_TEXT) return null;
    return { type: "text", text: b.text };
  }
  if (b.type === "file") {
    const f = findFile(b.id);
    if (!f) return { error: `Attached file no longer exists (${b.name || b.id}). Remove it from the message.` };
    try {
      return fileToBlock(f);
    } catch {
      return { error: `Could not read attached file ${f.name}` };
    }
  }
  return null;
}

function parseChatRequest(body) {
  if (!body || typeof body !== "object") return { error: "Bad request body" };
  const model = typeof body.model === "string" && /^[a-z0-9.-]{3,80}$/i.test(body.model) ? body.model : DEFAULT_MODEL;
  const system = typeof body.system === "string" ? body.system.slice(0, MAX_TEXT) : "";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: "messages must be a non-empty array" };
  if (body.messages.length > MAX_MESSAGES) return { error: `Too many messages (max ${MAX_MESSAGES})` };
  const messages = [];
  for (const m of body.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return { error: "Each message needs role user|assistant" };
    let content;
    if (typeof m.content === "string") {
      if (m.content.length > MAX_TEXT) return { error: "Message too long" };
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map(cleanBlock);
      const bad = content.find((b) => !b || b.error);
      if (bad && bad.error) return { error: bad.error };
      if (bad !== undefined || content.length === 0) return { error: "Unsupported content block" };
    } else return { error: "Message content must be a string or block array" };
    messages.push({ role: m.role, content });
  }
  if (messages[0].role !== "user") return { error: "Conversation must start with a user message" };
  if (messages[messages.length - 1].role !== "user") return { error: "Last message must be from the user" };

  const info = catalogFor(model);
  let effort = typeof body.effort === "string" ? body.effort : null;
  if (effort && (!info || !info.efforts.includes(effort))) effort = null;
  let maxTokens = Number(body.maxTokens);
  if (!Number.isFinite(maxTokens)) maxTokens = 16000;
  maxTokens = Math.max(256, Math.min(128000, Math.floor(maxTokens)));
  const showThinking = body.showThinking !== false;
  const fallbacks = body.fallbacks !== false && !!(info && info.fallbacks);
  const conv = typeof body.conv === "string" ? body.conv.slice(0, 40) : null;
  return { model, system, messages, effort, maxTokens, showThinking, fallbacks, info, conv };
}

// ---------------------------------------------------------------- chat (SSE)
app.post("/api/chat", requireAuth, async (req, res) => {
  const parsed = parseChatRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { model, system, messages, effort, maxTokens, showThinking, fallbacks, info, conv } = parsed;

  const params = { model, max_tokens: maxTokens, messages };
  if (system) params.system = system;
  if (effort) params.output_config = { effort };

  const mode = info ? info.thinking : "unknown";
  if (mode === "always") {
    // Fable: thinking is always on; only ask for a summary when it will be shown.
    if (showThinking) params.thinking = { type: "adaptive", display: "summarized" };
  } else if (mode === "adaptive") {
    params.thinking = showThinking ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
  } else if (mode === "budget") {
    if (showThinking) params.thinking = { type: "enabled", budget_tokens: Math.min(8000, Math.max(1024, maxTokens - 1)) };
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  let stream;
  try {
    stream = fallbacks
      ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : client.messages.stream(params);
  } catch (e) {
    send({ t: "error", ...describeError(e) });
    return res.end();
  }

  let finished = false;
  res.on("close", () => {
    if (!finished) stream.abort();
  });

  const started = Date.now();
  let rate = null;
  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "message_start":
          if (stream.response) {
            captureRateLimit(stream.response.headers);
            rate = lastRateLimit;
          }
          send({ t: "start", model: ev.message.model });
          break;
        case "content_block_start": {
          const cb = ev.content_block;
          if (cb.type === "fallback") {
            send({ t: "fallback", from: cb.from && cb.from.model, to: cb.to && cb.to.model });
          } else if (cb.type === "thinking" && showThinking) {
            send({ t: "think_start" });
          } else if (cb.type === "text") {
            send({ t: "text_start" });
          }
          break;
        }
        case "content_block_delta":
          if (ev.delta.type === "text_delta") send({ t: "text", v: ev.delta.text });
          else if (ev.delta.type === "thinking_delta" && showThinking && ev.delta.thinking) send({ t: "think", v: ev.delta.thinking });
          break;
        default:
          break;
      }
    }
    const final = await stream.finalMessage();
    finished = true;
    const usage = pickUsage(final.usage);
    const cost = estimateCost(final.model, final.usage);
    recordUsage({
      ts: Date.now(),
      model: final.model,
      conv,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cost: cost || 0,
      ms: Date.now() - started,
      stop: final.stop_reason,
    });
    const report = usageReport();
    send({
      t: "done",
      model: final.model,
      stop_reason: final.stop_reason,
      stop_details: final.stop_reason === "refusal" ? final.stop_details || null : null,
      usage,
      cost,
      ms: Date.now() - started,
      rateLimit: rate,
      budget: report.budget,
      today: report.totals.today.cost,
    });
  } catch (e) {
    finished = true;
    const aborted = e && (e.name === "APIUserAbortError" || e.name === "AbortError");
    if (!aborted) send({ t: "error", ...describeError(e) });
  }
  res.end();
});

// Token count for the current conversation ("/usage" in the UI).
app.post("/api/count", requireAuth, async (req, res) => {
  const parsed = parseChatRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const params = { model: parsed.model, messages: parsed.messages };
    if (parsed.system) params.system = parsed.system;
    const r = await client.messages.countTokens(params);
    res.json({ input_tokens: r.input_tokens });
  } catch (e) {
    res.status(502).json({ error: describeError(e).message });
  }
});

app.use(express.static(path.join(here, "public"), { index: "index.html" }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 413 ? "Request too large" : err.message || "Server error" });
});

app.listen(PORT, HOST, () => {
  log(`Listening on http://${HOST}:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") log("Reachable from other machines on your network. Keep the password strong.");
});
