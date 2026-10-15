# Bot Telegram para TEC Concursos

Bot em Node.js 20+, sem dependências npm, que reutiliza `TecClient` e `TecApi` do [tec-agent](https://github.com/warleysr/tec-agent). O histórico de respostas fica local no bot e não altera o progresso no site TEC.

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
3. O valor do header `Cookie` de uma sessão logada no TEC, sem o prefixo `Cookie:` (entrada oculta). A sessão é validada antes de iniciar o serviço.

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
- `/login` permite ao administrador atualizar os cookies TEC depois de fazer login novamente no navegador. Inicie o comando em conversa privada e envie o valor do header `Cookie` (sem `Cookie:`) na mensagem seguinte. O bot tenta apagar essa mensagem depois de recebê-la; se ela continuar visível, apague-a manualmente.
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

O login do TEC aceita uma sessão ativa por vez. Se autenticar no navegador e isso invalidar a sessão usada pelo bot, envie `/login` ao bot no privado e cole os cookies atuais. O bot valida a nova sessão antes de substituir a salva.

O bot usa long polling, sem necessidade de abrir uma porta ou configurar webhook. Os comandos funcionam em grupos com o modo privacy padrão do Telegram.

## Atualizar o bot

Na VPS, obtenha a versão nova e reinicie o serviço:

```bash
cd telegram-tec-agent-bot
git pull
sudo install -m 0644 bot.mjs /opt/telegram-tec-bot/bot.mjs
sudo systemctl restart telegram-tec-bot
```

Para uma instalação anterior, autorize o `/login` definindo `BOT_ADMIN_IDS` em `/etc/telegram-tec-bot.env` (um ou mais IDs numéricos separados por vírgula) e reinicie o serviço.

## Dados e credenciais

- Token: `/etc/telegram-tec-bot.env` (permissão `0600`).
- Sessão TEC e progresso: `/var/lib/telegram-tec-bot/`.
- Logs: `journalctl -u telegram-tec-bot`.

Faça backup de `/var/lib/telegram-tec-bot/` para preservar a sessão e os históricos. Não publique esses dados.

## Limitações

- O link precisa ser direto e conter um ID numérico (`/questoes/cadernos/ID`). Links curtos `/s/...` e `/caderno/...` ainda não são resolvidos.
- A sessão do tec-agent precisa ter acesso ao caderno e a listagem deve informar a quantidade de questões.
- Se o tec-agent não identificar o gabarito, o bot interrompe o envio daquela questão para evitar uma correção errada.
