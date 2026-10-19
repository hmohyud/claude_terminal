import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import { marked } from "marked";
import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";

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
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const LEDGER_PATH = path.join(DATA_DIR, "usage.jsonl");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const FILE_INDEX_PATH = path.join(DATA_DIR, "files.json");
const THREAD_DIR = path.join(DATA_DIR, "threads");
// Storage caps. Everything is first in, first out: when a cap is exceeded the
// oldest thread or file is removed to make room.
const MAX_THREADS = Math.max(5, Number(process.env.MAX_THREADS) || 200);
const MAX_FILES = Math.max(5, Number(process.env.MAX_FILES) || 300);
const MAX_FILES_MB = Math.max(10, Number(process.env.MAX_FILES_MB) || 1024);

if (!process.env.ANTHROPIC_API_KEY) fatal("ANTHROPIC_API_KEY is missing. Copy .env.example to .env and fill it in.");
if (!PASSWORD || PASSWORD === "change-me") fatal("TERMINAL_PASSWORD is missing. Set it in .env.");
if (PASSWORD.length < 8) fatal("TERMINAL_PASSWORD must be at least 8 characters.");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THREAD_DIR, { recursive: true });

// SESSION_SECRET can come from the environment; otherwise it is generated once
// and kept in DATA_DIR so logins survive restarts and container rebuilds.
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  const secretFile = path.join(DATA_DIR, "session-secret");
  try {
    SESSION_SECRET = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    /* none yet */
  }
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(secretFile, SESSION_SECRET + "\n", { mode: 0o600 });
      log(`Generated a session secret and saved it to ${secretFile}`);
    } catch {
      log("Warning: could not save the session secret; logins will not survive a restart.");
    }
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

// Built-in instructions for legal work. Users can edit or replace them in
// settings; the client appends the jurisdiction and today's date.
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
  monthlyBudget: null,
  model: null, // null = DEFAULT_MODEL
  effort: "high",
  showThinking: true,
  maxTokens: 16000,
  fallbacks: true,
  theme: "light",
  jurisdiction: "Federal (U.S.)",
  systemPrompt: null, // null = LEGAL_SYSTEM_PROMPT
};
const settings = { ...SETTING_DEFAULTS, ...readJson(SETTINGS_PATH, {}) };
if (settings.monthlyBudget === undefined || settings.monthlyBudget === null) {
  settings.monthlyBudget = Number(process.env.MONTHLY_BUDGET_USD) || null;
}

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
const MAX_DOCX = 20 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  if (mime === DOCX_MIME || ext === "docx") return { kind: "docx", mime: DOCX_MIME };
  if (mime === "application/msword" || ext === "doc") return { error: `"${name}" is an old-style .doc file. Open it in Word and save it as .docx first.` };
  if (mime.startsWith("text/") || TEXT_EXT.has(ext) || ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/toml"].includes(mime)) {
    return { kind: "text", mime: mime || "text/plain" };
  }
  return null;
}

function safeName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
}

function removeFileFromDisk(id) {
  fs.rm(path.join(UPLOAD_DIR, id), { force: true }, () => {});
  fs.rm(path.join(UPLOAD_DIR, id + ".txt"), { force: true }, () => {});
}

// First in, first out: drop the oldest uploads once the count or size cap is hit.
function enforceFileCaps() {
  const sorted = fileIndex.slice().sort((a, b) => a.ts - b.ts);
  let total = sorted.reduce((s, f) => s + (f.size || 0), 0);
  const removed = [];
  while (sorted.length && (sorted.length > MAX_FILES || total > MAX_FILES_MB * 1048576)) {
    const f = sorted.shift();
    total -= f.size || 0;
    removed.push(f);
  }
  if (!removed.length) return 0;
  const gone = new Set(removed.map((f) => f.id));
  fileIndex = fileIndex.filter((f) => !gone.has(f.id));
  saveFileIndex();
  for (const f of removed) removeFileFromDisk(f.id);
  return removed.length;
}

function fileToBlock(entry) {
  const buf = fs.readFileSync(path.join(UPLOAD_DIR, entry.id));
  if (entry.kind === "image") {
    return { type: "image", source: { type: "base64", media_type: entry.mime, data: buf.toString("base64") } };
  }
  if (entry.kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: entry.name };
  }
  if (entry.kind === "docx") {
    const text = fs.readFileSync(path.join(UPLOAD_DIR, entry.id + ".txt"), "utf8");
    return { type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: entry.name };
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
      "frame-src 'self'",
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
app.use(express.json({ limit: "6mb" }));

app.get("/api/me", (req, res) => {
  res.json({
    authed: isAuthed(req),
    defaultModel: DEFAULT_MODEL,
    legalPrompt: LEGAL_SYSTEM_PROMPT,
    limits: { threads: MAX_THREADS, files: MAX_FILES, filesMb: MAX_FILES_MB },
  });
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

// ---------------------------------------------------------------- settings
function saveSettings() {
  writeJson(SETTINGS_PATH, settings);
}

app.get("/api/settings", requireAuth, (req, res) => res.json(settings));

app.put("/api/settings", requireAuth, (req, res) => {
  const b = req.body || {};
  const errors = [];
  const str = (k, max) => {
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
    if (b.effort === null || b.effort === "" || ["low", "medium", "high", "xhigh", "max"].includes(b.effort)) settings.effort = b.effort || null;
    else errors.push("effort");
  }
  if (b.theme !== undefined) settings.theme = b.theme === "dark" ? "dark" : "light";
  str("model", 80);
  str("jurisdiction", 60);
  str("systemPrompt", 40_000);
  bool("showThinking");
  bool("fallbacks");
  if (errors.length) return res.status(400).json({ error: `Invalid value for ${errors.join(", ")}` });
  try {
    saveSettings();
  } catch (e) {
    return res.status(500).json({ error: `Could not save settings: ${e.message}` });
  }
  res.json(settings);
});

// ---------------------------------------------------------------- threads
// Threads are stored on the server (data/threads/<id>.json) so every browser
// that knows the password sees the same history. First in, first out past
// MAX_THREADS: the oldest-created thread is dropped.
const threads = new Map();
for (const name of fs.readdirSync(THREAD_DIR)) {
  if (!name.endsWith(".json")) continue;
  const t = readJson(path.join(THREAD_DIR, name), null);
  if (t && typeof t === "object" && t.id === name.slice(0, -5)) threads.set(t.id, t);
}
const THREAD_ID = /^[a-z0-9]{6,24}$/;

function threadSummary(t) {
  return {
    id: t.id,
    title: t.title || "Untitled",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    cost: t.cost || 0,
    count: (t.messages || []).filter((m) => m.role !== "note").length,
    jurisdiction: t.jurisdiction || null,
    model: t.model || null,
  };
}

function enforceThreadCap() {
  if (threads.size <= MAX_THREADS) return;
  const ordered = [...threads.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  while (threads.size > MAX_THREADS && ordered.length) {
    const t = ordered.shift();
    threads.delete(t.id);
    fs.rm(path.join(THREAD_DIR, t.id + ".json"), { force: true }, () => {});
  }
}

function cleanThread(id, b) {
  if (!b || typeof b !== "object") return { error: "Bad thread body" };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const s = (v, max, d = "") => (typeof v === "string" ? v.slice(0, max) : d);
  if (!Array.isArray(b.messages) || b.messages.length > 2000) return { error: "Bad messages" };
  const messages = [];
  for (const m of b.messages) {
    if (!m || !["user", "assistant", "note"].includes(m.role)) return { error: "Bad message role" };
    const files = [];
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (!f || !/^[a-f0-9]{24}$/.test(String(f.id))) continue;
      files.push({ id: f.id, name: s(f.name, 120, "file"), kind: s(f.kind, 10), mime: s(f.mime, 100), size: num(f.size, 0) });
    }
    const meta = m.meta && typeof m.meta === "object" ? m.meta : {};
    messages.push({
      id: s(m.id, 24, crypto.randomBytes(6).toString("hex")),
      role: m.role,
      text: s(m.text, MAX_TEXT),
      thinking: s(m.thinking, 200_000),
      files,
      ts: num(m.ts, Date.now()),
      meta: {
        model: s(meta.model, 80),
        usage: meta.usage && typeof meta.usage === "object" ? pickUsage(meta.usage) : undefined,
        cost: meta.cost == null ? undefined : num(meta.cost, 0),
        ms: meta.ms == null ? undefined : num(meta.ms, 0),
        stop_reason: s(meta.stop_reason, 40) || undefined,
        error: s(meta.error, 2000) || undefined,
        fallback: s(meta.fallback, 200) || undefined,
        stopped: meta.stopped ? true : undefined,
      },
    });
  }
  return {
    thread: {
      id,
      title: s(b.title, 120, "Untitled"),
      createdAt: num(b.createdAt, Date.now()),
      updatedAt: Date.now(),
      model: s(b.model, 80) || null,
      system: s(b.system, 40_000),
      jurisdiction: s(b.jurisdiction, 60) || null,
      messages,
      cost: num(b.cost, 0),
      tokens: { in: num(b.tokens && b.tokens.in, 0), out: num(b.tokens && b.tokens.out, 0) },
    },
  };
}

app.get("/api/threads", requireAuth, (req, res) => {
  res.json({
    threads: [...threads.values()].map(threadSummary).sort((a, b) => b.updatedAt - a.updatedAt),
    limit: MAX_THREADS,
  });
});

app.get("/api/threads/:id", requireAuth, (req, res) => {
  const t = THREAD_ID.test(req.params.id) && threads.get(req.params.id);
  if (!t) return res.status(404).json({ error: "No such thread" });
  res.json(t);
});

app.put("/api/threads/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  if (!THREAD_ID.test(id)) return res.status(400).json({ error: "Bad thread id" });
  const r = cleanThread(id, req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  const existing = threads.get(id);
  if (existing) r.thread.createdAt = existing.createdAt || r.thread.createdAt;
  try {
    writeJson(path.join(THREAD_DIR, id + ".json"), r.thread);
  } catch (e) {
    return res.status(500).json({ error: `Could not save thread: ${e.message}` });
  }
  threads.set(id, r.thread);
  enforceThreadCap();
  res.json(threadSummary(r.thread));
});

app.delete("/api/threads/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  if (!THREAD_ID.test(id) || !threads.has(id)) return res.status(404).json({ error: "No such thread" });
  threads.delete(id);
  fs.rm(path.join(THREAD_DIR, id + ".json"), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Word export
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function inlineRuns(tokens, style = {}) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "strong":
        runs.push(...inlineRuns(t.tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(t.tokens, { ...style, italics: true }));
        break;
      case "del":
        runs.push(...inlineRuns(t.tokens, { ...style, strike: true }));
        break;
      case "codespan":
        runs.push(new TextRun({ text: t.text, font: "Consolas", ...style }));
        break;
      case "br":
        runs.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link":
        runs.push(new ExternalHyperlink({ link: t.href, children: inlineRuns(t.tokens, { ...style, style: "Hyperlink" }) }));
        break;
      case "image":
        runs.push(new TextRun({ text: `[image: ${t.text || t.href}]`, italics: true, ...style }));
        break;
      default:
        if (t.tokens && t.tokens.length) runs.push(...inlineRuns(t.tokens, style));
        else if (typeof t.text === "string") runs.push(new TextRun({ text: t.text, ...style }));
    }
  }
  return runs;
}

function markdownToDocx(markdown, title) {
  const numberings = [];
  const newNumbering = (start) => {
    const reference = `num-${numberings.length + 1}`;
    numberings.push({
      reference,
      levels: [0, 1, 2, 3].map((level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        start: level === 0 ? Math.max(1, Number(start) || 1) : 1,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
      })),
    });
    return reference;
  };
  const indentOf = (depth) => (depth ? { left: 720 * depth } : undefined);

  function listItem(item, ref, level, depth) {
    const out = [];
    for (const sub of item.tokens || []) {
      if (sub.type === "list") {
        const subRef = sub.ordered ? newNumbering(sub.start) : null;
        for (const it of sub.items) out.push(...listItem(it, subRef, level + 1, depth));
        continue;
      }
      const runs = inlineRuns(sub.tokens && sub.tokens.length ? sub.tokens : [{ type: "text", text: sub.text || sub.raw || "" }]);
      out.push(new Paragraph({ children: runs, ...(ref ? { numbering: { reference: ref, level } } : { bullet: { level } }), spacing: { after: 60 } }));
    }
    return out;
  }

  function blocks(tokens, depth = 0) {
    const out = [];
    for (const t of tokens) {
      switch (t.type) {
        case "heading":
          out.push(new Paragraph({ heading: HEADINGS[Math.min(Math.max(t.depth, 1), 6) - 1], children: inlineRuns(t.tokens), indent: indentOf(depth) }));
          break;
        case "paragraph":
        case "text":
          out.push(new Paragraph({ children: inlineRuns(t.tokens && t.tokens.length ? t.tokens : [{ type: "text", text: t.text || "" }]), spacing: { after: 160 }, indent: indentOf(depth) }));
          break;
        case "list": {
          const ref = t.ordered ? newNumbering(t.start) : null;
          for (const item of t.items) out.push(...listItem(item, ref, 0, depth));
          out.push(new Paragraph({ text: "", spacing: { after: 60 } }));
          break;
        }
        case "blockquote":
          out.push(...blocks(t.tokens, depth + 1));
          break;
        case "code":
          for (const line of String(t.text).split("\n")) {
            out.push(new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 18 })], shading: { type: ShadingType.CLEAR, fill: "F2F2F2" }, spacing: { after: 0 }, indent: indentOf(depth) }));
          }
          out.push(new Paragraph({ text: "", spacing: { after: 120 } }));
          break;
        case "hr":
          out.push(new Paragraph({ thematicBreak: true }));
          break;
        case "table": {
          const row = (cells, header) =>
            new TableRow({
              tableHeader: header,
              children: cells.map(
                (c) =>
                  new TableCell({
                    children: [new Paragraph({ children: inlineRuns(c.tokens, header ? { bold: true } : {}) })],
                    shading: header ? { type: ShadingType.CLEAR, fill: "E8EEF5" } : undefined,
                  }),
              ),
            });
          out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(t.header, true), ...t.rows.map((r) => row(r, false))] }));
          out.push(new Paragraph({ text: "", spacing: { after: 120 } }));
          break;
        }
        case "html":
          out.push(new Paragraph({ text: String(t.text || ""), indent: indentOf(depth) }));
          break;
        default:
          break;
      }
    }
    return out;
  }

  const body = blocks(marked.lexer(markdown));
  if (!numberings.length) newNumbering(1);
  const doc = new Document({
    creator: "claude terminal",
    title: title || "Document",
    numbering: { config: numberings },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children: [...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []), ...body] }],
  });
  return Packer.toBuffer(doc);
}

app.post("/api/export/docx", requireAuth, async (req, res) => {
  const { title, markdown } = req.body || {};
  if (typeof markdown !== "string" || !markdown.trim()) return res.status(400).json({ error: "Nothing to export" });
  const name = safeName(String(title || "document").replace(/\.docx$/i, "")).slice(0, 80) + ".docx";
  try {
    const buf = await markdownToDocx(markdown.slice(0, MAX_TEXT), typeof title === "string" ? title.slice(0, 200) : "");
    res.setHeader("Content-Type", DOCX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `Could not build the Word file: ${e.message}` });
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
    saveSettings();
  } catch (e) {
    return res.status(500).json({ error: `Could not save settings: ${e.message}` });
  }
  res.json({ ok: true, monthly: settings.monthlyBudget });
});

// ---------------------------------------------------------------- files
app.get("/api/files", requireAuth, (req, res) => {
  res.json({
    files: fileIndex.slice().sort((a, b) => b.ts - a.ts),
    limit: MAX_FILES,
    limitMb: MAX_FILES_MB,
    usedBytes: fileIndex.reduce((s, f) => s + (f.size || 0), 0),
  });
});

app.post("/api/upload", requireAuth, async (req, res) => {
  const name = safeName(req.query.name);
  const mime = String(req.query.type || req.get("content-type") || "");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) return res.status(400).json({ error: "Empty upload" });
  const cls = classifyFile(name, mime);
  if (!cls) return res.status(415).json({ error: `Unsupported file type for "${name}". Supported: images (png/jpg/gif/webp), PDF, Word (.docx), and text/code files.` });
  if (cls.error) return res.status(415).json({ error: cls.error });
  const limit = { image: MAX_IMAGE, pdf: MAX_PDF, docx: MAX_DOCX }[cls.kind] || MAX_TEXT_FILE;
  if (body.length > limit) return res.status(413).json({ error: `"${name}" is too large (${(body.length / 1048576).toFixed(1)} MB; limit ${(limit / 1048576).toFixed(0)} MB for ${cls.kind}).` });
  if (cls.kind === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return res.status(415).json({ error: `"${name}" is not valid UTF-8 text.` });
    }
  }
  // Word files: extract the text once at upload time; that is what Claude reads.
  let docxText = null;
  if (cls.kind === "docx") {
    try {
      docxText = (await mammoth.extractRawText({ buffer: body })).value;
    } catch {
      return res.status(415).json({ error: `"${name}" could not be read as a Word document.` });
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
    if (docxText != null) fs.writeFileSync(path.join(UPLOAD_DIR, entry.id + ".txt"), docxText);
    fileIndex.push(entry);
    saveFileIndex();
  } catch (e) {
    return res.status(500).json({ error: `Could not store file: ${e.message}` });
  }
  const evicted = enforceFileCaps();
  res.json({ ...entry, evicted });
});

function findFile(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  return fileIndex.find((f) => f.id === id) || null;
}

app.get("/api/files/:id", requireAuth, (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "No such file" });
  const inline = req.query.inline === "1" && (f.kind === "image" || f.kind === "pdf");
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  if (inline) {
    // Let the app's own preview pane frame this response (PDFs open in an iframe).
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  }
  res.sendFile(path.join(UPLOAD_DIR, f.id));
});

// Preview payload: Word files come back as HTML, text files as text; images and
// PDFs are shown by the browser straight from the inline URL.
app.get("/api/files/:id/preview", requireAuth, async (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "No such file" });
  const file = path.join(UPLOAD_DIR, f.id);
  try {
    if (f.kind === "docx") {
      const r = await mammoth.convertToHtml({ path: file });
      return res.json({ kind: "html", html: r.value });
    }
    if (f.kind === "text") return res.json({ kind: "text", text: fs.readFileSync(file, "utf8") });
    return res.json({ kind: f.kind, url: `/api/files/${f.id}?inline=1` });
  } catch (e) {
    res.status(500).json({ error: `Could not render preview: ${e.message}` });
  }
});

app.delete("/api/files/:id", requireAuth, (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "No such file" });
  fileIndex = fileIndex.filter((x) => x.id !== f.id);
  saveFileIndex();
  removeFileFromDisk(f.id);
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
