import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocketServer, WebSocket } from 'ws';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Defina TELEGRAM_BOT_TOKEN.');
const tecDir = process.env.TEC_AGENT_DIR || path.join(os.homedir(), '.tec-agent');
process.env.TEC_AGENT_HOME ||= tecDir;
const agentRoot = process.env.TEC_AGENT_ROOT || path.join(os.homedir(), 'tec-agent');
const { TecClient, Session } = await import(pathToFileURL(path.join(agentRoot, 'src/client.mjs')));
const { TecApi } = await import(pathToFileURL(path.join(agentRoot, 'src/api.mjs')));
const session = Session.load(path.join(tecDir, 'session.json'));
const client = new TecClient({ session });
const api = new TecApi(client);
const base = `https://api.telegram.org/bot${token}`;
const stateFile = path.resolve(process.env.BOT_DATA_DIR || '.', 'bot-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { chats: {}, polls: {} };
const admins = new Set((process.env.BOT_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const loginBaseUrl = process.env.BOT_LOGIN_BASE_URL || '';
const loginPort = Number(process.env.BOT_LOGIN_PORT || 8088);
const loginAttempts = new Map();
let activeLogin = null;
let offset = 0;

function save() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}
async function tg(method, payload = {}) {
  const res = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} falhou`);
  return data.result;
}
function htmlPage() {
  return `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta charset="utf-8"><title>Login TEC</title><style>
    *{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:15px system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh}header{padding:10px 14px;background:#17232d;flex:none}h1{font-size:18px;margin:0 0 3px}#status{color:#9fe6b8;margin:0}#screen{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;background:#222}canvas{display:block;max-width:100%;max-height:100%;touch-action:none}footer{display:flex;gap:8px;padding:8px;background:#17232d;flex:none}input{min-width:0;flex:1;font:16px system-ui;padding:10px;border-radius:8px;border:0}button{padding:8px 14px;border:0;border-radius:8px;background:#3979f6;color:white;font-weight:600}
    </style><header><h1>Conectar ao TEC</h1><p id="status">Conectando ao navegador seguro…</p></header><main id="screen"><canvas id="view"></canvas></main><footer><input id="typing" type="text" placeholder="Toque em um campo no TEC e digite aqui" autocomplete="off" autocapitalize="off"><button id="send">Enviar</button></footer><script>
      const status=document.getElementById('status'), canvas=document.getElementById('view'), ctx=canvas.getContext('2d'), screen=document.getElementById('screen'), input=document.getElementById('typing');
      const token=location.hash.slice(1); history.replaceState(null,'',location.pathname);
      const scheme=location.protocol==='https:'?'wss:':'ws:', ws=new WebSocket(scheme+'//'+location.host+location.pathname.replace(/\\/$/,'')+'/ws'); let image=null;
      ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token}));
      ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.type==='status'){status.textContent=m.text;return;} if(m.type==='frame'){const img=new Image();img.onload=()=>{canvas.width=img.width;canvas.height=img.height;image=img;fit();};img.src='data:image/jpeg;base64,'+m.data;}};
      ws.onclose=e=>{if(!/confirmado|concluído|expirado|falhou/i.test(status.textContent))status.textContent=e.reason||'Conexão encerrada. Solicite um novo /login ao bot.';};
      function fit(){if(!image)return;const scale=Math.min(screen.clientWidth/image.width,screen.clientHeight/image.height);canvas.style.width=(image.width*scale)+'px';canvas.style.height=(image.height*scale)+'px';ctx.drawImage(image,0,0);}
      new ResizeObserver(fit).observe(screen);
      function point(e){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
      let down;canvas.addEventListener('pointerdown',e=>down={x:e.clientX,y:e.clientY});canvas.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<12){const p=point(e);ws.send(JSON.stringify({type:'tap',...p}));}down=null;});canvas.addEventListener('pointercancel',()=>down=null);canvas.addEventListener('wheel',e=>{e.preventDefault();ws.send(JSON.stringify({type:'scroll',deltaY:e.deltaY}));},{passive:false});
      let touchY;canvas.addEventListener('touchstart',e=>touchY=e.touches[0].clientY,{passive:true});canvas.addEventListener('touchend',e=>{if(touchY==null)return;const dy=touchY-e.changedTouches[0].clientY;if(Math.abs(dy)>12)ws.send(JSON.stringify({type:'scroll',deltaY:dy*2}));touchY=null;});
      document.getElementById('send').onclick=()=>{if(input.value){ws.send(JSON.stringify({type:'text',text:input.value}));input.value='';}};
      input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('send').click();}});
    </script></html>`;
}
const loginPath = loginBaseUrl ? new URL(loginBaseUrl).pathname.replace(/\/+$/, '') : '';
const loginSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
let loginServer;
const tecOrigin = 'https://www.tecconcursos.com.br';

async function runBrowserLogin(attempt, ws) {
  let browser;
  const originalCookies = { ...client.session.cookies };
  const status = (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'status', text })); };
  const finish = async (message, ok = false) => {
    attempt.status = ok ? 'success' : 'failed';
    status(message);
    await tg('sendMessage', { chat_id: attempt.chatId, text: ok ? 'Sessão TEC atualizada com sucesso. O bot já pode buscar questões e cadernos.' : `Não consegui concluir o login TEC: ${message}` }).catch(() => {});
  };
  try {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('Conexão da página já foi encerrada.');
    status('Abrindo o TEC…');
    const executablePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
    if (!executablePath) throw new Error('Chromium/Chrome não encontrado na VPS.');
    browser = await chromium.launch({ headless: false, executablePath, args: ['--no-first-run', '--no-default-browser-check'] });
    attempt.browser = browser;
    const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'pt-BR' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    attempt.input = async message => {
      if (page.isClosed()) return;
      if (message.type === 'tap' && Number.isFinite(message.x) && Number.isFinite(message.y)) {
        const viewport = page.viewportSize();
        await page.mouse.click(Math.round(message.x * viewport.width), Math.round(message.y * viewport.height));
      } else if (message.type === 'scroll' && Number.isFinite(message.deltaY)) {
        await page.mouse.wheel(0, Math.max(-1200, Math.min(1200, message.deltaY)));
      } else if (message.type === 'text' && typeof message.text === 'string' && message.text.length <= 1000) {
        await page.keyboard.insertText(message.text);
      }
    };
    await cdp.send('Page.enable');
    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) ws.send(JSON.stringify({ type: 'frame', data }));
      } catch { /* cliente desconectado; sempre confirmamos o frame para continuar */ }
      finally { cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); }
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 900, maxHeight: 1600, everyNthFrame: 2 });
    await page.goto(`${tecOrigin}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    status('Entre na sua conta TEC. Esta tela é transmitida em tempo real.');
    const expiresAt = Date.now() + 10 * 60_000;
    while (Date.now() < expiresAt && ws.readyState === WebSocket.OPEN) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      if (page.isClosed()) throw new Error('A janela do TEC foi encerrada.');
      const cookies = Object.fromEntries((await context.cookies(tecOrigin)).filter(c => /(?:^|\.)tecconcursos\.com\.br$/.test(c.domain)).map(c => [c.name, c.value]));
      if (!cookies.TecPermanecerLogado) continue;
      client.session.cookies = cookies;
      if ((await client.whoami()).logged) {
        client.session.meta = { via: 'browser-screencast', at: new Date().toISOString() };
        client.session.save();
        return finish('Login confirmado! Você já pode fechar esta página.', true);
      }
      client.session.cookies = { ...originalCookies };
    }
    if (ws.readyState !== WebSocket.OPEN) throw new Error('Conexão da página interrompida. Solicite outro /login.');
    throw new Error('Tempo esgotado aguardando a confirmação do login.');
  } catch (error) {
    client.session.cookies = { ...originalCookies };
    client.session.save();
    await finish(error.message);
    console.error(`Login TEC falhou: ${error.message}`);
  } finally {
    clearTimeout(attempt.expiryTimer);
    if (browser) await browser.close().catch(() => {});
    attempt.browser = null;
    if (activeLogin === attempt) activeLogin = null;
    setTimeout(() => loginAttempts.delete(attempt.token), 60_000).unref();
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Login finalizado');
  }
}

loginServer = createServer((req, res) => {
  const requestPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (requestPath !== loginPath || req.method !== 'GET') {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('Rota não encontrada.');
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' wss:; img-src data:;",
  });
  res.end(htmlPage());
});
loginServer.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const publicOrigin = new URL(loginBaseUrl).origin;
  if (requestUrl.pathname !== `${loginPath}/ws` || req.headers.origin !== publicOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  loginSockets.handleUpgrade(req, socket, head, ws => loginSockets.emit('connection', ws));
});
loginSockets.on('connection', ws => {
  const authTimeout = setTimeout(() => ws.close(4401, 'Autenticação expirou'), 5_000);
  let authenticated = false;
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { ws.close(4400, 'Mensagem inválida'); return; }
    if (!authenticated) {
      const attempt = loginAttempts.get(String(message.token || ''));
      if (message.type !== 'auth' || !attempt || attempt !== activeLogin || attempt.status !== 'waiting' || Date.now() > attempt.expiresAt) {
        clearTimeout(authTimeout);
        ws.close(4401, 'Link de login inválido ou expirado');
        return;
      }
      authenticated = true;
      clearTimeout(authTimeout);
      attempt.status = 'connecting';
      attempt.ws = ws;
      void runBrowserLogin(attempt, ws);
      return;
    }
    const attempt = activeLogin;
    if (typeof attempt?.input === 'function') void attempt.input(message).catch(() => {});
  });
  ws.on('close', () => {
    clearTimeout(authTimeout);
    const attempt = activeLogin;
    if (authenticated && attempt?.ws === ws && attempt.status === 'connecting') {
      attempt.status = 'cancelled';
      attempt.browser?.close().catch(() => {});
    }
  });
});
async function beginLogin(chatId, userId) {
  if (!loginBaseUrl) throw new Error('Falta configurar BOT_LOGIN_BASE_URL com o endereço HTTPS /tec-login da VPS.');
  const publicUrl = new URL(loginBaseUrl);
  if (publicUrl.protocol !== 'https:') throw new Error('O login remoto exige BOT_LOGIN_BASE_URL com HTTPS.');
  if (activeLogin) throw new Error('Já existe um login em andamento. Abra o link recebido ou aguarde ele expirar.');
  const attempt = {
    token: randomBytes(32).toString('base64url'),
    chatId, userId, status: 'waiting', expiresAt: Date.now() + 10 * 60_000, browser: null, ws: null,
  };
  loginAttempts.set(attempt.token, attempt);
  activeLogin = attempt;
  attempt.expiryTimer = setTimeout(() => {
    if (activeLogin !== attempt || attempt.status !== 'waiting') return;
    attempt.status = 'expired';
    activeLogin = null;
    loginAttempts.delete(attempt.token);
    void tg('sendMessage', { chat_id: chatId, text: 'O link de login TEC expirou. Envie /login novamente para gerar outro.' }).catch(() => {});
  }, attempt.expiresAt - Date.now()).unref();
  try {
    const link = new URL(loginPath, publicUrl.origin);
    link.hash = attempt.token;
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Abra o link no celular. A página mostrará o TEC e transmitirá a sessão diretamente ao bot após a confirmação. O link expira em 10 minutos e só pode ser usado uma vez.',
      reply_markup: { inline_keyboard: [[{ text: '🔐 Abrir login do TEC', url: link.href }]] },
    });
  } catch (error) {
    loginAttempts.delete(attempt.token);
    activeLogin = null;
    clearTimeout(attempt.expiryTimer);
    throw error;
  }
}
const chatKey = (id) => String(id);
function privateChat(chat) { return chat.type === 'private'; }
function compact(text = '') { return String(text).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]*\n+/g, '\n').replace(/\n{2,}/g, '\n').trim(); }
function escapeHtml(text = '') { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cadernoId(input) {
  let u;
  try { u = new URL(input); } catch { throw new Error('Envie o link completo do caderno do TEC.'); }
  if (!['tecconcursos.com.br', 'www.tecconcursos.com.br'].includes(u.hostname)) throw new Error('O link precisa ser do tecconcursos.com.br.');
  const m = u.pathname.match(/(?:questoes\/cadernos|cadernos)\/(\d+)/);
  if (m) return m[1];
  const short = u.pathname.match(/^\/(?:s|caderno)\/([^/]+)/);
  if (short) throw new Error('Links curtos (/s/ ou /caderno/) ainda não podem ser convertidos pela API do tec-agent. Envie o link direto /questoes/cadernos/ID.');
  throw new Error('Não encontrei o ID do caderno no link. Use /questoes/cadernos/ID.');
}
async function loadQuestion(cid, n) {
  const item = await api.cadernoQuestao(cid, n);
  if (!item) return null;
  const id = item.idQuestao ?? item.id ?? item.questaoId;
  if (!id) throw new Error('O TEC retornou uma questão sem ID.');
  const [q, raw] = await Promise.all([
    api.questao(id, { comentario: true }),
    api.questaoBruta(id),
  ]);

  // Só usamos o campo estruturado da API. O tec-agent também tenta inferir a
  // resposta pelo comentário do professor; essa inferência pode confundir uma
  // conclusão sobre o texto-base com o gabarito do item.
  q.gabarito = null;
  const numero = typeof raw?.numeroAlternativaCorreta === 'number'
    ? raw.numeroAlternativaCorreta
    : /^\d+$/.test(String(raw?.numeroAlternativaCorreta ?? ''))
      ? Number(raw.numeroAlternativaCorreta)
      : NaN;
  // Em algumas questões C/E a API omite o array de alternativas; o Telegram
  // já usa exatamente estas duas opções como fallback em showQuestion().
  const opcoes = q.alternativas?.length
    ? q.alternativas
    : q.tipo === 'CERTO_ERRADO' ? ['Certo', 'Errado'] : [];
  if (Number.isInteger(numero) && numero > 0 && numero <= opcoes.length) {
    q.gabarito = q.tipo === 'CERTO_ERRADO'
      ? opcoes[numero - 1]
      : String.fromCharCode(64 + numero);
  }
  return q;
}
function totalFrom(item) { return Number(item?.quantidadeItens ?? item?.totalQuestoes ?? item?.quantidade ?? 0); }
async function findTotal(cid) {
  const folders = await api.pastas();
  for (const folder of folders) {
    for (let p = 1; ; p++) {
      const items = await api.listarCadernos(folder.id, { pagina: p });
      if (!items.length) break;
      const hit = items.find(x => String(x.id) === String(cid));
      if (hit) return totalFrom(hit);
    }
  }
  return 0;
}
async function listAll(folderId, subfolderId) {
  const all = [], seen = new Set();
  for (let page = 1; ; page++) {
    const items = await api.listarCadernos(folderId, { subpastaId: subfolderId, pagina: page });
    if (!items.length || items.every(item => seen.has(String(item.id)))) return all;
    for (const item of items) seen.add(String(item.id));
    all.push(...items);
  }
}
function button(text, callback_data) { return { text: String(text).slice(0, 60), callback_data }; }
async function browse(chatId, messageId, where = { type: 'root', page: 0 }) {
  const folders = await api.pastas();
  if (!folders.length) throw new Error('Não encontrei pastas na sua conta TEC.');
  let folder, subfolderId = null, title, back = 'b:root';
  if (where.type === 'root') {
    folder = folders.find(x => x.ativa) || folders.find(x => /sem classifica/i.test(x.nome)) || folders[0];
    title = `Cadernos na raiz · ${folder.nome}`;
  } else {
    folder = folders.find(x => String(x.id) === String(where.folderId));
    if (!folder) throw new Error('Pasta não encontrada. Abra /caderno lista novamente.');
    if (where.type === 'sub') {
      subfolderId = String(where.subfolderId);
      back = `b:f:${folder.id}:0`;
      title = `${folder.nome} · subpasta`;
    } else {
      back = 'b:root';
      title = folder.nome;
    }
  }
  const items = await listAll(folder.id, subfolderId);
  const pageSize = 8, pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(0, Number(where.page) || 0), pages - 1);
  const keyboard = [];
  if (where.type === 'root') {
    keyboard.push([{ text: 'Pastas', callback_data: 'b:folders:0' }]);
  }
  for (const item of items.slice(page * pageSize, (page + 1) * pageSize)) {
    if (item.subpasta) keyboard.push([button(`📁 ${item.nome}`, `b:s:${folder.id}:${item.id}:0`)]);
    else keyboard.push([button(`📘 ${item.nome} · ${item.quantidadeItens ?? '?'} questões`, `b:c:${folder.id}:${subfolderId || 0}:${item.id}`)]);
  }
  if (pages > 1) {
    const prefix = where.type === 'sub' ? `b:s:${folder.id}:${subfolderId}` : where.type === 'folder' ? `b:f:${folder.id}` : 'b:r';
    keyboard.push([
      ...(page > 0 ? [button('‹ Anterior', `${prefix}:${page - 1}`)] : []),
      button(`${page + 1}/${pages}`, 'b:nop'),
      ...(page + 1 < pages ? [button('Próxima ›', `${prefix}:${page + 1}`)] : []),
    ]);
  }
  keyboard.push([button('‹ Voltar às pastas', where.type === 'root' ? 'b:folders:0' : back)]);
  const text = `${title}\n${items.length ? `${items.length} itens` : 'Nenhum caderno ou subpasta nesta pasta.'}`;
  const payload = { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard } };
  if (messageId) await tg('editMessageText', payload);
  else await tg('sendMessage', { chat_id: chatId, text, reply_markup: payload.reply_markup });
}
async function showFolders(chatId, messageId, page = 0) {
  const folders = await api.pastas();
  const pageSize = 12, pages = Math.max(1, Math.ceil(folders.length / pageSize));
  page = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const keyboard = folders.slice(page * pageSize, (page + 1) * pageSize).map(f => [button(`📂 ${f.nome}`, `b:f:${f.id}:0`)]);
  if (pages > 1) keyboard.push([
    ...(page > 0 ? [button('‹ Anterior', `b:folders:${page - 1}`)] : []),
    button(`${page + 1}/${pages}`, 'b:nop'),
    ...(page + 1 < pages ? [button('Próxima ›', `b:folders:${page + 1}`)] : []),
  ]);
  keyboard.push([button('‹ Voltar', 'b:root')]);
  const payload = { chat_id: chatId, text: 'Escolha uma pasta:', reply_markup: { inline_keyboard: keyboard } };
  if (messageId) await tg('editMessageText', { ...payload, message_id: messageId });
  else await tg('sendMessage', payload);
}
function chatState(chatId) { return state.chats[chatKey(chatId)] ||= {}; }
function scoreKey(chatId, userId, cid) { return `${chatId}:${userId}:${cid}`; }
function solvedSet(chatId, userId, cid) { return new Set(state.answers?.[scoreKey(chatId, userId, cid)] || []); }
function unavailableSet(cid) { return new Set(state.unavailable?.[String(cid)] || []); }
async function nextIndex(cs, chatId, userId, mode) {
  const n = cs.total;
  const done = solvedSet(chatId, userId, cs.cadernoId);
  const unavailable = unavailableSet(cs.cadernoId);
  const available = Array.from({ length: n }, (_, i) => i + 1).filter(i => !done.has(i) && !unavailable.has(i));
  if (mode === 'random') {
    return available.length ? available[Math.floor(Math.random() * available.length)] : null;
  }
  return available[0] ?? null;
}
async function showQuestion(chat, user, mode = 'next') {
  const cs = chatState(chat.id);
  if (!cs.cadernoId || !cs.total) throw new Error('Primeiro envie /caderno seguido do link direto do caderno.');
  let ignoradasNestaBusca = 0;
  let n, q, options, correctId;
  while ((n = await nextIndex(cs, chat.id, user.id, mode)) !== null) {
    q = await loadQuestion(cs.cadernoId, n);
    if (!q) throw new Error(`Não consegui carregar a questão ${n} do caderno. Confira o link e seu login do TEC.`);
    options = q.alternativas?.length ? q.alternativas : ['Certo', 'Errado'];
    correctId = options.findIndex((x, i) => x === q.gabarito || String(q.gabarito).toUpperCase() === String.fromCharCode(65 + i));
    if (correctId >= 0) break;

    state.unavailable ||= {};
    state.unavailable[String(cs.cadernoId)] ||= [];
    if (!state.unavailable[String(cs.cadernoId)].includes(n)) state.unavailable[String(cs.cadernoId)].push(n);
    ignoradasNestaBusca++;
    save();
  }
  if (n === null) {
    const ignoradas = unavailableSet(cs.cadernoId).size;
    const respondidas = solvedSet(chat.id, user.id, cs.cadernoId).size;
    const resumo = ignoradas ? ` ${ignoradas} questão(ões) sem gabarito retornado pelo TEC foram ignoradas.` : '';
    return tg('sendMessage', { chat_id: chat.id, text: `Não há mais questões disponíveis neste caderno. Você respondeu ${respondidas}/${cs.total} no Telegram.${resumo}` });
  }
  if (ignoradasNestaBusca) await tg('sendMessage', { chat_id: chat.id, text: `⏭️ ${ignoradasNestaBusca} questão(ões) sem gabarito retornado pelo TEC foram ignoradas.` });
  const description = [
    q.banca,
    [q.orgao || q.orgaoNome, q.ano].filter(Boolean).join(' '),
    q.cargo,
    q.prova,
    q.numero ? `Questão ${q.numero}` : null,
  ].filter(Boolean).join(' - ') || `Questão TEC #${q.id}`;
  const prompt = compact(q.enunciado || '(sem enunciado)');
  const parts = prompt.match(/[\s\S]{1,3800}/g) || [''];
  for (let i = 0; i < parts.length; i++) {
    await tg('sendMessage', { chat_id: chat.id, text: `${i === 0 ? `<b>${escapeHtml(description)}</b>\n` : ''}${escapeHtml(parts[i])}`, parse_mode: 'HTML' });
  }
  const poll = await tg('sendPoll', { chat_id: chat.id, question: `Questão TEC #${q.id} — ${n}/${cs.total}`, options: options.map((x, i) => ({ text: `${String.fromCharCode(65 + i)}. ${x}`.slice(0, 100) })), type: 'quiz', is_anonymous: false, correct_option_id: correctId, explanation: 'Use os botões abaixo para ver o comentário ou escolher outra questão.', explanation_parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Ver comentário', callback_data: `c:${q.id}` }], [{ text: 'Próxima', callback_data: 'q:n' }, { text: 'Aleatória', callback_data: 'q:r' }]] } });
  state.polls[poll.poll.id] = { chatId: chat.id, cid: cs.cadernoId, index: n, qid: q.id, answer: correctId };
  save();
}
async function handleMessage(m) {
  if (!m.text) return;
  const [cmd, ...args] = m.text.trim().split(/\s+/);
  const chat = m.chat, user = m.from;
  try {
    if (cmd === '/start' || cmd.startsWith('/start@')) return tg('sendMessage', { chat_id: chat.id, text: 'Bot de questões TEC. Use /lista para navegar pelos cadernos ou /caderno LINK para abrir pelo link. /proxima, /aleatoria e /status controlam seu estudo. Em grupos, o progresso é individual.' });
    if (cmd === '/id' || cmd.startsWith('/id@')) return tg('sendMessage', { chat_id: chat.id, text: `Seu ID Telegram é ${user.id}.` });
    if (cmd === '/login' || cmd.startsWith('/login@')) {
      if (!admins.has(String(user.id))) throw new Error('Este comando é restrito aos administradores configurados na VPS.');
      if (!privateChat(chat)) throw new Error('Por segurança, envie /login em uma conversa privada com o bot.');
      return beginLogin(chat.id, user.id);
    }
    if (cmd === '/caderno' || cmd.startsWith('/caderno@')) {
      const id = cadernoId(args.join(' '));
      const total = await findTotal(id);
      if (!total) throw new Error('Não localizei a quantidade de questões. Confira se o caderno pertence à conta autenticada do tec-agent e se o link contém o ID numérico.');
      Object.assign(chatState(chat.id), { cadernoId: id, total, link: args.join(' ') }); save();
      return tg('sendMessage', { chat_id: chat.id, text: `Caderno carregado (${total} questões). Use /proxima ou /aleatoria.` });
    }
    if (cmd === '/lista' || cmd.startsWith('/lista@')) return browse(chat.id, null);
    if (cmd === '/proxima' || cmd.startsWith('/proxima@')) return showQuestion(chat, user, 'next');
    if (cmd === '/aleatoria' || cmd.startsWith('/aleatoria@')) return showQuestion(chat, user, 'random');
    if (cmd === '/status' || cmd.startsWith('/status@')) {
      const cs = chatState(chat.id); const done = cs.cadernoId ? solvedSet(chat.id, user.id, cs.cadernoId).size : 0;
      const skipped = cs.cadernoId ? unavailableSet(cs.cadernoId).size : 0;
      const skippedText = skipped ? ` ${skipped} sem gabarito retornado pelo TEC foram ignoradas.` : '';
      return tg('sendMessage', { chat_id: chat.id, text: cs.total ? `Caderno ${cs.cadernoId}: ${done}/${cs.total} questões respondidas por você aqui no Telegram.${skippedText}` : 'Nenhum caderno carregado neste chat.' });
    }
  } catch (e) { await tg('sendMessage', { chat_id: chat.id, text: `Erro: ${e.message}` }); }
}
async function handleUpdate(u) {
  if (u.message) await handleMessage(u.message);
  if (u.poll_answer) {
    const pa = u.poll_answer, p = state.polls[pa.poll_id];
    if (p && pa.user && pa.option_ids?.length) {
      const key = scoreKey(p.chatId, pa.user.id, p.cid);
      state.answers ||= {}; state.answers[key] ||= [];
      if (!state.answers[key].includes(p.index)) state.answers[key].push(p.index);
      save();
      const ok = pa.option_ids[0] === p.answer;
      await tg('sendMessage', { chat_id: p.chatId, text: `${pa.user.first_name || 'Usuário'}: ${ok ? '✅ Acertou!' : '❌ Errou.'}` });
    }
  }
  if (u.callback_query) {
    const cb = u.callback_query;
    if (cb.data?.startsWith('b:')) {
      try {
        const [_, action, a, b, c] = cb.data.split(':');
        if (action === 'root') await browse(cb.message.chat.id, cb.message.message_id);
        else if (action === 'folders') await showFolders(cb.message.chat.id, cb.message.message_id, a);
        else if (action === 'r') await browse(cb.message.chat.id, cb.message.message_id, { type: 'root', page: a });
        else if (action === 'f') await browse(cb.message.chat.id, cb.message.message_id, { type: 'folder', folderId: a, page: b });
        else if (action === 's') await browse(cb.message.chat.id, cb.message.message_id, { type: 'sub', folderId: a, subfolderId: b, page: c });
        else if (action === 'c') {
          const folders = await api.pastas();
          if (!folders.some(folder => String(folder.id) === String(a))) throw new Error('Pasta não encontrada.');
          const subfolderId = c && b !== '0' ? b : null;
          const caderno = c || b;
          const item = (await listAll(a, subfolderId)).find(entry => String(entry.id) === String(caderno) && !entry.subpasta);
          if (!item) throw new Error('Não encontrei esse caderno na sua conta TEC.');
          const total = totalFrom(item);
          if (!total) throw new Error('O TEC não informou quantas questões há neste caderno.');
          Object.assign(chatState(cb.message.chat.id), { cadernoId: String(item.id), total, name: item.nome }); save();
          await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `Caderno selecionado: ${item.nome}\n${total} questões. Use /proxima ou /aleatoria.` });
        } else if (action === 'nop') { /* apenas indicador da página */ }
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: e.message.slice(0, 180), show_alert: true }); }
    } else if (cb.data?.startsWith('c:')) {
      try {
        const q = await api.questao(cb.data.slice(2), { comentario: true });
        const body = q.comentario || 'O TEC não disponibilizou comentário para esta questão.';
        const chunks = body.match(/[\s\S]{1,3800}/g) || ['Sem comentário.'];
        for (const chunk of chunks) await tg('sendMessage', { chat_id: cb.message.chat.id, text: chunk, reply_to_message_id: cb.message.message_id });
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: e.message.slice(0, 180), show_alert: true }); }
    } else if (cb.data === 'q:n' || cb.data === 'q:r') {
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      try { await showQuestion(cb.message.chat, cb.from, cb.data === 'q:n' ? 'next' : 'random'); }
      catch (e) { await tg('sendMessage', { chat_id: cb.message.chat.id, text: `Erro: ${e.message}` }); }
    }
  }
}
if (loginBaseUrl) {
  const publicLoginUrl = new URL(loginBaseUrl);
  if (publicLoginUrl.protocol !== 'https:' || !loginPath || loginPath === '/') throw new Error('BOT_LOGIN_BASE_URL deve ser uma URL HTTPS terminada em /tec-login.');
  await new Promise((resolve, reject) => {
    loginServer.once('error', reject);
    loginServer.listen(loginPort, '127.0.0.1', resolve);
  });
  console.log(`Login TEC por navegador remoto ativo em 127.0.0.1:${loginPort}${loginPath}`);
}
console.log(`Bot iniciado. Estado: ${stateFile}`);
while (true) {
  try {
    const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'poll_answer', 'callback_query'] });
    for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
  } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
}

