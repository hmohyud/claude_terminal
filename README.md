# claude terminal

A private workspace for US legal research and drafting with Claude, running on your own Anthropic API key. One password protects it; a browser that knows the password stays signed in for 30 days.

![node](https://img.shields.io/badge/node-22%2B-brightgreen) ![deploy](https://github.com/hmohyud/claude_terminal/actions/workflows/deploy.yml/badge.svg)

## What it does

- **Built for legal work.** Claude is instructed to cite authority precisely, never invent citations, distinguish federal from state law, flag what may have changed since its training, and separate the rule from its application. Pick a jurisdiction per thread. One-click tasks: summarize, issue-spot, IRAC memo, plain English, key dates, risky clauses, compare drafts, defined terms, draft a letter, check citations.
- **Documents in, documents out.** Drop in PDFs, Word files, images or text. Preview any of them in place. Download an answer as a Word document, print it, or save it to your files.
- **Everything is kept.** Threads, files, settings and sign-in all persist on the machine running the terminal, so any browser with the password sees the same history. Storage is first in, first out: the newest 200 threads and 300 files (up to 1 GB) are kept, and the oldest are dropped when those caps are reached. You can change the caps in `.env`.
- **Know what it costs.** Every answer shows its cost. The usage panel shows today, this week, this month and all time, what's left of a monthly budget you set, and your current rate limits.
- Type `/help` in the message box for the keyboard commands.

## Run it on your computer

1. Install [Node.js](https://nodejs.org) (22 or newer) and run `npm install` in this folder.
2. Copy `.env.example` to `.env`. Paste your API key after `ANTHROPIC_API_KEY=` and choose a password after `TERMINAL_PASSWORD=`.
3. Run `npm start` and open http://127.0.0.1:3123.

To change the password later, edit `.env` and restart. Everyone is signed out when it changes.

## Put it on a server so it deploys itself

Every push to `main` on GitHub tests and builds the code and deploys it to your server. You need a Linux server you can SSH into (a small VPS, a home server or a Raspberry Pi all work) and this repository under your GitHub account.

**Step 1, on the server.** Log in as the user that should run the app and run:

```bash
curl -fsSL https://raw.githubusercontent.com/hmohyud/claude_terminal/main/deploy/server-setup.sh -o server-setup.sh && bash server-setup.sh
```

It installs Docker if needed, creates an SSH deploy key, and prints the values for the next step. It also asks for your API key and password; you can type them there or press Enter to skip and keep them in GitHub instead.

**Step 2, on GitHub.** Open the repository, then **Settings → Secrets and variables → Actions → New repository secret**. Add one secret per row:

| secret | value |
|---|---|
| `DEPLOY_HOST` | the server's address (printed by the script) |
| `DEPLOY_USER` | the user you ran the script as |
| `DEPLOY_PATH` | the folder on the server, normally `~/claude-terminal` |
| `DEPLOY_SSH_KEY` | the private key block the script printed, BEGIN and END lines included |

If you skipped the key and password on the server, also add:

| secret | value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `TERMINAL_PASSWORD` | the password that unlocks the terminal (8 or more characters) |
| `DOMAIN` | optional: a domain name pointing at the server. Gives you automatic HTTPS |

**Step 3.** Push to `main`, or open the **Actions** tab and run **deploy**. The first run takes a couple of minutes; after that every push redeploys. Until the `DEPLOY_HOST` secret exists, pushes only run the checks.

### Where the password lives, and how safe that is

The password is never in the code or in the repository. It lives in one of two places, your choice:

- **In `.env` on the server** (the script writes it, readable only by your user). GitHub never sees it.
- **In GitHub Actions secrets**, if you add `TERMINAL_PASSWORD` there. GitHub stores secrets encrypted, never shows them again, and masks them in logs; each deploy writes them into `.env` on the server. Anyone who can push to this repository could write a workflow that reads them, so keep the repository's collaborator list to people you trust. Pull requests from forks never get secrets.

Either way, the same protections apply once it is running:

- The login cookie never contains the password. It is a signed, expiring token; the signature depends on the password and a server secret, so changing the password signs every browser out.
- The cookie cannot be read by page scripts and is never sent by other sites. Every write also needs a header that other sites cannot add.
- Five wrong guesses in a row lock that address out with delays that double each time, up to an hour, and every attempt is slowed slightly.
- The API key stays on the server; browsers never receive it.
- Without a domain the terminal is served over plain HTTP, which is fine on a home network or over Tailscale but not on the open internet. Give it a domain and it serves HTTPS with a certificate that renews itself.

Prefer a hosted platform? Railway, Render and Fly.io can build the `Dockerfile` straight from this repository with their own auto-deploy. Set the variables from `.env.example` in their dashboard and mount a persistent disk at `/data`.

## Your data

Everything lives in `data/` next to the app (in Docker, the `claude-terminal-data` volume): threads, uploaded files, the usage history, your settings and budget, and the login secret. Messages you send go to Anthropic's API under your account and are subject to its terms. Costs shown are estimates from token counts at list prices; the official figure is on console.anthropic.com.

## For developers

`npm run dev` restarts on changes. `npm test` runs a smoke test of the password gate, thread storage, settings and Word export. `docker compose up -d --build` runs it in Docker locally. The deploy workflow is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), the server script is [`deploy/server-setup.sh`](deploy/server-setup.sh), and every setting is listed in [`.env.example`](.env.example).
