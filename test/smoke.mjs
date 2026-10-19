// Boots the server with throwaway settings and checks the password gate,
// cookie issuance, CSRF header requirement, and the static page. Never talks
// to the Anthropic API, so it is safe to run anywhere (CI included).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-terminal-smoke-"));
const PORT = 3900 + Math.floor(Math.random() * 100);
const PASSWORD = "smoke-test-password";
const base = `http://127.0.0.1:${PORT}`;
const H = { "X-Requested-With": "claude-terminal", "Content-Type": "application/json" };

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-ant-smoke-test-not-a-real-key",
    TERMINAL_PASSWORD: PASSWORD,
    SESSION_SECRET: "",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DATA_DIR: dataDir,
    MAX_THREADS: "5",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  check("server starts", await waitForServer(), serverOut.trim());
  if (failures) throw new Error("server did not start");

  const page = await fetch(base);
  check("serves the page", page.ok && (await page.text()).includes("claude terminal"));

  const me = await (await fetch(`${base}/api/me`)).json();
  check("not authed by default", me.authed === false);

  const noHeader = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  check("login without X-Requested-With is refused", noHeader.status === 403, `status ${noHeader.status}`);

  const wrong = await fetch(`${base}/api/login`, { method: "POST", headers: H, body: JSON.stringify({ password: "nope" }) });
  check("wrong password is rejected", wrong.status === 401, `status ${wrong.status}`);
  check("wrong password sets no cookie", !wrong.headers.get("set-cookie"));

  const locked = await fetch(`${base}/api/usage`);
  check("usage requires login", locked.status === 401, `status ${locked.status}`);

  const right = await fetch(`${base}/api/login`, { method: "POST", headers: H, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = right.headers.get("set-cookie") || "";
  check("right password is accepted", right.status === 200, `status ${right.status}`);
  check("cookie is HttpOnly + SameSite=Strict", /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie), cookie);
  check("cookie does not contain the password", !cookie.includes(PASSWORD));

  const session = cookie.split(";")[0];
  const usage = await fetch(`${base}/api/usage`, { headers: { Cookie: session } });
  check("usage works with the cookie", usage.status === 200, `status ${usage.status}`);

  const bad = await fetch(`${base}/api/chat`, { method: "POST", headers: { ...H, Cookie: session }, body: JSON.stringify({ messages: [] }) });
  check("chat validates its input", bad.status === 400, `status ${bad.status}`);

  // threads: save, list, read back, delete, and first-in-first-out eviction
  const auth = { ...H, Cookie: session };
  const mk = (id, createdAt) => ({ id, title: `Thread ${id}`, createdAt, messages: [{ id: "m1", role: "user", text: "hello " + id, files: [], ts: createdAt }], cost: 0, tokens: { in: 0, out: 0 } });
  const put = await fetch(`${base}/api/threads/smoke01`, { method: "PUT", headers: auth, body: JSON.stringify(mk("smoke01", 1000)) });
  check("thread saves", put.status === 200, `status ${put.status}`);
  const got = await (await fetch(`${base}/api/threads/smoke01`, { headers: { Cookie: session } })).json();
  check("thread round-trips", got.title === "Thread smoke01" && got.messages.length === 1 && got.messages[0].text === "hello smoke01");
  const badId = await fetch(`${base}/api/threads/BAD$ID`, { method: "PUT", headers: auth, body: JSON.stringify(mk("x", 1)) });
  check("thread rejects a bad id", badId.status === 400, `status ${badId.status}`);
  for (let i = 2; i <= 6; i++) await fetch(`${base}/api/threads/smoke0${i}`, { method: "PUT", headers: auth, body: JSON.stringify(mk(`smoke0${i}`, 1000 * i)) });
  const list = await (await fetch(`${base}/api/threads`, { headers: { Cookie: session } })).json();
  const ids = list.threads.map((t) => t.id);
  check("oldest thread is evicted past the cap (FIFO)", ids.length === 5 && !ids.includes("smoke01") && ids.includes("smoke06"), ids.join(","));
  const del = await fetch(`${base}/api/threads/smoke06`, { method: "DELETE", headers: auth });
  check("thread deletes", del.status === 200, `status ${del.status}`);

  // settings
  const st = await fetch(`${base}/api/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ jurisdiction: "New York", effort: "medium", monthlyBudget: 12 }) });
  const stj = await st.json();
  check("settings save", st.status === 200 && stj.jurisdiction === "New York" && stj.effort === "medium" && stj.monthlyBudget === 12, JSON.stringify(stj));
  const stBad = await fetch(`${base}/api/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ effort: "bananas" }) });
  check("settings reject a bad effort", stBad.status === 400, `status ${stBad.status}`);

  // Word export
  const md = "# Memo\n\nSome **bold** text with a [link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n```\ncode line\n```\n";
  const docx = await fetch(`${base}/api/export/docx`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Smoke memo", markdown: md }) });
  const bytes = Buffer.from(await docx.arrayBuffer());
  check("Word export returns a .docx", docx.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b, `status ${docx.status}`);
  try {
    const mammoth = (await import("mammoth")).default;
    const text = (await mammoth.extractRawText({ buffer: bytes })).value;
    check("Word export contains the text", /Smoke memo/.test(text) && /bold/.test(text) && /second/.test(text) && /code line/.test(text), text.slice(0, 200));
  } catch (e) {
    check("Word export readable by mammoth", false, e.message);
  }

  const forged = await fetch(`${base}/api/usage`, { headers: { Cookie: "ct_session=9999999999999.abc.forged" } });
  check("forged cookie is rejected", forged.status === 401, `status ${forged.status}`);

  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { ...H, Cookie: session }, body: "{}" });
  check("logout clears the cookie", /Max-Age=0/.test(out.headers.get("set-cookie") || ""));

  check("session secret persisted in DATA_DIR", fs.existsSync(path.join(dataDir, "session-secret")));
} catch (e) {
  check("unexpected error", false, e.message);
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  if (serverOut.trim()) console.error("server output:\n" + serverOut);
  process.exit(1);
}
console.log("\nall checks passed");
