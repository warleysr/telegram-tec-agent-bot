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

O instalador copia o executável Node para a pasta do serviço (inclusive quando o Node veio do NVM em `/root`) e configura o `systemd`. Depois da instalação, envie `/login` ao bot no privado para atualizar a sessão.

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
- `/login` inicia uma atualização temporária da sessão. Entre no TEC normalmente, execute o favorito **Copiar cookies TEC**, e cole a mensagem na conversa privada com o bot. O bot tenta apagar a mensagem e valida a sessão com `whoami()` antes de salvá-la.
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

### Criar o favorito para copiar cookies

1. Copie a linha de [tec-cookies-bookmarklet.txt](tec-cookies-bookmarklet.txt).
2. Crie um favorito chamado **Copiar cookies TEC** e cole a linha inteira no campo de endereço/URL do favorito.
3. Faça login normalmente no TEC. Na página do TEC, execute esse favorito; os cookies acessíveis serão copiados para a área de transferência. Se o navegador bloquear a cópia, o favorito abre uma caixa para copiar manualmente.
4. No Telegram, envie `/login` ao bot no privado e cole o conteúdo copiado.

O progresso das questões do TEC não é alterado. **Limitação do navegador:** bookmarklets não conseguem ler cookies `HttpOnly`. Se o cookie necessário estiver marcado assim, o TEC não fornecerá uma sessão válida pelo favorito e o bot recusará o conteúdo; o favorito não contorna essa proteção. O bot não salva cookies sem validar a sessão.

O bot usa long polling, sem necessidade de abrir uma porta ou configurar webhook. Os comandos funcionam em grupos com o modo privacy padrão do Telegram.

## Atualizar o bot

Na VPS, obtenha a versão nova e reinicie o serviço:

```bash
cd telegram-tec-agent-bot
git pull
sudo install -m 0644 bot.mjs package.json README.md /opt/telegram-tec-bot/
sudo install -m 0644 tec-cookies-bookmarklet.txt /opt/telegram-tec-bot/
sudo install -m 0755 "$(command -v node)" /opt/telegram-tec-bot/node
sudo sed -i 's#^ExecStart=.*#ExecStart=/opt/telegram-tec-bot/node /opt/telegram-tec-bot/bot.mjs#' /etc/systemd/system/telegram-tec-bot.service
sudo systemctl daemon-reload
sudo systemctl restart telegram-tec-bot
```

Para instalações anteriores com o login remoto, esta versão não usa mais a rota `/tec-login` nem o proxy WebSocket. O serviço pode ser reiniciado sem Chromium, Xvfb ou VNC.

## Dados e credenciais

- Token: `/etc/telegram-tec-bot.env` (permissão `0600`).
- Sessão TEC e progresso: `/var/lib/telegram-tec-bot/`.
- Logs: `journalctl -u telegram-tec-bot`.

Faça backup de `/var/lib/telegram-tec-bot/` para preservar a sessão e os históricos. Não publique esses dados.

## Limitações

- O link precisa ser direto e conter um ID numérico (`/questoes/cadernos/ID`). Links curtos `/s/...` e `/caderno/...` ainda não são resolvidos.
- Um bookmarklet só pode copiar cookies que o navegador expõe a JavaScript; cookies `HttpOnly` não podem ser lidos por esse método.
- A sessão do tec-agent precisa ter acesso ao caderno e a listagem deve informar a quantidade de questões.
- Se o tec-agent não identificar o gabarito, o bot interrompe o envio daquela questão para evitar uma correção errada.
