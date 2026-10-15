const API_BASE = 'https://blackgroup.com.br/tec-login';
const statusEl = document.getElementById('status');
const codeEl = document.getElementById('code');
const pairButton = document.getElementById('pair');
const syncButton = document.getElementById('sync');

function showStatus(message) { statusEl.textContent = message; }

async function refreshUI() {
  try {
    const { deviceToken, syncedAt, lastError } = await chrome.storage.local.get(['deviceToken', 'syncedAt', 'lastError']);
    syncButton.hidden = !deviceToken;
    if (lastError) showStatus(`Último aviso: ${lastError}`);
    else if (syncedAt) showStatus(`Pareada. Sessão validada em ${new Date(syncedAt).toLocaleString()}.`);
    else if (deviceToken) showStatus('Extensão pareada. Clique em “Sincronizar agora” ou informe um novo código abaixo.');
    else showStatus('Ainda não pareada. Envie /login ao bot e informe o código acima.');
  } catch (error) {
    showStatus(`Não consegui ler o estado da extensão: ${error.message}`);
  }
}

async function pairAndSync() {
  const code = codeEl.value.trim();
  if (!code) { showStatus('Cole primeiro o código recebido do bot.'); return; }
  pairButton.disabled = true;
  showStatus('Pareando a extensão com o bot…');
  try {
    const response = await fetch(`${API_BASE}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Falha no pareamento (HTTP ${response.status}).`);
    if (!result.token) throw new Error('O servidor não retornou o token de pareamento. Envie /login ao bot novamente.');
    await chrome.storage.local.set({ deviceToken: result.token, lastError: '' });
    codeEl.value = '';
    await refreshUI();
    await syncNow();
  } catch (error) { showStatus(error.message); }
  finally { pairButton.disabled = false; }
}

async function syncNow() {
  syncButton.disabled = true;
  showStatus('Enviando e validando a sessão no TEC…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'syncNow' });
    if (!response?.ok) throw new Error(response?.error || 'Não consegui sincronizar.');
    showStatus(`Sessão validada e sincronizada em ${new Date(response.syncedAt).toLocaleString()}.`);
  } catch (error) { showStatus(error.message); }
  finally { syncButton.disabled = false; }
}

pairButton.addEventListener('click', pairAndSync);
syncButton.addEventListener('click', syncNow);

refreshUI();
