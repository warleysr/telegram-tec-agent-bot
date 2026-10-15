#!/usr/bin/env bash
set -Eeuo pipefail

APP=telegram-tec-bot
SERVICE_USER=telegram-tec-bot
APP_DIR=/opt/telegram-tec-bot
TEC_DIR=/opt/tec-agent
DATA_DIR=/var/lib/telegram-tec-bot
ENV_FILE=/etc/telegram-tec-bot.env
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ ${EUID} -ne 0 ]]; then
  echo "Execute como root: sudo bash install.sh" >&2
  exit 1
fi
if [[ ! -f "$SCRIPT_DIR/bot.mjs" ]]; then
  echo "bot.mjs não encontrado junto com install.sh." >&2
  exit 1
fi
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20 ou superior é necessário. Instale-o antes de continuar." >&2
  exit 1
fi
if ! command -v git >/dev/null; then
  echo "Git é necessário para obter o tec-agent. Instale-o antes de continuar." >&2
  exit 1
fi
NODE_SOURCE="$(command -v node)"
NODE_BIN=/opt/telegram-tec-bot/node

read -r -s -p "Token do bot (BotFather): " TELEGRAM_BOT_TOKEN
printf '\n'
if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then echo "Token vazio." >&2; exit 1; fi
read -r -p "ID Telegram do administrador (consulte @userinfobot): " BOT_ADMIN_IDS
if [[ ! "$BOT_ADMIN_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then echo "Informe um ou mais IDs numéricos separados por vírgula." >&2; exit 1; fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/tec"
install -m 0755 "$NODE_SOURCE" "$NODE_BIN"
install -m 0644 "$SCRIPT_DIR/bot.mjs" "$APP_DIR/bot.mjs"
install -m 0644 "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$SCRIPT_DIR/package-lock.json" "$APP_DIR/package-lock.json"
install -m 0644 "$SCRIPT_DIR/README.md" "$APP_DIR/README.md"
install -m 0644 "$SCRIPT_DIR/tec-cookies-bookmarklet.txt" "$APP_DIR/tec-cookies-bookmarklet.txt"

if [[ ! -d "$TEC_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/warleysr/tec-agent.git "$TEC_DIR"
fi
chmod -R a+rX "$TEC_DIR"

umask 077
printf 'TELEGRAM_BOT_TOKEN=%s\nBOT_ADMIN_IDS=%s\nTEC_AGENT_ROOT=%s\nTEC_AGENT_DIR=%s\nBOT_DATA_DIR=%s\n' \
  "$TELEGRAM_BOT_TOKEN" "$BOT_ADMIN_IDS" "$TEC_DIR" "$DATA_DIR/tec" "$DATA_DIR" > "$ENV_FILE"
unset TELEGRAM_BOT_TOKEN
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

cat > "/etc/systemd/system/${APP}.service" <<EOF
[Unit]
Description=Bot de questões TEC no Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/bot.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP}.service"
if systemctl is-active --quiet "${APP}.service"; then systemctl restart "${APP}.service"; else systemctl start "${APP}.service"; fi
echo
echo "Instalação concluída. Acompanhe com: journalctl -u ${APP} -f"
