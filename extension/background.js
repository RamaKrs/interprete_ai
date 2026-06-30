const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// FIX: isCapturing was referenced in GET_STATE handler but never declared
let isCapturing = false;

async function ensureOffscreenDocument() {
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
        
        const response = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId: message.streamId,
          target: 'offscreen'
        });

        isCapturing = true;
        sendResponse({ success: true });
      } catch (err) {
        console.error('SW error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
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
      isCapturing = false;
      sendResponse({ success: true });
    })();
    return true;
  }
});
