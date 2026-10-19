# claude terminal

A private website for legal research and drafting with Claude, meant to be shared with one person. It opens with an access key, runs on free hosting, and updates itself every time this repository changes.

![deploy](https://github.com/hmohyud/claude_terminal/actions/workflows/deploy.yml/badge.svg)

## How it is put together

- **The page** is static and lives on **GitHub Pages**.
- **A small Cloudflare Worker** holds the Anthropic API key and the access key, talks to Claude, and keeps threads, files and settings in Cloudflare's KV storage. Nothing sensitive is ever in the page or in this repository.
- **GitHub Actions** deploys both on every push to `main`: the Worker with Wrangler, then the page.

Both Cloudflare Workers and GitHub Pages have free tiers that comfortably cover one person's daily use.

## Set it up once (about 15 minutes)

**1. A Cloudflare account** (free) at cloudflare.com. Then collect two values:

- *Account ID*: in the dashboard open **Workers & Pages**; the Account ID is in the right-hand column.
- *API token*: click your profile (top right) → **My Profile** → **API Tokens** → **Create Token** → use the **Edit Cloudflare Workers** template → **Continue to summary** → **Create Token**. Copy it now; it is shown once.
- If Cloudflare asks you to pick a `workers.dev` subdomain under Workers & Pages, pick any name.

**2. An access key.** Make up a long random key (20 or more characters; a password manager can generate one). This is what the lawyer types to unlock the site.

**3. Put the four secrets in GitHub.** Open this repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, one at a time:

| name | value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the API token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID from step 1 |
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `ACCESS_KEY` | the access key from step 2 |

**4. Turn on GitHub Pages.** Repository → **Settings** → **Pages** → under *Build and deployment*, set **Source** to **GitHub Actions**. (The deploy tries to do this for you; check it if the first run complains.)

**5. Deploy.** Push to `main`, or open the **Actions** tab, choose **deploy**, and click **Run workflow**. The first run takes two or three minutes and creates the KV storage by itself. When it is green, the site is at:

`https://<your-github-username>.github.io/claude_terminal/`

Send that link and the access key to the lawyer. Their browser stays signed in for 30 days after they enter the key.

### Changing the access key or the API key

Edit the secret in GitHub (same place as step 3), then run the **deploy** workflow again from the Actions tab. Changing the access key signs every browser out.

## How secure is this

- The access key and API key exist only as GitHub Actions secrets (encrypted, never shown again, masked in logs) and inside the Cloudflare Worker. They are not in the page, the repository, or anyone's browser.
- Entering the key gives the browser a signed, expiring sign-in token. The token does not contain the key, and changing the key invalidates every token.
- Guessing is throttled: ten attempts per minute per address, and after five wrong keys that address is locked out for growing periods up to an hour.
- Everything travels over HTTPS (GitHub Pages and Cloudflare both provide it).
- Anyone who can push to this repository can change what gets deployed and could read the secrets through a workflow, so keep the collaborator list to people you trust. Pull requests from forks never see the secrets.
- What the lawyer types and uploads is sent to Anthropic's API under your account and is subject to Anthropic's terms. Threads and files sit in your Cloudflare account.

## What it does

- **Made for legal work.** Claude is told to cite authority precisely, never invent citations, distinguish federal from state law, flag what may have changed since its training, and separate the rule from its application. Each thread has a jurisdiction. One-click tasks: summarize, issue-spot, IRAC memo, plain English, key dates, risky clauses, compare drafts, defined terms, draft a letter, check citations.
- **Color-coding.** Case names, reporter citations, statutes and rules, dates, deadlines, time periods, dollar amounts, defined terms, party roles and obligations are highlighted in answers and in document previews. Turn it off with the *Highlights* switch; the legend is in Settings.
- **Two modes, plain effort.** *Simple questions* uses Claude Opus 5.5 (quicker and cheaper); *Complex questions* uses Claude Fable 5.1, Anthropic's most capable model. The effort menu says whether replies will be fast or slow.
- **Documents in, documents out.** Drop in PDFs, Word files, images or text; preview any of them in place; download an answer as a Word document, print it, or save it to Files.
- **Everything is kept** in your Cloudflare account, so any browser with the key sees the same threads. Storage is first in, first out: the newest 200 threads and 300 files (up to 1 GB) are kept and the oldest are dropped. The caps are in `wrangler.toml`.
- **Costs are visible.** Every answer shows its cost; the usage panel shows today, this week, this month and all time, what is left of a monthly budget, and current rate limits.
- Type `/help` in the message box for keyboard commands.

## For developers

```bash
npm install
cp .dev.vars.example .dev.vars     # put a local access key and your API key in it
npm run dev                        # http://localhost:8787 with a local KV store
npm test                           # boots the Worker locally and checks the gate, storage and caps
```

Layout: `worker/index.js` is the Cloudflare Worker, `public/` is the page (also served by the Worker at its own URL), `wrangler.toml` configures the Worker, and `.github/workflows/deploy.yml` deploys both. `npm run vendor` refreshes the browser builds of the Word libraries in `public/vendor/`.
