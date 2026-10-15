const fs = require('fs');
const path = require('path');

// Carrega variáveis de ambiente de /etc/telegram-tec-bot.env ou .env local se existirem
const envFile = process.env.ENV_FILE || '/etc/telegram-tec-bot.env';
const loadedEnv = {};
if (fs.existsSync(envFile)) {
  try {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        loadedEnv[key] = val;
      }
    }
  } catch (err) {
    console.error(`Erro ao carregar variáveis de ${envFile}:`, err.message);
  }
}

module.exports = {
  apps: [
    {
      name: 'telegram-tec-bot',
      script: path.join(__dirname, 'bot.mjs'),
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        ...loadedEnv,
      },
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
