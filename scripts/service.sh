#!/usr/bin/env bash
# Install Pasu as a systemd system service so it starts on boot.
#
# Run as the user whose processes Pasu should manage (not as root); it uses
# sudo for the steps that need it. Settings live in ~/.config/pasu/pasu.env.
#
#   pasu service install     create pasu.env (if missing), install and start the service
#   pasu service uninstall   stop and remove the service (managed processes keep running)
#   pasu service print       show the unit file that would be installed
#   pasu service status      systemctl status + recent log lines
#
# Seed pasu.env on first install by passing variables, e.g.:
#   PASU_NAME="Pasu prod-eu" PASU_PUBLIC_URL=https://ops.example.com PASU_TLS=off pasu service install
set -euo pipefail

SERVICE=${PASU_SERVICE:-pasu}
APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UNIT_FILE=/etc/systemd/system/$SERVICE.service
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/pasu
ENV_FILE=$CONFIG_DIR/pasu.env

die() { echo "error: $*" >&2; exit 1; }

# systemd EnvironmentFile value quoting.
quote() { local v=${1//\\/\\\\}; printf '"%s"' "${v//\"/\\\"}"; }

find_node() {
  local node
  node=$(command -v node) || die "node not found in PATH (with nvm, run 'nvm use' first)"
  readlink -f "$node"
}

write_env() {
  local name=${PASU_NAME:-"Pasu $(hostname -s)"}
  local tls=${PASU_TLS:-on}
  {
    echo "# Pasu settings, read by $UNIT_FILE."
    echo "# After editing:  sudo systemctl restart $SERVICE   (managed processes keep running)"
    echo
    echo "# Shown in the UI and as the issuer in your authenticator app. Set it before enrolling."
    echo "PASU_NAME=$(quote "$name")"
    echo
    echo "# The URL you open in the browser. Used for the setup link, cookie path and origin checks,"
    echo "# and its hostname becomes the account name in the authenticator app."
    if [[ -n ${PASU_PUBLIC_URL:-} ]]; then echo "PASU_PUBLIC_URL=$(quote "$PASU_PUBLIC_URL")"; else echo "#PASU_PUBLIC_URL=https://pasu.example.com"; fi
    echo
    echo "# Behind nginx: TLS off (nginx terminates it), listening on loopback only."
    echo "# Standalone: TLS on, with your certificate or a generated self-signed one."
    echo "PASU_TLS=$tls"
    if [[ -n ${PASU_HOST:-} ]]; then echo "PASU_HOST=$(quote "$PASU_HOST")"; else echo "#PASU_HOST=$([[ $tls == off ]] && echo 127.0.0.1 || echo 0.0.0.0)"; fi
    echo "PASU_PORT=${PASU_PORT:-8443}"
    echo "#PASU_TLS_CERT=/etc/letsencrypt/live/example.com/fullchain.pem"
    echo "#PASU_TLS_KEY=/etc/letsencrypt/live/example.com/privkey.pem"
    echo
    echo "# Data directory (process definitions, logs, authenticator secret)."
    echo "PASU_DATA=$(quote "${PASU_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/pasu}")"
    echo
    echo "# PATH for managed processes, captured from your shell at install time."
    echo "# systemd's default PATH doesn't include nvm, ~/.local/bin, pyenv, etc."
    echo "PATH=$(quote "$PATH")"
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE"
}

render_unit() {
  local node; node=$(find_node)
  cat <<EOF
[Unit]
Description=Pasu process supervisor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart="$node" "$APP_DIR/src/server.js"
Restart=always
RestartSec=3
# Managed processes are started inside this service's cgroup. KillMode=process
# makes stopping/restarting Pasu leave them running; it re-adopts them on start.
# Without this, every managed process would be killed with Pasu.
KillMode=process
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

install_service() {
  [[ $EUID -ne 0 ]] || die "run as your normal user, not root (sudo is used where needed)"
  # A git checkout needs its dependencies installed; an npm install already has them.
  if [[ -f $APP_DIR/package-lock.json && ! -d $APP_DIR/node_modules ]]; then (cd "$APP_DIR" && npm install --omit=dev); fi
  # Same check as the server's: don't let the service start fresh next to the old data.
  "$(find_node)" "$APP_DIR/src/server.js" preflight
  if [[ ! -f $ENV_FILE ]]; then mkdir -p -m 700 "$CONFIG_DIR"; write_env; fi

  local tmp; tmp=$(mktemp)
  render_unit >"$tmp"
  sudo install -m 0644 -o root -g root "$tmp" "$UNIT_FILE"
  rm -f "$tmp"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE"
  sudo systemctl restart "$SERVICE"
  echo
  echo "Installed and started $SERVICE (enabled at boot)."
  echo "  Settings:  $ENV_FILE"
  echo "  Logs:      journalctl -u $SERVICE -f"
  sleep 1
  if sudo journalctl -u "$SERVICE" -n 30 --no-pager -o cat | grep -q 'First-time setup'; then
    echo
    sudo journalctl -u "$SERVICE" -n 30 --no-pager -o cat | grep -A2 'First-time setup' | tail -1 | sed 's/^ */Setup link: /'
  fi
}

uninstall_service() {
  sudo systemctl disable --now "$SERVICE" 2>/dev/null || true
  sudo rm -f "$UNIT_FILE"
  sudo systemctl daemon-reload
  echo "Removed $SERVICE. Managed processes were left running; $ENV_FILE and the data directory were kept."
}

case ${1:-} in
  install) install_service ;;
  uninstall) uninstall_service ;;
  print) render_unit ;;
  status) systemctl status "$SERVICE" --no-pager || true; echo; sudo journalctl -u "$SERVICE" -n 20 --no-pager -o cat ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
