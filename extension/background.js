// El SW orquesta: crea el offscreen document y le pasa el streamId.
// El SW puede vivir indefinidamente gracias al offscreen activo.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.() ?? false;
  // En versiones anteriores de la API, verificamos con getContexts
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL]
  });
  
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Captura de audio de pestaña para transcripción STT en tiempo real'
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    sendResponse({ isCapturing });
    return false;
  }

  if (message.type === 'START_CAPTURE') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        
        // Esperar a que el offscreen esté listo y pasarle el streamId
        const response = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId: message.streamId,
          target: 'offscreen'  // para distinguir destinos
        });
        
        sendResponse({ success: true });
      } catch (err) {
        console.error('SW error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // mantiene el canal abierto para sendResponse async
  }

  if (message.type === 'STOP_CAPTURE') {
    (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (contexts.length > 0) {
        await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_STOP',
          target: 'offscreen'
        });
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});