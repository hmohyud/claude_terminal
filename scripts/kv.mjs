// Makes sure the KV namespace exists on the Cloudflare account and writes its
// id into wrangler.toml. Run by the deploy workflow before `wrangler deploy`.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
import { execSync } from "node:child_process";
import fs from "node:fs";

const TITLE = "claude-terminal-KV";
const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

let list;
try {
  list = JSON.parse(run("npx wrangler kv namespace list"));
} catch (e) {
  console.error("Could not list KV namespaces:", e.message);
  process.exit(1);
}
let ns = list.find((n) => n.title === TITLE);
if (!ns) {
  console.log(`Creating KV namespace "${TITLE}"`);
  const out = run("npx wrangler kv namespace create KV");
  const m = out.match(/id\s*=\s*"([a-f0-9]{32})"/) || out.match(/"id"\s*:\s*"([a-f0-9]{32})"/);
  if (!m) {
    console.error("Could not read the new namespace id from:\n" + out);
    process.exit(1);
  }
  ns = { id: m[1], title: TITLE };
}
const toml = fs.readFileSync("wrangler.toml", "utf8");
const patched = toml.replace(/(\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*)"[^"]*"/, `$1"${ns.id}"`);
if (patched === toml) {
  console.error("Could not find the kv_namespaces id in wrangler.toml");
  process.exit(1);
}
fs.writeFileSync("wrangler.toml", patched);
console.log(`KV namespace "${TITLE}" = ${ns.id}`);
