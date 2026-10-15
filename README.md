# Bot Telegram para TEC Concursos

Bot em Node.js 20+ que usa o [tec-agent](https://github.com/warleysr/tec-agent) para obter cadernos e questões. As respostas e o progresso do quiz ficam no Telegram e não alteram o histórico de resolução do site TEC.

## Instalação na VPS

O instalador configura o serviço `systemd` e a rota HTTPS do callback no Apache. Ele pressupõe que a VPS já tenha Apache com certificado HTTPS para `blackgroup.com.br` e que esse domínio seja o usado pela extensão. O Apache precisa estar ativo e ter um `VirtualHost *:443` com `ServerName` ou `ServerAlias blackgroup.com.br`.

```bash
git clone https://github.com/warleysr/telegram-tec-agent-bot.git
cd telegram-tec-agent-bot
sudo bash install.sh
```

Na primeira instalação, informe o token do `@BotFather` e o ID Telegram do administrador. Em atualizações, o instalador preserva esses dados de `/etc/telegram-tec-bot.env`. Ele instala o `tec-agent`, configura o proxy Apache para `https://blackgroup.com.br/tec-login` e inicia o bot.

Confira a instalação:

```bash
sudo systemctl status telegram-tec-bot
sudo journalctl -u telegram-tec-bot -f
```

Requisitos: Ubuntu/Debian com Apache e certificado já configurados, `systemd`, Git, Python 3 e Node.js 20+. O instalador ativa os módulos `proxy` e `proxy_http` do Apache. Não precisa abrir outra porta pública; o bot escuta somente em `127.0.0.1:8088`.

## Extensão no Chrome ou Helium (Windows)

Instale a extensão no mesmo perfil do Chrome ou Helium em que você acessa o TEC:

1. Baixe ou clone este repositório no PC e extraia os arquivos.
2. Abra `chrome://extensions`, ative **Modo do desenvolvedor** e clique em **Carregar sem compactação**. No Helium, use a mesma página de extensões Chromium.
3. Selecione a pasta `extension` do repositório.
4. No Telegram, abra uma conversa privada com o bot e envie `/login`.
5. Clique no ícone da extensão **TEC Session Sync**. A tela de pareamento abrirá em uma aba; cole o código enviado pelo bot e clique em **Parear ou trocar conexão**.

O pareamento é feito uma vez por instalação da extensão. Depois, quando o TEC criar ou renovar os cookies de autenticação no Chrome, a extensão os envia automaticamente para a VPS por HTTPS. **Sincronizar agora** permite reenviar manualmente após fazer login. A extensão também mostra se o envio foi validado pelo TEC.

O bot testa a sessão antes de salvá-la. Se a sessão expirar ou for substituída, o bot avisa para entrar no TEC pelo Chrome e sincronizar novamente. `/login` só é necessário para parear a extensão ou pareá-la de novo. Os cookies e o token de pareamento trafegam via HTTPS; não os envie em mensagens.

## Comandos do bot

- `/lista` navega por pastas, subpastas e cadernos da conta TEC.
- `/caderno LINK` carrega um caderno pelo link.
- `/proxima` abre a próxima questão ainda não respondida por você naquele chat.
- `/aleatoria` escolhe uma questão não respondida aleatoriamente.
- `/status` mostra seu progresso no Telegram.
- `/login` gera o código de pareamento da extensão (administrador, em conversa privada).
- `/id` mostra seu ID Telegram.

Cada questão chega como quiz do Telegram, com indicação de acerto ou erro, botão **Ver comentário** e botões **Próxima** e **Aleatória**. Em grupos, várias pessoas podem responder; o progresso é individual por usuário e chat.

Exemplos:

```text
/caderno https://www.tecconcursos.com.br/questoes/cadernos/12345678
/proxima
/aleatoria
/status
```

## Atualizar

Na VPS, execute novamente o instalador para atualizar o bot, a extensão implantada no PC e o proxy. As credenciais são preservadas:

```bash
cd /var/www/html/telegram-tec-agent-bot
git pull
sudo bash install.sh
```

Depois de atualizar, carregue novamente a pasta `extension` em `chrome://extensions` (botão **Recarregar**) para aplicar a nova versão no Chrome.

## Dados e limites

- Configuração e token Telegram: `/etc/telegram-tec-bot.env` (permissão `0600`).
- Sessão TEC e progresso: `/var/lib/telegram-tec-bot/`.
- Estado do pareamento: `/var/lib/telegram-tec-bot/bot-state.json` (token da extensão armazenado como hash).
- Logs: `journalctl -u telegram-tec-bot`.
- O navegador e o bot compartilham cookies de sessão; a extensão não cria uma segunda sessão TEC. Como o TEC pode invalidar sessões ou renovar cookies no servidor, sincronize de novo se o bot avisar que a sessão ficou inválida.
- O domínio configurado na extensão é `blackgroup.com.br`. Em outro domínio, ajuste `API_BASE` em `extension/background.js` e `extension/popup.js`, o `host_permissions` em `extension/manifest.json` e `PUBLIC_DOMAIN` no `install.sh`.
- O caderno precisa estar acessível à conta autenticada e conter um ID numérico em `/questoes/cadernos/ID`.
- Questões sem gabarito fornecido pelo TEC são ignoradas pelo bot.

Faça backup de `/var/lib/telegram-tec-bot/` para preservar sessão e progresso. Não publique esses dados.
