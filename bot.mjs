import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Defina TELEGRAM_BOT_TOKEN.');
const tecDir = process.env.TEC_AGENT_DIR || path.join(os.homedir(), '.tec-agent');
process.env.TEC_AGENT_HOME ||= tecDir;
const agentRoot = process.env.TEC_AGENT_ROOT || path.join(os.homedir(), 'tec-agent');
const { TecClient, Session, AuthError } = await import(pathToFileURL(path.join(agentRoot, 'src/client.mjs')));
const { TecApi } = await import(pathToFileURL(path.join(agentRoot, 'src/api.mjs')));
const { importCookies } = await import(pathToFileURL(path.join(agentRoot, 'src/auth.mjs')));
const session = Session.load(path.join(tecDir, 'session.json'));
const client = new TecClient({ session });
const api = new TecApi(client);
const base = `https://api.telegram.org/bot${token}`;
const stateFile = path.resolve(process.env.BOT_DATA_DIR || '.', 'bot-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { chats: {}, polls: {} };
const admins = new Set((process.env.BOT_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const loginPairs = new Map();
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
async function importLogin(cookieText) {
  const trial = new Session(path.join(tecDir, '.session-check.json'));
  try {
    importCookies(new TecClient({ session: trial }), cookieText);
    if (!(await new TecClient({ session: trial }).whoami()).logged) {
      throw new Error('A sessão recebida não foi aceita pelo TEC. Faça login novamente no Chrome e use “Sincronizar agora” na extensão.');
    }
    session.cookies = trial.cookies;
    session.meta = { via: 'chrome-extension-sync', at: new Date().toISOString() };
    session.save();
  } finally { trial.clear(); }
}

function sessionHelp() {
  return 'A sessão TEC sincronizada expirou ou foi substituída. Faça login no TEC pelo Chrome com a extensão instalada; ela enviará a sessão nova automaticamente. Se ainda não pareou, envie /login ao bot no privado.';
}
function errorText(error) {
  return error instanceof AuthError ? sessionHelp() : `Erro: ${error.message}`;
}

const loginServer = createServer(async (req, res) => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
  if (req.method === 'OPTIONS' && ['/tec-login/pair', '/tec-login/sync'].includes(req.url)) {
    res.writeHead(204, headers); return res.end();
  }
  if (req.method !== 'POST' || !['/tec-login/pair', '/tec-login/sync'].includes(req.url)) {
    res.writeHead(404, headers); return res.end(JSON.stringify({ error: 'Rota não encontrada.' }));
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_000) { res.writeHead(413, headers); return res.end(JSON.stringify({ error: 'Solicitação muito grande.' })); }
    }
    const payload = JSON.parse(body);
    if (req.url === '/tec-login/pair') {
      const code = String(payload.code || '');
      const pair = loginPairs.get(code);
      if (!pair || pair.expiresAt < Date.now()) { res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Código inválido ou expirado. Envie /login ao bot novamente.' })); }
      loginPairs.delete(code);
      const deviceToken = randomBytes(32).toString('base64url');
      state.extensionTokenHash = createHash('sha256').update(deviceToken).digest('hex');
      state.extensionPairedAt = new Date().toISOString();
      save();
      res.writeHead(200, headers); return res.end(JSON.stringify({ ok: true, token: deviceToken }));
    }

    const suppliedToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expectedHash = state.extensionTokenHash;
    const suppliedHash = createHash('sha256').update(suppliedToken).digest();
    const expected = /^[a-f0-9]{64}$/i.test(expectedHash || '') ? Buffer.from(expectedHash, 'hex') : Buffer.alloc(32);
    if (suppliedToken.length < 40 || suppliedToken.length > 100 || !timingSafeEqual(suppliedHash, expected)) {
      res.writeHead(401, headers); return res.end(JSON.stringify({ error: 'Extensão não pareada. Envie /login ao bot e pareie novamente.' }));
    }
    if (typeof payload.cookies !== 'string' || payload.cookies.length > 24_000) {
      res.writeHead(400, headers); return res.end(JSON.stringify({ error: 'Cookies ausentes ou inválidos.' }));
    }
    await importLogin(payload.cookies);
    state.extensionSyncedAt = new Date().toISOString();
    save();
    res.writeHead(200, headers); return res.end(JSON.stringify({ ok: true, syncedAt: state.extensionSyncedAt }));
  } catch (error) {
    console.error(`Sincronização TEC falhou: ${error.message}`);
    res.writeHead(401, headers); return res.end(JSON.stringify({ error: error.message || 'Não foi possível validar a sessão TEC.' }));
  }
});
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
      for (const [oldCode, pending] of loginPairs) if (pending.userId === String(user.id)) loginPairs.delete(oldCode);
      const code = randomBytes(18).toString('base64url');
      const pair = { userId: String(user.id), chatId: String(chat.id), expiresAt: Date.now() + 5 * 60_000 };
      loginPairs.set(code, pair);
      setTimeout(() => {
        if (loginPairs.get(code) === pair && Date.now() >= pair.expiresAt) {
          loginPairs.delete(code);
          void tg('sendMessage', { chat_id: chat.id, text: 'O código de pareamento da extensão expirou. Envie /login novamente.' }).catch(() => {});
        }
      }, 5 * 60_000).unref();
      return tg('sendMessage', { chat_id: chat.id, text: `Código para parear a extensão TEC: ${code}\n\nNo Chrome do PC, abra TEC Session Sync e cole este código uma vez. Depois disso, novos logins no TEC serão sincronizados automaticamente com a VPS. O código expira em 5 minutos.` });
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
  } catch (e) {
    await tg('sendMessage', { chat_id: chat.id, text: errorText(e) });
  }
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
      } catch (e) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: errorText(e).slice(0, 180), show_alert: true }); }
    } else if (cb.data?.startsWith('c:')) {
      try {
        const q = await api.questao(cb.data.slice(2), { comentario: true });
        const body = q.comentario || 'O TEC não disponibilizou comentário para esta questão.';
        const chunks = body.match(/[\s\S]{1,3800}/g) || ['Sem comentário.'];
        for (const chunk of chunks) await tg('sendMessage', { chat_id: cb.message.chat.id, text: chunk, reply_to_message_id: cb.message.message_id });
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: errorText(e).slice(0, 180), show_alert: true }); }
    } else if (cb.data === 'q:n' || cb.data === 'q:r') {
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      try { await showQuestion(cb.message.chat, cb.from, cb.data === 'q:n' ? 'next' : 'random'); }
      catch (e) { await tg('sendMessage', { chat_id: cb.message.chat.id, text: errorText(e) }); }
    }
  }
}
await new Promise((resolve, reject) => {
  loginServer.once('error', reject);
  loginServer.listen(Number(process.env.BOT_LOGIN_PORT || 8088), '127.0.0.1', resolve);
});
console.log(`Bot iniciado. Callback TEC em 127.0.0.1:${Number(process.env.BOT_LOGIN_PORT || 8088)}. Estado: ${stateFile}`);
while (true) {
  try {
    const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'poll_answer', 'callback_query'] });
    for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
  } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
}

