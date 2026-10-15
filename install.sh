#!/usr/bin/env bash
set -Eeuo pipefail

APP=telegram-tec-bot
SERVICE_USER=telegram-tec-bot
APP_DIR=/opt/telegram-tec-bot
TEC_DIR=/opt/tec-agent
DATA_DIR=/var/lib/telegram-tec-bot
ENV_FILE=/etc/telegram-tec-bot.env
REPO_URL=https://github.com/warleysr/telegram-tec-agent-bot.git
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
if ! command -v apt-get >/dev/null; then
  echo "O login pelo navegador remoto requer uma VPS Debian/Ubuntu com apt-get." >&2
  echo "Instale manualmente Chromium, Xvfb, x11vnc e websockify antes de continuar." >&2
  exit 1
fi
apt_update() {
  local output status=0 other_errors
  output="$(apt-get update 2>&1)" || status=$?
  printf '%s\n' "$output"
  if [[ $status -eq 0 ]]; then return 0; fi

  # Instalações antigas do cloudflared ainda usam pkg.cloudflare.com/debian,
  # que retorna 404. Não deixe essa fonte alheia ao bot bloquear seus pacotes.
  if grep -Fq "https://pkg.cloudflare.com/debian stable Release" <<< "$output"; then
    other_errors="$(grep -E '^(Err:|E: )' <<< "$output" | grep -vF "https://pkg.cloudflare.com/debian stable Release" || true)"
    if [[ -z "$other_errors" ]]; then
      echo "Aviso: a fonte antiga do Cloudflare falhou, mas as demais fontes APT foram atualizadas." >&2
      return 0
    fi
  fi
  return "$status"
}
apt_update
apt-get install -y xvfb x11vnc novnc python3-websockify
if [[ "$(dpkg --print-architecture)" == "amd64" ]]; then
  if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
    apt-get install -y ca-certificates curl gnupg
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
    chmod 0644 /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt_update
    apt-get install -y google-chrome-stable
  fi
else
  if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then apt-get install -y chromium; fi
fi
NODE_BIN="$(command -v node)"

read -r -s -p "Token do bot (BotFather): " TELEGRAM_BOT_TOKEN
printf '\n'
if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then echo "Token vazio." >&2; exit 1; fi
read -r -p "ID Telegram do administrador (consulte @userinfobot): " BOT_ADMIN_IDS
if [[ ! "$BOT_ADMIN_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then echo "Informe um ou mais IDs numéricos separados por vírgula." >&2; exit 1; fi
read -r -p "URL HTTPS pública para o login TEC (ex.: https://bot.seudominio.com/tec-login): " BOT_LOGIN_BASE_URL
printf '\n'
if [[ ! "$BOT_LOGIN_BASE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/tec-login/?$ ]]; then echo "Use uma URL HTTPS pública terminada em /tec-login." >&2; exit 1; fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/tec"
install -m 0644 "$SCRIPT_DIR/bot.mjs" "$APP_DIR/bot.mjs"
install -m 0644 "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$SCRIPT_DIR/README.md" "$APP_DIR/README.md"

if [[ ! -d "$TEC_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/warleysr/tec-agent.git "$TEC_DIR"
fi
chmod -R a+rX "$TEC_DIR"

umask 077
printf 'TELEGRAM_BOT_TOKEN=%s\nBOT_ADMIN_IDS=%s\nBOT_LOGIN_BASE_URL=%s\nBOT_LOGIN_PORT=8088\nTEC_AGENT_ROOT=%s\nTEC_AGENT_DIR=%s\nBOT_DATA_DIR=%s\n' \
  "$TELEGRAM_BOT_TOKEN" "$BOT_ADMIN_IDS" "$BOT_LOGIN_BASE_URL" "$TEC_DIR" "$DATA_DIR/tec" "$DATA_DIR" > "$ENV_FILE"
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
systemctl enable --now "${APP}.service"
echo
echo "Instalação concluída. Acompanhe com: journalctl -u ${APP} -f"
echo "Configure o proxy HTTPS para /tec-login -> 127.0.0.1:8088 e /tec-vnc/* -> 127.0.0.1:6080 (WebSocket)."
echo "Depois envie /login ao bot no privado para conectar a sessão TEC pelo navegador do celular."
