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
