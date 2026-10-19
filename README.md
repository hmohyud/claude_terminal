# claude terminal

A small, password-gated web terminal for talking to Claude with your own Anthropic API key. Runs locally with Node, no build step.

- Streams replies, renders markdown and highlighted code, shows Claude's thinking summary.
- Every model your key can see, with per-model effort control and refusal fallback.
- Usage tracking: cost per reply, per chat, today / week / month / all time, a monthly budget with **remaining** readout, and the live rate limits from the last response.
- Files: drop, paste, or attach images, PDFs, and text/code files; download anything Claude writes (code blocks, replies, whole chats); a files panel to re-attach, download, or delete.
- Chats are saved in the browser (localStorage); uploads and the usage ledger are saved on disk in `data/`.

## Setup

```bash
npm install
```

Create `.env` (copy `.env.example`) and fill in:

| key | what |
|---|---|
| `ANTHROPIC_API_KEY` | your API key |
| `TERMINAL_PASSWORD` | the password that gates the terminal (8+ characters) |
| `SESSION_SECRET` | leave blank; generated and saved on first start |
| `SESSION_DAYS` | how long a login lasts (default 30) |
| `HOST` / `PORT` | `127.0.0.1:3123` by default |
| `COOKIE_SECURE` | set to `1` when behind HTTPS |
| `MONTHLY_BUDGET_USD` | optional starting budget; you can also set it in the usage panel |

## Run

```bash
npm start
```

Open http://127.0.0.1:3123, enter the password, and you're in. `npm run dev` restarts on file changes.

## Using it

Type to chat. Enter sends, Shift+Enter adds a line, Esc stops a reply, ↑/↓ recall earlier messages. Drop files anywhere or paste an image.

Slash commands (`/help` lists them):

| command | does |
|---|---|
| `/new`, `/clear`, `/delete`, `/title <text>` | manage the current chat |
| `/model [name]`, `/models` | switch model (prefix match, e.g. `/model sonnet`), list models and prices |
| `/system [text\|clear]` | per-chat system prompt |
| `/effort low\|medium\|high\|xhigh\|max\|default` | reasoning effort |
| `/thinking on\|off` | show the thinking summary |
| `/max <n>` | max output tokens (default 16000) |
| `/fallback on\|off` | server-side fallback to another model if a reply is refused by safety classifiers |
| `/retry`, `/undo` | regenerate the last reply, drop the last exchange |
| `/export [md\|json]` | download the chat |
| `/files`, `/usage`, `/context` | files panel, usage panel, token count of the current context |
| `/budget <usd\|off>` | monthly budget for the remaining readout |
| `/logout` | sign this browser out |

Each reply has **copy / download / save to files / retry**; each code block has **copy / download**. Hover a message to see the buttons.

## How the password gate works

- The cookie never holds the password. It holds an expiry and a nonce signed with an HMAC derived from `SESSION_SECRET` **and** the password. Changing either in `.env` logs every browser out.
- The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when `COOKIE_SECURE=1`. Every API write also needs a custom header, so cross-site forms cannot drive it.
- Logins get 5 free tries per IP, then an exponential lockout (1 min, 2, 4 ... up to an hour), and every attempt is delayed a little.
- The API key stays on the server; the browser never sees it.

To use it from your phone or another machine on your network, set `HOST=0.0.0.0` and open `http://<this-machine's-ip>:3123`. If you expose it beyond your LAN, put it behind HTTPS (Caddy, Tailscale, a reverse proxy) and set `COOKIE_SECURE=1` and, behind a proxy, `TRUST_PROXY=1`.

## Data on disk

| path | holds |
|---|---|
| `data/usage.jsonl` | one line per request: model, tokens, estimated cost, duration |
| `data/uploads/` + `data/files.json` | uploaded files and their index |
| `data/settings.json` | the monthly budget |

Costs are estimates from token counts times list prices, counted by this terminal only. The authoritative number is the usage page on console.anthropic.com. `.env` and `data/` are git-ignored.
