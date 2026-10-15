const statusEl = document.getElementById('status');
const syncButton = document.getElementById('sync');

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : 'status-info';
}

async function refreshUI() {
  try {
    const { syncedAt, lastError } = await chrome.storage.local.get(['syncedAt', 'lastError']);
    if (lastError) {
      showStatus(`Último aviso: ${lastError}`, 'error');
    } else if (syncedAt) {
      showStatus(`✅ Sessão validada e sincronizada com sucesso em ${new Date(syncedAt).toLocaleString()}.`, 'success');
    } else {
      showStatus('Pronto para sincronizar diretamente. Faça login no TEC e clique no botão acima se desejar validar imediatamente.', 'info');
    }
  } catch (error) {
    showStatus(`Não consegui ler o estado da extensão: ${error.message}`, 'error');
  }
}

async function syncNow() {
  syncButton.disabled = true;
  showStatus('Enviando e validando a sessão no TEC…', 'info');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'syncNow' });
    if (!response?.ok) throw new Error(response?.error || 'Não consegui sincronizar.');
    showStatus(`✅ Sessão validada e sincronizada com sucesso em ${new Date(response.syncedAt).toLocaleString()}!`, 'success');
  } catch (error) {
    showStatus(`Erro: ${error.message}`, 'error');
  } finally {
    syncButton.disabled = false;
  }
}

syncButton.addEventListener('click', syncNow);
refreshUI();
