const API_BASE = 'https://blackgroup.com.br/tec-login';
const TEC_DOMAIN = 'tecconcursos.com.br';
let syncTimer;
let syncRunning = false;
let syncAgain = false;
let lastRememberMeValue = '';

async function currentCookieHeader() {
  const cookies = await chrome.cookies.getAll({ domain: TEC_DOMAIN });
  const header = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (!cookies.some(cookie => cookie.name === 'TecPermanecerLogado' || cookie.name === 'JSESSIONID')) {
    throw new Error('Não encontrei cookie de sessão. Entre no TEC nesta instalação do Chrome e tente novamente.');
  }
  return header;
}

async function syncSession() {
  const cookies = await currentCookieHeader();
  const response = await fetch(`${API_BASE}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookies }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Falha ao sincronizar (HTTP ${response.status}).`);
  const syncedAt = new Date().toISOString();
  await chrome.storage.local.set({ syncedAt, lastError: '' });
  return syncedAt;
}

async function syncAfterCookieChange() {
  if (syncRunning) { syncAgain = true; return; }
  syncRunning = true;
  try {
    await syncSession();
  } catch (error) {
    await chrome.storage.local.set({ lastError: error.message });
  } finally {
    syncRunning = false;
    if (syncAgain) {
      syncAgain = false;
      queueSync();
    }
  }
}

function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void syncAfterCookieChange(), 3000);
}

chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (removed) return;
  const domain = cookie.domain.replace(/^\./, '');
  if (!domain.endsWith('tecconcursos.com.br')) return;
  if (cookie.name !== 'TecPermanecerLogado' || !cookie.value) return;
  if (cookie.value === lastRememberMeValue) return;
  lastRememberMeValue = cookie.value;
  queueSync();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'syncNow') return;
  syncSession()
    .then(syncedAt => sendResponse({ ok: true, syncedAt }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

// Abre aba de status/sincronização ao clicar no ícone da extensão
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});
