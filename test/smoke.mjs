// Boots the Worker locally with `wrangler dev` (local KV, throwaway access
// key) and checks the access-key gate, the chat relay's guards, and usage
// reporting. Never calls the Anthropic API with a real key.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const persist = fs.mkdtempSync(path.join(os.tmpdir(), "claude-terminal-smoke-"));
const PORT = 8800 + Math.floor(Math.random() * 100);
const KEY = "smoke-test-access-key";
const base = `http://127.0.0.1:${PORT}`;
const H = { "X-Requested-With": "claude-terminal", "Content-Type": "application/json" };

const cmd = `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to "${persist}" --var ACCESS_KEY:${KEY} --var ANTHROPIC_API_KEY:sk-ant-smoke-invalid --var ANTHROPIC_ADMIN_KEY:sk-ant-admin-smoke-invalid --var MONTHLY_LIMIT_USD:50 --show-interactive-dev-session=false`;
const child = spawn(cmd, { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stop() {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

try {
  check("worker starts", await waitForServer(), out.slice(-800));
  if (failures) throw new Error("worker did not start");

  const page = await fetch(base);
  check("serves the page", page.ok && (await page.text()).includes("claude terminal"));

  const me = await (await fetch(`${base}/api/me`)).json();
  check("not authed by default", me.authed === false && typeof me.legalPrompt === "string", JSON.stringify(me).slice(0, 200));

  const noHeader = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY }) });
  check("login without X-Requested-With is refused", noHeader.status === 403, `status ${noHeader.status}`);

  const wrong = await fetch(`${base}/api/login`, { method: "POST", headers: H, body: JSON.stringify({ key: "nope" }) });
  check("wrong access key is rejected", wrong.status === 401, `status ${wrong.status}`);

  const locked = await fetch(`${base}/api/usage`);
  check("usage requires login", locked.status === 401, `status ${locked.status}`);

  const right = await fetch(`${base}/api/login`, { method: "POST", headers: H, body: JSON.stringify({ key: KEY }) });
  const login = await right.json().catch(() => ({}));
  check("right access key is accepted", right.status === 200 && typeof login.token === "string", `status ${right.status} ${JSON.stringify(login)}`);
  check("token does not contain the access key", !!login.token && !login.token.includes(KEY));
  const auth = { ...H, Authorization: `Bearer ${login.token}` };
  const authGet = { Authorization: `Bearer ${login.token}` };

  const forged = await fetch(`${base}/api/usage`, { headers: { Authorization: "Bearer 9999999999999.abc.forged" } });
  check("forged token is rejected", forged.status === 401, `status ${forged.status}`);

  const chat = await fetch(`${base}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  const chatBody = await chat.json().catch(() => ({}));
  check("a rejected API key surfaces as an error, not a sign-out", chat.status === 502 && /API key/i.test(chatBody.error || ""), `status ${chat.status} ${JSON.stringify(chatBody)}`);
  const chatNoJson = await fetch(`${base}/api/chat`, { method: "POST", headers: { ...authGet, "X-Requested-With": "claude-terminal" }, body: "x" });
  check("chat requires a JSON body", chatNoJson.status === 400 || chatNoJson.status === 503, `status ${chatNoJson.status}`);

  for (const p of ["/api/threads", "/api/files", "/api/settings"]) {
    const r = await fetch(`${base}${p}`, { headers: authGet });
    check(`no server storage at ${p}`, r.status === 404, `status ${r.status}`);
  }

  const rep = await fetch(`${base}/api/usage`, { method: "POST", headers: auth, body: JSON.stringify({ model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 500 }, ms: 1200, stop: "end_turn" }) });
  const repj = await rep.json();
  check("usage entry is recorded with a cost", rep.status === 200 && Math.abs(repj.cost - 0.014) < 1e-6 && repj.today === repj.cost, JSON.stringify(repj));
  const report = await (await fetch(`${base}/api/usage`, { headers: authGet })).json();
  check("an invalid Admin key falls back to the estimate", report.official && report.official.error && report.budget.source === "estimate" && report.budget.spent === repj.cost, JSON.stringify({ official: report.official, budget: report.budget }));
  check("monthly limit comes from the Worker config", report.budget.monthly === 50 && Math.abs(report.budget.remaining - (50 - repj.cost)) < 1e-6, JSON.stringify(report.budget));
} catch (e) {
  check("unexpected error", false, e.message);
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(persist, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  console.error("wrangler output (tail):\n" + out.slice(-3000));
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
