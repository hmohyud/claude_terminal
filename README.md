# claude terminal

Chat with Claude in your browser using your own API key. One password protects it, and your browser stays signed in for 30 days.

![terminal](https://img.shields.io/badge/node-22%2B-brightgreen) ![deploy](https://github.com/hmohyud/claude_terminal/actions/workflows/deploy.yml/badge.svg)

## Run it on your computer

1. Install [Node.js](https://nodejs.org) (22 or newer), then in this folder run `npm install`.
2. Copy `.env.example` to `.env`. Paste your API key after `ANTHROPIC_API_KEY=` and pick a password after `TERMINAL_PASSWORD=`.
3. Run `npm start` and open http://127.0.0.1:3123.

That's it. To change the password later, edit `.env` and restart; everyone gets signed out.

## What it does

- **Chat** with streaming replies, formatted text and code. Pick any model your key can use, and how hard it should think.
- **Files**: drop, paste or attach images, PDFs, Word documents (.docx) and text or code files. Click any file to preview it in place. Download anything Claude writes: a code block, a reply, or the whole chat.
- **Usage**: every reply shows its cost. The `usage` button shows today, this week, this month and all time, what's left of a monthly budget you set, and your current rate limits.
- Type `/help` in the chat box for the full list of commands (switch model, set a system prompt, export, budget, and so on).

## Put it on a server so it updates itself

Every push to `main` on GitHub tests the code, builds it, and deploys it to your server. You need a Linux server you can SSH into (a cheap VPS, a home server, a Raspberry Pi all work).

**Step 1, on the server.** Log in as the user that should run the app and run:

```bash
curl -fsSL https://raw.githubusercontent.com/hmohyud/claude_terminal/main/deploy/server-setup.sh -o server-setup.sh && bash server-setup.sh
```

It installs Docker if needed, asks for your API key, a password, and optionally a domain name (which gets you automatic HTTPS). It then prints four values.

**Step 2, on GitHub.** Open the repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add the four values the script printed, one secret each:

| name | what it is |
|---|---|
| `DEPLOY_HOST` | the server's address |
| `DEPLOY_USER` | the user you ran the script as |
| `DEPLOY_PATH` | the folder on the server (normally `~/claude-terminal`) |
| `DEPLOY_SSH_KEY` | the private key block the script printed |

**Step 3.** Push to `main`, or open the **Actions** tab and run **deploy**. Watch it there; the first run takes a couple of minutes. From now on every push redeploys.

Where your secrets live: the API key and password are only in `.env` on the server; GitHub only holds the SSH details, and deploys never overwrite `.env`. Until the four secrets exist, pushes just run the checks.

Without a domain name the terminal is served over plain HTTP on port 3123, which is fine on a home network or over Tailscale but not for the open internet. Give the script a domain (any DNS name pointing at the server) and it serves HTTPS with a certificate that renews itself.

Prefer a hosted platform? Railway, Render and Fly.io can build the `Dockerfile` straight from this repo with their own auto-deploy. Set the variables from `.env.example` in their dashboard and mount a persistent disk at `/data`.

## Your data

Chats are stored in your browser. On the server, `data/` holds uploaded files, the usage history, your budget, and the login secret (in Docker that is the `claude-terminal-data` volume). Costs are estimates from token counts at list prices; the official number is on console.anthropic.com.

## How the password protection works

The login cookie never contains the password. It holds a signed, expiring token, and the signature depends on both the password and a secret, so changing either signs everyone out. The cookie cannot be read by page scripts or sent by other sites, five wrong guesses in a row lock that address out with growing delays, and the API key never leaves the server.

## For developers

`npm run dev` restarts on changes. `npm test` runs a smoke test of the password gate. `docker compose up -d --build` runs it in Docker locally. The deploy workflow is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) and the server script is [`deploy/server-setup.sh`](deploy/server-setup.sh). All settings are listed in [`.env.example`](.env.example).
