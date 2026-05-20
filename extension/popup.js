// El popup SOLO gestiona el user gesture y obtiene el streamId.
// No hace captura ni WebSocket.

async function init() {
  const { isCapturing } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  document.getElementById('startBtn').disabled = isCapturing;
  document.getElementById('stopBtn').disabled = !isCapturing;
  document.getElementById('status').textContent = isCapturing ? '🔴 Capturando...' : 'Listo';
}

init();

document.getElementById('startBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Iniciando...';

  try {
    // Esto REQUIERE user gesture y pestaña activa — perfecto para popup
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { consumerTabId: chrome.devtools?.inspectedWindow?.tabId ?? undefined },
        (id) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(id);
        }
      );
    });

    // Delegamos todo al service worker
    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId: streamId
    });

    if (response?.success) {
      status.textContent = '🔴 Capturando...';
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').disabled = false;
    } else {
      status.textContent = 'Error: ' + (response?.error ?? 'desconocido');
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  document.getElementById('status').textContent = 'Detenido';
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
});