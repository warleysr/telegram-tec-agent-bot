#!/usr/bin/env bash
set -Eeuo pipefail

APP=telegram-tec-bot
SERVICE_USER=telegram-tec-bot
APP_DIR=/opt/telegram-tec-bot
TEC_DIR=/opt/tec-agent
DATA_DIR=/var/lib/telegram-tec-bot
ENV_FILE=/etc/telegram-tec-bot.env
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DOMAIN=blackgroup.com.br

if [[ ${EUID} -ne 0 ]]; then echo "Execute como root: sudo bash install.sh" >&2; exit 1; fi
if [[ ! -f "$SCRIPT_DIR/bot.mjs" || ! -d "$SCRIPT_DIR/extension" ]]; then echo "bot.mjs ou extensão ausente junto com install.sh." >&2; exit 1; fi
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20 ou superior é necessário. Instale-o antes de continuar." >&2; exit 1
fi
if ! command -v npm >/dev/null; then echo "npm é necessário para instalar dependências e o PM2." >&2; exit 1; fi
if ! command -v git >/dev/null; then echo "Git é necessário para obter o tec-agent." >&2; exit 1; fi
if ! command -v python3 >/dev/null; then echo "Python 3 é necessário para configurar o proxy no Apache." >&2; exit 1; fi

# Reutiliza as credenciais durante atualizações, sem exibi-las nem solicitá-las novamente.
if [[ -f "$ENV_FILE" ]]; then set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
fi
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  read -r -s -p "Token do bot (BotFather): " TELEGRAM_BOT_TOKEN; printf '\n'
fi
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then echo "Token vazio." >&2; exit 1; fi
if [[ -z "${BOT_ADMIN_IDS:-}" ]]; then read -r -p "ID Telegram do administrador (consulte @userinfobot): " BOT_ADMIN_IDS; fi
if [[ ! "$BOT_ADMIN_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then echo "Informe um ou mais IDs numéricos separados por vírgula." >&2; exit 1; fi

NODE_SOURCE="$(command -v node)"
NODE_BIN="$APP_DIR/node"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"; fi
install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/extension" "$APP_DIR/logs"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/tec"
install -m 0755 "$NODE_SOURCE" "$NODE_BIN"
install -m 0644 "$SCRIPT_DIR/bot.mjs" "$SCRIPT_DIR/ecosystem.config.cjs" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$SCRIPT_DIR/README.md" "$APP_DIR/"
install -m 0644 "$SCRIPT_DIR"/extension/* "$APP_DIR/extension/"

if [[ ! -d "$TEC_DIR/.git" ]]; then git clone --depth 1 https://github.com/warleysr/tec-agent.git "$TEC_DIR"; fi
chmod -R a+rX "$TEC_DIR"

umask 077
printf 'TELEGRAM_BOT_TOKEN=%s\nBOT_ADMIN_IDS=%s\nTEC_AGENT_ROOT=%s\nTEC_AGENT_DIR=%s\nBOT_DATA_DIR=%s\nBOT_LOGIN_PORT=8088\n' \
  "$TELEGRAM_BOT_TOKEN" "$BOT_ADMIN_IDS" "$TEC_DIR" "$DATA_DIR/tec" "$DATA_DIR" > "$ENV_FILE"
unset TELEGRAM_BOT_TOKEN
chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"

# Configuração do proxy HTTPS no Apache para callback direto da extensão
bash "$SCRIPT_DIR/configure-apache.sh" "$PUBLIC_DOMAIN" 8088

# Instala PM2 globalmente se não existir
if ! command -v pm2 >/dev/null; then
  echo "Instalando PM2..."
  npm install -g pm2
fi

# Desativa serviço systemd legado se estiver ativo
if systemctl is-active --quiet "${APP}.service" 2>/dev/null; then
  echo "Desativando serviço systemd antigo..."
  systemctl stop "${APP}.service" || true
  systemctl disable "${APP}.service" || true
  rm -f "/etc/systemd/system/${APP}.service"
  systemctl daemon-reload
fi

# Permissões do diretório de dados e logs
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" "$APP_DIR/logs"

# Inicia ou recarrega o bot via PM2
echo "Iniciando bot com PM2..."
cd "$APP_DIR"
pm2 startOrReload "$APP_DIR/ecosystem.config.cjs"
pm2 save

echo
echo "Instalação concluída com sucesso!"
echo "Callback HTTPS de sincronização: https://${PUBLIC_DOMAIN}/tec-login/sync"
echo "Gerenciamento PM2:"
echo "  Acompanhar logs ao vivo: pm2 logs ${APP}"
echo "  Status do bot:          pm2 status"
echo "  Reiniciar bot:          pm2 restart ${APP}"
echo "  Parar bot:              pm2 stop ${APP}"
