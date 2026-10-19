// Boots the Worker locally with `wrangler dev` (local KV, throwaway access
// key) and checks the access-key gate, thread storage with first-in-first-out
// eviction, settings, and file storage. Never calls the Anthropic API.
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

const cmd = `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to "${persist}" --var ACCESS_KEY:${KEY} --var MAX_THREADS:5 --var MAX_FILES:5 --show-interactive-dev-session=false`;
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
  check("not authed by default", me.authed === false && me.limits && me.limits.threads === 5, JSON.stringify(me));

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

  const usage = await fetch(`${base}/api/usage`, { headers: authGet });
  check("usage works with the token", usage.status === 200, `status ${usage.status}`);

  const forged = await fetch(`${base}/api/usage`, { headers: { Authorization: "Bearer 9999999999999.abc.forged" } });
  check("forged token is rejected", forged.status === 401, `status ${forged.status}`);

  const chat = await fetch(`${base}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ messages: [] }) });
  check("chat refuses without an API key or valid input", chat.status === 503 || chat.status === 400, `status ${chat.status}`);

  // threads: save, read back, bad id, FIFO eviction, delete
  const mk = (id, createdAt) => ({ id, title: `Thread ${id}`, createdAt, messages: [{ id: "m1", role: "user", text: "hello " + id, files: [], ts: createdAt }], cost: 0, tokens: { in: 0, out: 0 } });
  const put = await fetch(`${base}/api/threads/smoke01`, { method: "PUT", headers: auth, body: JSON.stringify(mk("smoke01", 1000)) });
  check("thread saves", put.status === 200, `status ${put.status} ${await put.text()}`);
  const got = await (await fetch(`${base}/api/threads/smoke01`, { headers: authGet })).json();
  check("thread round-trips", got.title === "Thread smoke01" && got.messages.length === 1 && got.messages[0].text === "hello smoke01", JSON.stringify(got).slice(0, 200));
  const badId = await fetch(`${base}/api/threads/BAD$ID`, { method: "PUT", headers: auth, body: JSON.stringify(mk("x", 1)) });
  check("thread rejects a bad id", badId.status === 404 || badId.status === 400, `status ${badId.status}`);
  for (let i = 2; i <= 6; i++) await fetch(`${base}/api/threads/smoke0${i}`, { method: "PUT", headers: auth, body: JSON.stringify(mk(`smoke0${i}`, 1000 * i)) });
  const list = await (await fetch(`${base}/api/threads`, { headers: authGet })).json();
  const ids = list.threads.map((t) => t.id);
  check("oldest thread is evicted past the cap (FIFO)", ids.length === 5 && !ids.includes("smoke01") && ids.includes("smoke06"), ids.join(","));
  const gone = await fetch(`${base}/api/threads/smoke01`, { headers: authGet });
  check("evicted thread content is removed", gone.status === 404, `status ${gone.status}`);
  const del = await fetch(`${base}/api/threads/smoke06`, { method: "DELETE", headers: auth });
  check("thread deletes", del.status === 200, `status ${del.status}`);

  // settings
  const st = await fetch(`${base}/api/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ jurisdiction: "New York", effort: "medium", monthlyBudget: 12, highlight: false }) });
  const stj = await st.json();
  check("settings save", st.status === 200 && stj.jurisdiction === "New York" && stj.effort === "medium" && stj.monthlyBudget === 12 && stj.highlight === false, JSON.stringify(stj));
  const stBad = await fetch(`${base}/api/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ effort: "bananas" }) });
  check("settings reject a bad effort", stBad.status === 400, `status ${stBad.status}`);

  // files: upload a text file (base64), list, fetch, FIFO, delete
  const b64 = Buffer.from("name,qty\napple,3\n").toString("base64");
  const up = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: JSON.stringify({ name: "fruit.csv", type: "text/csv", b64 }) });
  const upj = await up.json();
  check("text upload is stored", up.status === 200 && upj.kind === "text" && upj.size === 17, `status ${up.status} ${JSON.stringify(upj)}`);
  const bad = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: JSON.stringify({ name: "virus.exe", type: "application/octet-stream", b64 }) });
  check("unsupported file type is refused", bad.status === 415, `status ${bad.status}`);
  const file = await (await fetch(`${base}/api/files/${upj.id}`, { headers: authGet })).json();
  check("file fetch returns content and text", file.b64 === b64 && file.text === "name,qty\napple,3\n", JSON.stringify(file).slice(0, 200));
  for (let i = 0; i < 5; i++) await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: JSON.stringify({ name: `n${i}.txt`, type: "text/plain", b64 }) });
  const files = await (await fetch(`${base}/api/files`, { headers: authGet })).json();
  check("oldest file is evicted past the cap (FIFO)", files.files.length === 5 && !files.files.find((f) => f.id === upj.id), files.files.map((f) => f.name).join(","));
  const fdel = await fetch(`${base}/api/files/${files.files[0].id}`, { method: "DELETE", headers: auth });
  check("file deletes", fdel.status === 200, `status ${fdel.status}`);

  // usage report from the browser
  const rep = await fetch(`${base}/api/usage`, { method: "POST", headers: auth, body: JSON.stringify({ model: "claude-opus-5-5", conv: "smoke02", usage: { input_tokens: 1000, output_tokens: 500 }, ms: 1200, stop: "end_turn" }) });
  const repj = await rep.json();
  check("usage entry is recorded with a cost", rep.status === 200 && Math.abs(repj.cost - 0.014) < 1e-6 && repj.today === repj.cost, JSON.stringify(repj));
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
