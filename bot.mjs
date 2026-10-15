import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Carrega variáveis do /etc/telegram-tec-bot.env ou .env local se existirem e não estiverem no ambiente
const envCandidates = [
  process.env.ENV_FILE,
  '/etc/telegram-tec-bot.env',
  path.resolve('.env'),
].filter(Boolean);

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    try {
      const lines = fs.readFileSync(candidate, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const k = trimmed.slice(0, eq).trim();
          const v = trimmed.slice(eq + 1).trim();
          if (process.env[k] === undefined) process.env[k] = v;
        }
      }
    } catch {}
  }
}

function formatLog(level, tag, message, ...extra) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extraStr = extra.length ? ' ' + extra.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ') : '';
  return `[${ts}] [${level}] [${tag}] ${message}${extraStr}`;
}

export function log(tag, message, ...extra) {
  console.log(formatLog('INFO', tag, message, ...extra));
}

export function logWarn(tag, message, ...extra) {
  console.warn(formatLog('WARN', tag, message, ...extra));
}

export function logError(tag, message, ...extra) {
  console.error(formatLog('ERROR', tag, message, ...extra));
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const tecDir = process.env.TEC_AGENT_DIR || path.join(os.homedir(), '.tec-agent');
process.env.TEC_AGENT_HOME ||= tecDir;

let agentRoot = process.env.TEC_AGENT_ROOT || path.join(os.homedir(), 'tec-agent');
if (!fs.existsSync(path.join(agentRoot, 'src/client.mjs')) && fs.existsSync('/opt/tec-agent/src/client.mjs')) {
  agentRoot = '/opt/tec-agent';
}

let TecClient, Session, AuthError, TecApi, importCookies;
let session, client, api;

try {
  const clientMod = await import(pathToFileURL(path.join(agentRoot, 'src/client.mjs')));
  TecClient = clientMod.TecClient;
  Session = clientMod.Session;
  AuthError = clientMod.AuthError;

  const apiMod = await import(pathToFileURL(path.join(agentRoot, 'src/api.mjs')));
  TecApi = apiMod.TecApi;

  const authMod = await import(pathToFileURL(path.join(agentRoot, 'src/auth.mjs')));
  importCookies = authMod.importCookies;

  session = Session.load(path.join(tecDir, 'session.json'));
  client = new TecClient({ session });
  api = new TecApi(client);
} catch (err) {
  logWarn('INIT', `Aviso ao carregar módulos do tec-agent: ${err.message}`);
}

const base = token ? `https://api.telegram.org/bot${token}` : null;
const stateFile = path.resolve(process.env.BOT_DATA_DIR || '.', 'bot-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { chats: {}, polls: {} };
if (state.unavailable) {
  delete state.unavailable;
}
const admins = new Set((process.env.BOT_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
let offset = 0;

// Consulta de pastas do TEC Concursos
async function tecFolders(tecClient = client) {
  const response = await tecClient.get('/pastas-cadernos/', { buscarSubpastas: true });
  if (!Array.isArray(response.pastas)) throw new Error('O TEC não retornou a lista de pastas. Confira a sessão sincronizada.');
  return response.pastas;
}

// Consulta questão em posição específica do caderno
async function tecQuestionFromNotebook(cadernoId, position) {
  const response = await client.get(`/cadernos/${cadernoId}/questoes/${position}`, { atualizarCronometro: false });
  return response.questao;
}

function save() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

async function tg(method, payload = {}) {
  if (!base) throw new Error('TELEGRAM_BOT_TOKEN não está definido.');
  const res = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} falhou`);
  return data.result;
}

async function importLogin(cookieText) {
  const trial = new Session(path.join(tecDir, '.session-check.json'));
  try {
    const trialClient = new TecClient({ session: trial });
    importCookies(trialClient, cookieText);
    if (!trial.cookies?.TecPermanecerLogado && !trial.cookies?.JSESSIONID) {
      throw new Error('Cookie TecPermanecerLogado ou JSESSIONID ausente na sincronização.');
    }
    try {
      const pastas = await tecFolders(trialClient);
      log('SYNC', `Validação no TEC bem-sucedida (${pastas.length} pastas encontradas).`);
    } catch (error) {
      if (error instanceof AuthError || [401, 403].includes(error.status)) {
        throw new Error('A sessão recebida não foi aceita pelo TEC. Faça login novamente no Chrome e use “Sincronizar agora” na extensão.');
      }
      logWarn('SYNC', `Aviso ao validar pastas no TEC durante sync (cookies serão salvos mesmo assim): ${error.message}`);
    }
    session.cookies = { ...session.cookies, ...trial.cookies };
    session.meta = { via: 'chrome-extension-sync', at: new Date().toISOString() };
    session.save();
  } finally {
    trial.clear();
  }
}

function sessionHelp() {
  return 'A sessão TEC sincronizada expirou ou foi substituída. Faça login no TEC pelo Chrome com a extensão instalada ou clique em “Sincronizar agora” na extensão.';
}

function errorText(error) {
  return (AuthError && error instanceof AuthError) ? sessionHelp() : `Erro: ${error.message}`;
}

// Servidor HTTP para receber sincronização direta da extensão
export const loginServer = createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };

  log('HTTP', `${req.method} ${req.url} [IP: ${clientIp}]`);

  if (req.method === 'OPTIONS' && ['/tec-login/sync', '/tec-login/pair'].includes(req.url)) {
    log('HTTP', `Respondeu CORS preflight 204 para ${req.url}`);
    res.writeHead(204, headers);
    return res.end();
  }

  if (req.method !== 'POST' || !['/tec-login/sync', '/tec-login/pair'].includes(req.url)) {
    logWarn('HTTP', `404 Rota não encontrada: ${req.method} ${req.url}`);
    res.writeHead(404, headers);
    return res.end(JSON.stringify({ error: 'Rota não encontrada.' }));
  }

  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_000) {
        logWarn('HTTP', `413 Payload excessivo (${body.length} bytes) de ${clientIp}`);
        res.writeHead(413, headers);
        return res.end(JSON.stringify({ error: 'Solicitação muito grande.' }));
      }
    }

    const payload = JSON.parse(body || '{}');

    // Suporte retrocompatível para /tec-login/pair se alguma extensão antiga chamar
    if (req.url === '/tec-login/pair') {
      log('HTTP', `POST /tec-login/pair recebido de ${clientIp} (pareamento desnecessário, respondendo OK)`);
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, message: 'Pareamento não é mais necessário. Sincronização direta ativa.' }));
    }

    if (req.url === '/tec-login/sync') {
      log('SYNC', `Recebendo cookies para sincronização direta [IP: ${clientIp}]`);
      if (typeof payload.cookies !== 'string' || payload.cookies.length > 24_000) {
        logError('SYNC', 'Payload de cookies ausente ou inválido');
        res.writeHead(400, headers);
        return res.end(JSON.stringify({ error: 'Cookies ausentes ou inválidos.' }));
      }

      await importLogin(payload.cookies);
      state.extensionSyncedAt = new Date().toISOString();
      save();
      log('SYNC', `Sessão TEC validada e sincronizada com sucesso em ${state.extensionSyncedAt}`);
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, syncedAt: state.extensionSyncedAt }));
    }
  } catch (error) {
    logError('SYNC', `Falha ao validar sessão TEC de ${clientIp}: ${error.message}`);
    res.writeHead(401, headers);
    return res.end(JSON.stringify({ error: error.message || 'Não foi possível validar a sessão TEC.' }));
  }
});

const chatKey = (id) => String(id);
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

/** Extração avançada de gabarito a partir do comentário do professor quando a API não retorna estruturado */
export function extrairGabaritoComentario(comentarioText, tipo, alternativas = []) {
  if (!comentarioText) return null;
  const isCertoErrado = tipo === 'CERTO_ERRADO' || (alternativas.length === 2 && /certo/i.test(alternativas[0]) && /errado/i.test(alternativas[1]));

  // 1. Padrão "Gabarito: Letra A", "Gabarito: Certo", "Gabarito: ERRADO", "Gabarito: B", "Resposta: E"
  const m1 = /(?:gabarito|resposta|opção|alternativa correta)\s*(?:oficial|preliminar|definitivo|do professor)?\s*(?:é|seria|foi)?\s*(?:a\s*)?[:\s\-–—]\s*(?:letra\s*)?([a-j]|certo|errado)\b/i.exec(comentarioText);
  if (m1) {
    const val = m1[1].trim();
    if (isCertoErrado) {
      if (/^c/i.test(val)) return 'Certo';
      if (/^e/i.test(val)) return 'Errado';
    }
    return val.toUpperCase();
  }

  // 2. Padrão "Letra X é a correta", "Alternativa Y está certa"
  const m2 = /(?:letra|alternativa)\s*([a-j])\s*(?:é a|está)?\s*(?:correta|certa)\b/i.exec(comentarioText);
  if (m2) return m2[1].toUpperCase();

  // 3. Padrão "X – <texto>\n\nCerta: ..."
  const m3 = /([a-j])\s*[–\-—:]\s*[^\n]+\n+\s*(?:certa|correta)\b/i.exec(comentarioText);
  if (m3) return m3[1].toUpperCase();

  // 4. Padrões específicos para Certo / Errado
  if (isCertoErrado) {
    const mCE1 = /(?:portanto|logo|assim|conclui-se que|dessa forma)[,\s]+(?:o\s*)?(?:item|assertiva|afirmativa|proposição)?\s*(?:é|está|resta)?\s*(certo|errado|correto|correta|errada|incorreto|incorreta)\b/i.exec(comentarioText);
    if (mCE1) {
      return /^(certo|corret)/i.test(mCE1[1]) ? 'Certo' : 'Errado';
    }

    const mCE2 = /\b(?:item|assertiva|afirmativa|proposição)\s*(?:é|está|resta)?\s*(certo|errado|correto|correta|errada|incorreto|incorreta)\b/i.exec(comentarioText);
    if (mCE2) {
      return /^(certo|corret)/i.test(mCE2[1]) ? 'Certo' : 'Errado';
    }
  }

  return null;
}

/** Mapeia com segurança o gabarito identificado para o índice da opção da enquete */
export function resolveGabaritoIndex(q, options = []) {
  if (!q) return -1;
  const isCertoErrado = q.tipo === 'CERTO_ERRADO' || (options.length === 2 && /certo/i.test(options[0]) && /errado/i.test(options[1]));
  const gab = q.gabarito;

  if (isCertoErrado) {
    if (typeof gab === 'string') {
      const g = gab.trim().toUpperCase();
      if (['C', 'CERTO', 'CORRETO', 'CORRETA', 'VERDADEIRO', 'V', 'A'].includes(g)) return 0;
      if (['E', 'ERRADO', 'INCORRETO', 'INCORRETA', 'FALSO', 'F', 'B'].includes(g)) return 1;
    }
    if (gab === 1) return 0;
    if (gab === 2) return 1;
  }

  // Correspondência textual direta com o texto da alternativa
  if (gab) {
    const textIdx = options.findIndex(x => x && String(x).trim().toLowerCase() === String(gab).trim().toLowerCase());
    if (textIdx >= 0) return textIdx;
  }

  // Correspondência por letra A-J
  if (typeof gab === 'string') {
    const letter = gab.trim().toUpperCase();
    if (/^[A-J]$/.test(letter)) {
      const idx = letter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return idx;
    }
  }

  // Correspondência por índice numérico 1-based
  const num = typeof gab === 'number' ? gab : /^\d+$/.test(String(gab ?? '').trim()) ? Number(gab) : NaN;
  if (Number.isInteger(num) && num >= 1 && num <= options.length) {
    return num - 1;
  }

  return -1;
}

async function loadQuestion(cid, n) {
  const item = await tecQuestionFromNotebook(cid, n);
  if (!item) return null;
  const id = item.idQuestao ?? item.id ?? item.questaoId;
  if (!id) throw new Error('O TEC retornou uma questão sem ID.');

  const [q, raw] = await Promise.all([
    api.questao(id, { comentario: true }),
    api.questaoBruta(id).catch(() => null),
  ]);

  const opcoes = q.alternativas?.length
    ? q.alternativas
    : q.tipo === 'CERTO_ERRADO' ? ['Certo', 'Errado'] : [];

  // 1. Tenta gabarito estruturado da API (se exposto pelo TEC no raw ou no item)
  const numeroRaw = raw?.numeroAlternativaCorreta ?? item.numeroAlternativaCorreta;
  const numero = typeof numeroRaw === 'number'
    ? numeroRaw
    : /^\d+$/.test(String(numeroRaw ?? '')) ? Number(numeroRaw) : NaN;
  const letraRaw = String(raw?.alternativaCorreta ?? item.alternativaCorreta ?? '').trim().toUpperCase();

  if (Number.isInteger(numero) && numero > 0 && numero <= opcoes.length) {
    q.gabarito = q.tipo === 'CERTO_ERRADO'
      ? (numero === 1 ? 'Certo' : 'Errado')
      : String.fromCharCode(64 + numero);
  } else if (/^[A-J]$/.test(letraRaw) && (letraRaw.charCodeAt(0) - 65 < opcoes.length || q.tipo === 'CERTO_ERRADO')) {
    q.gabarito = q.tipo === 'CERTO_ERRADO'
      ? (letraRaw === 'C' || letraRaw === 'A' ? 'Certo' : 'Errado')
      : letraRaw;
  } else if (q.tipo === 'CERTO_ERRADO' && /^(CERTO|ERRADO)$/.test(letraRaw)) {
    q.gabarito = letraRaw[0] + letraRaw.slice(1).toLowerCase();
  }

  // 2. Se não houver gabarito estruturado em raw/item, preserva o gabarito extraído pelo tec-agent
  // (que já analisa api.questao() e os comentários do professor)

  // 3. Se ainda assim estiver sem gabarito, executa fallback avançado de extração pelo comentário
  if (!q.gabarito && q.comentario) {
    q.gabarito = extrairGabaritoComentario(q.comentario, q.tipo, opcoes);
  }

  if (q.gabarito) {
    log('QUESTION', `Questão #${id} (nº ${n}): Gabarito identificado como "${q.gabarito}" (tipo: ${q.tipo || 'DESCONHECIDO'})`);
  } else {
    logWarn('QUESTION', `Questão #${id} (nº ${n}): Nenhum gabarito identificado no comentário ou na API`);
  }

  return q;
}

function totalFrom(item) { return Number(item?.quantidadeItens ?? item?.totalQuestoes ?? item?.quantidade ?? 0); }

async function findTotal(cid) {
  const folders = await tecFolders();
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
  const folders = await tecFolders();
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
  const folders = await tecFolders();
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

async function nextIndex(cs, chatId, userId, mode, skipped = new Set()) {
  const n = cs.total;
  const done = solvedSet(chatId, userId, cs.cadernoId);
  const available = Array.from({ length: n }, (_, i) => i + 1).filter(i => !done.has(i) && !skipped.has(i));
  if (mode === 'random') {
    return available.length ? available[Math.floor(Math.random() * available.length)] : null;
  }
  return available[0] ?? null;
}

async function showQuestion(chat, user, mode = 'next') {
  const cs = chatState(chat.id);
  if (!cs.cadernoId || !cs.total) throw new Error('Primeiro envie /caderno seguido do link direto do caderno.');

  log('QUIZ', `Buscando questão (${mode}) para chat ${chat.id}, usuário ${user.id} no caderno ${cs.cadernoId} (total: ${cs.total})`);
  const ignoradasNestaBusca = new Set();
  let n, q, options, correctId;

  while ((n = await nextIndex(cs, chat.id, user.id, mode, ignoradasNestaBusca)) !== null) {
    q = await loadQuestion(cs.cadernoId, n);
    if (!q) {
      logError('QUIZ', `Não foi possível carregar a questão nº ${n} do caderno ${cs.cadernoId}`);
      throw new Error(`Não consegui carregar a questão ${n} do caderno. Confira o link e seu login do TEC.`);
    }

    options = q.alternativas?.length ? q.alternativas : ['Certo', 'Errado'];
    correctId = resolveGabaritoIndex(q, options);

    if (correctId >= 0) {
      log('QUIZ', `Questão nº ${n} (ID #${q.id}) selecionada: gabarito "${q.gabarito}" -> opção [${correctId}] "${options[correctId]}"`);
      break;
    }

    logWarn('QUIZ', `Questão nº ${n} (ID #${q.id}) sem gabarito válido identificado. Pulando nesta busca...`);
    ignoradasNestaBusca.add(n);
  }

  if (n === null) {
    const respondidas = solvedSet(chat.id, user.id, cs.cadernoId).size;
    const resumo = ignoradasNestaBusca.size ? ` ${ignoradasNestaBusca.size} questão(ões) sem gabarito disponível foram puladas nesta busca; elas serão verificadas novamente na próxima.` : '';
    log('QUIZ', `Nenhuma questão disponível para chat ${chat.id} (${respondidas}/${cs.total} respondidas, ${ignoradasNestaBusca.size} puladas)`);
    return tg('sendMessage', {
      chat_id: chat.id,
      text: `Não há questões com gabarito disponíveis agora. Você respondeu ${respondidas}/${cs.total} no Telegram.${resumo}`
    });
  }

  if (ignoradasNestaBusca.size) {
    await tg('sendMessage', {
      chat_id: chat.id,
      text: `⏭️ ${ignoradasNestaBusca.size} questão(ões) sem gabarito estruturado foram puladas nesta busca; serão reavaliadas depois.`
    });
  }

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
    await tg('sendMessage', {
      chat_id: chat.id,
      text: `${i === 0 ? `<b>${escapeHtml(description)}</b>\n` : ''}${escapeHtml(parts[i])}`,
      parse_mode: 'HTML'
    });
  }

  const poll = await tg('sendPoll', {
    chat_id: chat.id,
    question: `Questão TEC #${q.id} — ${n}/${cs.total}`,
    options: options.map((x, i) => ({ text: `${String.fromCharCode(65 + i)}. ${x}`.slice(0, 100) })),
    type: 'quiz',
    is_anonymous: false,
    correct_option_id: correctId,
    explanation: 'Use os botões abaixo para ver o comentário ou escolher outra questão.',
    explanation_parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Ver comentário', callback_data: `c:${q.id}` }],
        [{ text: 'Próxima', callback_data: 'q:n' }, { text: 'Aleatória', callback_data: 'q:r' }]
      ]
    }
  });

  state.polls[poll.poll.id] = { chatId: chat.id, cid: cs.cadernoId, index: n, qid: q.id, answer: correctId };
  save();
  log('QUIZ', `Poll enviada com sucesso (Poll ID: ${poll.poll.id}) para chat ${chat.id}`);
}

async function handleMessage(m) {
  if (!m.text) return;
  const [cmd, ...args] = m.text.trim().split(/\s+/);
  const chat = m.chat, user = m.from;

  log('MSG', `Comando "${cmd}" recebido de ${user.id} (@${user.username || user.first_name}) no chat ${chat.id}`);

  try {
    if (cmd === '/start' || cmd.startsWith('/start@')) {
      return tg('sendMessage', {
        chat_id: chat.id,
        text: 'Bot de questões TEC. Use /lista para navegar pelos cadernos ou /caderno LINK para abrir pelo link. /proxima, /aleatoria e /status controlam seu estudo. A sincronização de sessão é direta via extensão no Chrome.'
      });
    }
    if (cmd === '/id' || cmd.startsWith('/id@')) {
      return tg('sendMessage', { chat_id: chat.id, text: `Seu ID Telegram é ${user.id}.` });
    }
    if (cmd === '/login' || cmd.startsWith('/login@')) {
      log('CMD', `/login: Informando sincronização direta sem pareamento`);
      return tg('sendMessage', {
        chat_id: chat.id,
        text: 'A sincronização da extensão TEC agora é direta e automática! Não é necessário nenhum código de pareamento.\n\nBasta instalar a extensão no Chrome/Helium e fazer login no TEC Concursos (ou clicar em "Sincronizar agora" na extensão).'
      });
    }
    if (cmd === '/caderno' || cmd.startsWith('/caderno@')) {
      const link = args.join(' ');
      const id = cadernoId(link);
      log('CMD', `/caderno: Identificado ID ${id}. Buscando total de questões...`);
      const total = await findTotal(id);
      if (!total) throw new Error('Não localizei a quantidade de questões. Confira se o caderno pertence à conta autenticada do tec-agent e se o link contém o ID numérico.');
      Object.assign(chatState(chat.id), { cadernoId: id, total, link });
      save();
      log('CMD', `/caderno: Caderno ${id} salvo para o chat ${chat.id} com ${total} questões.`);
      return tg('sendMessage', { chat_id: chat.id, text: `Caderno carregado (${total} questões). Use /proxima ou /aleatoria.` });
    }
    if (cmd === '/lista' || cmd.startsWith('/lista@')) {
      log('CMD', `/lista: Abrindo navegação de pastas para o chat ${chat.id}`);
      return browse(chat.id, null);
    }
    if (cmd === '/proxima' || cmd.startsWith('/proxima@')) {
      log('CMD', `/proxima solicitado no chat ${chat.id}`);
      return showQuestion(chat, user, 'next');
    }
    if (cmd === '/aleatoria' || cmd.startsWith('/aleatoria@')) {
      log('CMD', `/aleatoria solicitado no chat ${chat.id}`);
      return showQuestion(chat, user, 'random');
    }
    if (cmd === '/status' || cmd.startsWith('/status@')) {
      const cs = chatState(chat.id);
      const done = cs.cadernoId ? solvedSet(chat.id, user.id, cs.cadernoId).size : 0;
      log('CMD', `/status solicitado no chat ${chat.id}: ${done}/${cs.total || 0}`);
      return tg('sendMessage', {
        chat_id: chat.id,
        text: cs.total ? `Caderno ${cs.cadernoId}: ${done}/${cs.total} questões respondidas por você aqui no Telegram.` : 'Nenhum caderno carregado neste chat.'
      });
    }
  } catch (e) {
    logError('CMD', `Erro ao processar "${cmd}": ${e.message}`);
    await tg('sendMessage', { chat_id: chat.id, text: errorText(e) });
  }
}

async function handleUpdate(u) {
  if (u.message) await handleMessage(u.message);

  if (u.poll_answer) {
    const pa = u.poll_answer, p = state.polls[pa.poll_id];
    if (p && pa.user && pa.option_ids?.length) {
      const key = scoreKey(p.chatId, pa.user.id, p.cid);
      state.answers ||= {};
      state.answers[key] ||= [];
      if (!state.answers[key].includes(p.index)) state.answers[key].push(p.index);
      save();
      const ok = pa.option_ids[0] === p.answer;
      log('POLL_ANSWER', `Usuário ${pa.user.id} (${pa.user.first_name}) respondeu enquete ${pa.poll_id}. Escolheu: ${pa.option_ids[0]}, Gabarito: ${p.answer} -> ${ok ? 'ACERTOU (✅)' : 'ERROU (❌)'}`);
      await tg('sendMessage', {
        chat_id: p.chatId,
        text: `${pa.user.first_name || 'Usuário'}: ${ok ? '✅ Acertou!' : '❌ Errou.'}`
      });
    }
  }

  if (u.callback_query) {
    const cb = u.callback_query;
    log('CALLBACK', `Callback query recebido: "${cb.data}" de ${cb.from.id} no chat ${cb.message?.chat.id}`);

    if (cb.data?.startsWith('b:')) {
      try {
        const [_, action, a, b, c] = cb.data.split(':');
        if (action === 'root') await browse(cb.message.chat.id, cb.message.message_id);
        else if (action === 'folders') await showFolders(cb.message.chat.id, cb.message.message_id, a);
        else if (action === 'r') await browse(cb.message.chat.id, cb.message.message_id, { type: 'root', page: a });
        else if (action === 'f') await browse(cb.message.chat.id, cb.message.message_id, { type: 'folder', folderId: a, page: b });
        else if (action === 's') await browse(cb.message.chat.id, cb.message.message_id, { type: 'sub', folderId: a, subfolderId: b, page: c });
        else if (action === 'c') {
          const folders = await tecFolders();
          if (!folders.some(folder => String(folder.id) === String(a))) throw new Error('Pasta não encontrada.');
          const subfolderId = c && b !== '0' ? b : null;
          const caderno = c || b;
          const item = (await listAll(a, subfolderId)).find(entry => String(entry.id) === String(caderno) && !entry.subpasta);
          if (!item) throw new Error('Não encontrei esse caderno na sua conta TEC.');
          const total = totalFrom(item);
          if (!total) throw new Error('O TEC não informou quantas questões há neste caderno.');
          Object.assign(chatState(cb.message.chat.id), { cadernoId: String(item.id), total, name: item.nome });
          save();
          log('CALLBACK', `Caderno selecionado: ${item.nome} (${item.id}) com ${total} questões`);
          await tg('editMessageText', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: `Caderno selecionado: ${item.nome}\n${total} questões. Use /proxima ou /aleatoria.`
          });
        } else if (action === 'nop') { /* indicador de página */ }
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) {
        logError('CALLBACK', `Erro ao processar callback de navegação: ${e.message}`);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: errorText(e).slice(0, 180), show_alert: true });
      }
    } else if (cb.data?.startsWith('c:')) {
      try {
        log('COMMENT', `Buscando comentário da questão #${cb.data.slice(2)}...`);
        const q = await api.questao(cb.data.slice(2), { comentario: true });
        const body = q.comentario || 'O TEC não disponibilizou comentário para esta questão.';
        const chunks = body.match(/[\s\S]{1,3800}/g) || ['Sem comentário.'];
        for (const chunk of chunks) {
          await tg('sendMessage', { chat_id: cb.message.chat.id, text: chunk, reply_to_message_id: cb.message.message_id });
        }
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) {
        logError('COMMENT', `Erro ao buscar comentário: ${e.message}`);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: errorText(e).slice(0, 180), show_alert: true });
      }
    } else if (cb.data === 'q:n' || cb.data === 'q:r') {
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      try {
        await showQuestion(cb.message.chat, cb.from, cb.data === 'q:n' ? 'next' : 'random');
      } catch (e) {
        logError('QUIZ', `Erro ao carregar questão via botão: ${e.message}`);
        await tg('sendMessage', { chat_id: cb.message.chat.id, text: errorText(e) });
      }
    }
  }
}

export async function start() {
  if (!token) throw new Error('Defina TELEGRAM_BOT_TOKEN.');
  const loginPort = Number(process.env.BOT_LOGIN_PORT || 8088);
  await new Promise((resolve, reject) => {
    loginServer.once('error', reject);
    loginServer.listen(loginPort, '127.0.0.1', resolve);
  });

  save();
  log('STARTUP', `Bot Telegram TEC iniciado com sucesso.`);
  log('STARTUP', `Node.js: ${process.version} | PID: ${process.pid} | Plataforma: ${process.platform}`);
  log('STARTUP', `Servidor HTTP de sincronização escutando em 127.0.0.1:${loginPort}`);
  log('STARTUP', `Arquivo de estado do bot: ${stateFile}`);
  log('STARTUP', `Iniciando loop de polling do Telegram...`);

  while (true) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'poll_answer', 'callback_query'] });
      if (updates.length > 0) {
        log('POLL', `Recebidas ${updates.length} atualização(ões) do Telegram`);
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (e) {
      logError('POLL', `Erro no polling do Telegram: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

if (!process.env.BOT_SKIP_START) {
  start().catch((err) => {
    logError('FATAL', `Falha crítica ao executar o bot: ${err.message}`);
    process.exit(1);
  });
}
