#!/usr/bin/env bash
# One-time setup for a server that will run claude terminal and receive
# automatic deploys from GitHub Actions.
#
# On the server, logged in as the user that should own the app:
#   curl -fsSL https://raw.githubusercontent.com/hmohyud/claude_terminal/main/deploy/server-setup.sh -o server-setup.sh
#   bash server-setup.sh
#
# It installs Docker if needed, asks for your API key and password, writes the
# .env file, creates an SSH deploy key, and prints the values to paste into
# GitHub. Safe to run again: it keeps an existing .env and key.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/claude-terminal}"
KEYFILE="$HOME/.ssh/claude-terminal-deploy"

say() { printf '\n\033[1;32m%s\033[0m\n' "$*"; }

say "claude terminal · server setup"

# --- 1. docker ---------------------------------------------------------------
if command -v docker > /dev/null 2>&1; then
  echo "docker is installed"
else
  say "installing docker (official install script from get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  echo "added $USER to the docker group (takes effect after you log out and in again)"
fi

# --- 2. app folder + .env ----------------------------------------------------
mkdir -p "$APP_DIR"
FROM_GITHUB=0
if [ -f "$APP_DIR/.env" ]; then
  echo "keeping the existing $APP_DIR/.env"
else
  say "settings"
  echo "You can type your API key and password here, or press Enter to skip and"
  echo "add them as GitHub secrets instead (ANTHROPIC_API_KEY and TERMINAL_PASSWORD)."
  read -rp "Anthropic API key (Enter to skip): " API_KEY
  if [ -z "$API_KEY" ]; then
    FROM_GITHUB=1
    echo "ok: the deploy will write the settings from GitHub secrets."
  fi
fi
if [ "$FROM_GITHUB" = 0 ] && [ ! -f "$APP_DIR/.env" ]; then
  while :; do
    read -rsp "Password for the terminal (8+ characters): " PW; echo
    [ "${#PW}" -ge 8 ] && break
    echo "too short, try again"
  done
  read -rp "Domain name pointing at this server, for automatic HTTPS (leave blank for none): " DOMAIN
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  if [ -n "$DOMAIN" ]; then
    cat > "$APP_DIR/.env" <<EOF
ANTHROPIC_API_KEY=$API_KEY
TERMINAL_PASSWORD=$PW
SESSION_SECRET=$SECRET
SESSION_DAYS=30
PORT=3123
BIND_ADDR=127.0.0.1
DOMAIN=$DOMAIN
COMPOSE_PROFILES=https
COOKIE_SECURE=1
TRUST_PROXY=1
EOF
    URL="https://$DOMAIN"
  else
    cat > "$APP_DIR/.env" <<EOF
ANTHROPIC_API_KEY=$API_KEY
TERMINAL_PASSWORD=$PW
SESSION_SECRET=$SECRET
SESSION_DAYS=30
PORT=3123
BIND_ADDR=0.0.0.0
COOKIE_SECURE=0
EOF
    URL="http://<this server's address>:3123"
  fi
  chmod 600 "$APP_DIR/.env"
  echo "wrote $APP_DIR/.env (you can edit it later; deploys never overwrite it)"
fi

# --- 3. deploy key -----------------------------------------------------------
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$KEYFILE" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "claude-terminal-deploy" -f "$KEYFILE"
fi
touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
if ! grep -qF "$(cut -d' ' -f1,2 "$KEYFILE.pub")" "$HOME/.ssh/authorized_keys"; then
  cat "$KEYFILE.pub" >> "$HOME/.ssh/authorized_keys"
fi

# --- 4. what to paste into GitHub -------------------------------------------
HOST_ADDR="$(curl -fsS --max-time 5 https://api.ipify.org 2> /dev/null || hostname -I 2> /dev/null | awk '{print $1}' || hostname)"

say "done. now add the secrets in GitHub"
cat <<EOF
Open your repo on github.com → Settings → Secrets and variables → Actions
→ "New repository secret". Create one secret per line below:

  Name: DEPLOY_HOST      Value: $HOST_ADDR
  Name: DEPLOY_USER      Value: $USER
  Name: DEPLOY_PATH      Value: $APP_DIR
  Name: DEPLOY_SSH_KEY   Value: the whole block below, BEGIN and END lines included

EOF
cat "$KEYFILE"
if [ "$FROM_GITHUB" = 1 ]; then
  cat <<EOF

Because you skipped the API key, also add:

  Name: ANTHROPIC_API_KEY   Value: your Anthropic API key
  Name: TERMINAL_PASSWORD   Value: the password that unlocks the terminal (8+ characters)
  Name: DOMAIN              Value: optional, a domain pointing at this server (gives you HTTPS)
EOF
fi
cat <<EOF

Then push to main (or open the Actions tab and run "deploy"). After the first
deploy the terminal is at: ${URL:-http://$HOST_ADDR:3123, or https://your-domain if you set DOMAIN}
EOF
