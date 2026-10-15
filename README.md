# Bot Telegram para TEC Concursos

Bot em Node.js 20+ que reutiliza `TecClient` e `TecApi` do [tec-agent](https://github.com/warleysr/tec-agent). O histórico de respostas fica local no bot e não altera o progresso no site TEC.

## Instalação automática na VPS

Compatível com VPS Linux que use `systemd`. Requer Node.js 20+, Git e acesso de saída à internet. O instalador cria um usuário de serviço sem login, instala o projeto em `/opt`, configura o `systemd` e mantém token, sessão e progresso em diretórios restritos.

```bash
git clone https://github.com/warleysr/telegram-tec-agent-bot.git
cd telegram-tec-agent-bot
sudo bash install.sh
```

O script pedirá:

1. O token criado no `@BotFather` (entrada oculta).
2. Seu ID Telegram administrativo (consulte `@userinfobot`; também há o comando `/id` depois da instalação).
3. A URL HTTPS pública que será usada no login, terminada em `/tec-login` (por exemplo, `https://bot.seudominio.com/tec-login`).

O instalador copia o executável Node para a pasta do serviço (inclusive quando o Node veio do NVM em `/root`), instala Chromium e Xvfb e prepara as dependências do bot. O login usa Chromium com a página real do TEC, transmitida ao celular por screencast; não depende de VNC nem reescreve o conteúdo do site, então o login e eventual reCAPTCHA são feitos no domínio oficial do TEC. Também configura o proxy HTTPS automaticamente. No Nginx, cria um host virtual e solicita o certificado; no Apache, adiciona a rota ao virtual host HTTPS existente e reutiliza o certificado instalado. Se nenhum deles estiver ativo, instala e configura o Caddy, que emite o certificado automaticamente. Para emissão automática, o DNS do domínio deve apontar para a VPS e as portas 80 e 443 precisam estar acessíveis. Depois, envie `/login` ao bot no privado.

Depois, acompanhe o serviço com:

```bash
sudo systemctl status telegram-tec-bot
sudo journalctl -u telegram-tec-bot -f
```

O instalador não instala Node.js nem Git. Instale Node.js 20 ou superior e Git antes de executá-lo. Em distribuições Debian/Ubuntu, `apt install git` instala o Git; confira a versão do Node com `node --version`.

## Comandos do bot

- `/caderno LINK` carrega um caderno acessível pela sessão TEC.
- `/proxima` abre a primeira questão ainda não respondida por você no chat.
- `/aleatoria` escolhe entre suas questões não respondidas.
- `/status` mostra seu progresso.
- `/lista` abre a navegação por pastas, subpastas e cadernos, com botões de seleção.
- `/login` envia ao administrador um link HTTPS temporário e de uso único. Abra-o no celular e entre no TEC na página transmitida; o bot captura os cookies HttpOnly pelo Chromium e valida a sessão com `whoami()` antes de salvá-la. O token fica no fragmento da URL, não vai ao servidor web nem aos logs. O bot não pede senha nem cookie no Telegram.
- `/id` mostra seu ID Telegram para configurar permissões administrativas.

Cada questão chega como quiz do Telegram, que indica acerto ou erro e oferece o botão **Ver comentário**. A descrição da prova aparece em negrito antes do enunciado; os botões **Próxima** e **Aleatória** ficam logo abaixo do quiz. Em grupos, o progresso é separado por usuário e chat. Respostas no Telegram não são sincronizadas com o TEC.

Exemplo:

```
/caderno https://www.tecconcursos.com.br/questoes/cadernos/12345678
/proxima
/aleatoria
/status
/lista
```

O login do TEC aceita uma sessão ativa por vez. Se a sessão expirar, envie `/login` ao bot no privado. A página de login transmite o navegador da VPS e atualiza a sessão armazenada pelo bot após o TEC confirmar a autenticação. O progresso de questões do TEC não é alterado.

O bot usa long polling, sem necessidade de abrir uma porta ou configurar webhook. Os comandos funcionam em grupos com o modo privacy padrão do Telegram. O proxy precisa encaminhar `/tec-login/ws` como WebSocket ao serviço local em `127.0.0.1:8088`.

## Atualizar o bot

Na VPS, obtenha a versão nova e reinicie o serviço:

```bash
cd telegram-tec-agent-bot
git pull
sudo install -m 0644 bot.mjs package.json package-lock.json /opt/telegram-tec-bot/
sudo npm --prefix /opt/telegram-tec-bot ci --omit=dev --no-audit --no-fund
sudo systemctl restart telegram-tec-bot
```

Para uma instalação anterior, atualize `BOT_ADMIN_IDS` e `BOT_LOGIN_BASE_URL` em `/etc/telegram-tec-bot.env`, instale Chromium, Xvfb e xauth e configure o proxy HTTPS. Reinicie o serviço depois. A nova versão remove VNC e exige proxy WebSocket em `/tec-login/ws`.

## Dados e credenciais

- Token: `/etc/telegram-tec-bot.env` (permissão `0600`).
- Sessão TEC e progresso: `/var/lib/telegram-tec-bot/`.
- Logs: `journalctl -u telegram-tec-bot`.

Faça backup de `/var/lib/telegram-tec-bot/` para preservar a sessão e os históricos. Não publique esses dados.

## Limitações

- O link precisa ser direto e conter um ID numérico (`/questoes/cadernos/ID`). Links curtos `/s/...` e `/caderno/...` ainda não são resolvidos.
- O login remoto requer VPS Debian/Ubuntu e domínio HTTPS com proxy WebSocket para `/tec-login/ws`.
- A sessão do tec-agent precisa ter acesso ao caderno e a listagem deve informar a quantidade de questões.
- Se o tec-agent não identificar o gabarito, o bot interrompe o envio daquela questão para evitar uma correção errada.
