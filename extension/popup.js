const API_BASE = 'https://blackgroup.com.br/tec-login';
const statusEl = document.getElementById('status');
const pairingEl = document.getElementById('pairing');
const codeEl = document.getElementById('code');
const pairButton = document.getElementById('pair');
const syncButton = document.getElementById('sync');

function showStatus(message) { statusEl.textContent = message; }

async function refreshUI() {
  const { deviceToken, syncedAt, lastError } = await chrome.storage.local.get(['deviceToken', 'syncedAt', 'lastError']);
  pairingEl.hidden = Boolean(deviceToken);
  syncButton.hidden = !deviceToken;
  if (lastError) showStatus(`Último aviso: ${lastError}`);
  else if (syncedAt) showStatus(`Sessão validada e sincronizada em ${new Date(syncedAt).toLocaleString()}.`);
  else if (deviceToken) showStatus('Extensão pareada. Ainda não há sincronização validada.');
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
    await chrome.storage.local.set({ deviceToken: result.token, lastError: '' });
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
