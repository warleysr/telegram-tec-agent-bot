# Bot Telegram para TEC Concursos

Bot em Node.js 20+ que usa o [tec-agent](https://github.com/warleysr/tec-agent) para obter cadernos e questões. As respostas e o progresso do quiz ficam no Telegram e não alteram o histórico de resolução do site TEC.

## Instalação na VPS

O instalador configura a aplicação para rodar gerenciada pelo **PM2** e a rota HTTPS do callback no Apache. Ele pressupõe que a VPS já tenha Apache com certificado HTTPS para `blackgroup.com.br` e que esse domínio seja o usado pela extensão. O Apache precisa estar ativo e ter um `VirtualHost *:443` com `ServerName` ou `ServerAlias blackgroup.com.br`.

```bash
git clone https://github.com/warleysr/telegram-tec-agent-bot.git
cd telegram-tec-agent-bot
sudo bash install.sh
```

Na primeira instalação, informe o token do `@BotFather` e o ID Telegram do administrador. Em atualizações, o instalador preserva esses dados de `/etc/telegram-tec-bot.env`. Ele instala o `tec-agent`, configura o proxy Apache para `https://blackgroup.com.br/tec-login` e inicia o bot gerenciado pelo PM2.

### Gerenciamento do bot com PM2:

```bash
# Acompanhar logs detalhados em tempo real (rotas HTTP, eventos do Telegram e respostas):
pm2 logs telegram-tec-bot

# Ver o status do processo:
pm2 status

# Reiniciar o bot:
pm2 restart telegram-tec-bot

# Parar o bot:
pm2 stop telegram-tec-bot
```

Requisitos: Ubuntu/Debian com Apache e certificado já configurados, Git, Python 3 e Node.js 20+ com npm. O instalador ativa os módulos `proxy` e `proxy_http` do Apache. Não precisa abrir outra porta pública; o bot escuta somente em `127.0.0.1:8088`.

## Extensão no Chrome ou Helium (Windows)

A extensão sincroniza a sessão diretamente com o bot, sem necessidade de nenhum código de pareamento:

1. Baixe ou clone este repositório no PC e extraia os arquivos.
2. Abra `chrome://extensions`, ative **Modo do desenvolvedor** e clique em **Carregar sem compactação**. No Helium, use a mesma página de extensões Chromium.
3. Selecione a pasta `extension` do repositório.
4. Faça login na sua conta do TEC Concursos no navegador normalmente.
5. A extensão detecta o login e envia automaticamente a sessão para o bot. Se desejar enviar ou validar de imediato, clique no ícone da extensão e depois em **Sincronizar agora**.

O bot valida a sessão imediatamente ao receber os cookies. Se a sessão expirar ou for substituída, faça login no TEC pelo Chrome e clique em **Sincronizar agora**.

## Comandos do bot

- `/lista` navega por pastas, subpastas e cadernos da conta TEC.
- `/caderno LINK` carrega um caderno pelo link direto.
- `/proxima` abre a próxima questão do caderno com gabarito identificado.
- `/aleatoria` escolhe uma questão não respondida aleatoriamente.
- `/status` mostra seu progresso no Telegram.
- `/id` mostra seu ID Telegram.
- `/login` orientações sobre a sincronização direta via extensão.

Cada questão chega como quiz do Telegram, com gabarito validado (múltipla escolha de A a E ou Certo/Errado), botão **Ver comentário** e botões **Próxima** e **Aleatória**. Em grupos, várias pessoas podem responder; o progresso é individual por usuário e chat.

Exemplos:

```text
/caderno https://www.tecconcursos.com.br/questoes/cadernos/12345678
/proxima
/aleatoria
/status
```

## Logs e Monitoramento

O bot inclui logs com timestamp e tags estruturadas para todos os eventos e rotas chamadas:
- `[HTTP]` / `[SYNC]`: Chamadas recebidas pela extensão, método, rota, IP de origem e status de validação dos cookies.
- `[MSG]` / `[CMD]`: Comandos executados pelos usuários no Telegram, chats e parâmetros.
- `[QUESTION]` / `[QUIZ]`: Extração de questões, identificação de gabarito e envio dos quizzes.
- `[POLL_ANSWER]`: Respostas submetidas pelos alunos e validação de acerto/erro.
- `[CALLBACK]`: Interações com botões inline (navegação em cadernos, comentários, avanço).

Todos os logs podem ser consultados ao vivo via `pm2 logs telegram-tec-bot` ou nos arquivos em `/opt/telegram-tec-bot/logs/`.

## Atualizar

Na VPS, execute novamente o instalador para atualizar o bot, a extensão e o PM2:

```bash
cd /opt/telegram-tec-bot
git pull
sudo bash install.sh
```

Depois de atualizar, recarregue a pasta `extension` em `chrome://extensions` (botão **Recarregar**) para aplicar no navegador.
