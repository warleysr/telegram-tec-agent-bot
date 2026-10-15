import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Defina TELEGRAM_BOT_TOKEN.');
const tecDir = process.env.TEC_AGENT_DIR || path.join(os.homedir(), '.tec-agent');
const agentRoot = process.env.TEC_AGENT_ROOT || path.join(os.homedir(), 'tec-agent');
const { TecClient, Session } = await import(pathToFileURL(path.join(agentRoot, 'src/client.mjs')));
const { TecApi } = await import(pathToFileURL(path.join(agentRoot, 'src/api.mjs')));
const api = new TecApi(new TecClient({ session: Session.load(path.join(tecDir, 'session.json')) }));
const base = `https://api.telegram.org/bot${token}`;
const stateFile = path.resolve(process.env.BOT_DATA_DIR || '.', 'bot-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { chats: {}, polls: {} };
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
const chatKey = (id) => String(id);
const userKey = (id) => String(id);
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function clean(s = '') { return String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim(); }
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
  return api.questao(id, { comentario: true });
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
function chatState(chatId) { return state.chats[chatKey(chatId)] ||= {}; }
function scoreKey(chatId, userId, cid) { return `${chatId}:${userId}:${cid}`; }
function solvedSet(chatId, userId, cid) { return new Set(state.answers?.[scoreKey(chatId, userId, cid)] || []); }
async function nextIndex(cs, chatId, userId, mode) {
  const n = cs.total;
  if (mode === 'random') {
    const done = solvedSet(chatId, userId, cs.cadernoId);
    const available = Array.from({ length: n }, (_, i) => i + 1).filter(i => !done.has(i));
    return available.length ? available[Math.floor(Math.random() * available.length)] : null;
  }
  const done = solvedSet(chatId, userId, cs.cadernoId);
  for (let i = 1; i <= n; i++) if (!done.has(i)) return i;
  return null;
}
async function showQuestion(chat, user, mode = 'next') {
  const cs = chatState(chat.id);
  if (!cs.cadernoId || !cs.total) throw new Error('Primeiro envie /caderno seguido do link direto do caderno.');
  const n = await nextIndex(cs, chat.id, user.id, mode);
  if (n === null) return tg('sendMessage', { chat_id: chat.id, text: 'Você já respondeu todas as questões deste caderno no Telegram.' });
  const q = await loadQuestion(cs.cadernoId, n);
  if (!q) throw new Error(`Não consegui carregar a questão ${n} do caderno. Confira o link e seu login do TEC.`);
  const options = q.alternativas?.length ? q.alternativas : ['Certo', 'Errado'];
  const correct = q.gabarito;
  const correctId = options.findIndex((x, i) => x === correct || (String(correct).toUpperCase() === String.fromCharCode(65 + i)));
  if (correctId < 0) throw new Error(`Não foi possível identificar o gabarito da questão ${q.id}; quiz não enviado para evitar correção incorreta.`);
  const prompt = `${q.enunciado || '(sem enunciado)'}${q.materia?.nome ? `\n\n${q.materia.nome}` : ''}${q.banca ? ` • ${q.banca}` : ''}${q.ano ? ` • ${q.ano}` : ''}`;
  await tg('sendMessage', { chat_id: chat.id, text: prompt });
  const poll = await tg('sendPoll', { chat_id: chat.id, question: `Questão TEC #${q.id} — ${n}/${cs.total}`, options: options.map((x, i) => ({ text: `${String.fromCharCode(65 + i)}. ${x}`.slice(0, 100) })), type: 'quiz', is_anonymous: false, correct_option_id: correctId, explanation: 'Use o botão abaixo para ver o comentário do professor.', explanation_parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Ver comentário', callback_data: `c:${q.id}` }]] } });
  state.polls[poll.poll.id] = { chatId: chat.id, cid: cs.cadernoId, index: n, qid: q.id, answer: correctId };
  save();
}
async function handleMessage(m) {
  if (!m.text) return;
  const [cmd, ...args] = m.text.trim().split(/\s+/);
  const chat = m.chat, user = m.from;
  try {
    if (cmd === '/start' || cmd.startsWith('/start@')) return tg('sendMessage', { chat_id: chat.id, text: 'Bot de questões TEC. Use /caderno LINK para iniciar, /proxima para a próxima não respondida, /aleatoria para uma questão aleatória e /status para ver o progresso. Em grupos, cada pessoa tem seu próprio histórico.' });
    if (cmd === '/caderno' || cmd.startsWith('/caderno@')) {
      const id = cadernoId(args.join(' '));
      const total = await findTotal(id);
      if (!total) throw new Error('Não localizei a quantidade de questões. Confira se o caderno pertence à conta autenticada do tec-agent e se o link contém o ID numérico.');
      Object.assign(chatState(chat.id), { cadernoId: id, total, link: args.join(' ') }); save();
      return tg('sendMessage', { chat_id: chat.id, text: `Caderno carregado (${total} questões). Use /proxima ou /aleatoria.` });
    }
    if (cmd === '/proxima' || cmd.startsWith('/proxima@')) return showQuestion(chat, user, 'next');
    if (cmd === '/aleatoria' || cmd.startsWith('/aleatoria@')) return showQuestion(chat, user, 'random');
    if (cmd === '/status' || cmd.startsWith('/status@')) {
      const cs = chatState(chat.id); const done = cs.cadernoId ? solvedSet(chat.id, user.id, cs.cadernoId).size : 0;
      return tg('sendMessage', { chat_id: chat.id, text: cs.total ? `Caderno ${cs.cadernoId}: ${done}/${cs.total} questões respondidas por você aqui no Telegram.` : 'Nenhum caderno carregado neste chat.' });
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
    if (cb.data?.startsWith('c:')) {
      try {
        const q = await api.questao(cb.data.slice(2), { comentario: true });
        const body = q.comentario || 'O TEC não disponibilizou comentário para esta questão.';
        const chunks = body.match(/[\s\S]{1,3800}/g) || ['Sem comentário.'];
        for (const chunk of chunks) await tg('sendMessage', { chat_id: cb.message.chat.id, text: chunk, reply_to_message_id: cb.message.message_id });
        await tg('answerCallbackQuery', { callback_query_id: cb.id });
      } catch (e) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: e.message.slice(0, 180), show_alert: true }); }
    }
  }
}
console.log(`Bot iniciado. Estado: ${stateFile}`);
while (true) {
  try {
    const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'poll_answer', 'callback_query'] });
    for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
  } catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 3000)); }
}

