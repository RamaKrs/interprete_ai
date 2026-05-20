// Este contexto vive indefinidamente.
// Aquí van: getUserMedia, MediaRecorder, WebSocket.

let mediaRecorder = null;
let stream = null;
let ws = null;
let reconnectTimer = null;
const WS_URL = 'ws://localhost:8765';

// ------- WebSocket con reconexión automática -------

function connectWebSocket(onReady) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    onReady?.();
    return;
  }

  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[offscreen] WebSocket conectado');
    clearTimeout(reconnectTimer);
    onReady?.();
  };

  ws.onclose = (e) => {
    console.warn('[offscreen] WebSocket cerrado, reconectando en 3s...', e.code);
    reconnectTimer = setTimeout(() => connectWebSocket(), 3000);
  };

  ws.onerror = (err) => {
    console.error('[offscreen] WebSocket error:', err);
  };
}

// ------- Captura de audio -------

async function startCapture(streamId) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // Bifurcación de audio
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);

    // Rama 1 → speakers (seguís escuchando)
    source.connect(audioContext.destination);

    // Rama 2 → MediaRecorder → WebSocket
    const destination = audioContext.createMediaStreamDestination();
    source.connect(destination);

    connectWebSocket(() => {
      startMediaRecorder(destination.stream); // ← stream clonado, no el original
    });

    return { success: true };
  } catch (err) {
    console.error('[offscreen] getUserMedia error:', err);
    return { success: false, error: err.message };
  }
}

function startMediaRecorder(audioStream) {
  // Elegir el mejor codec disponible
  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) ?? '';

  mediaRecorder = new MediaRecorder(audioStream, {
    mimeType,
    audioBitsPerSecond: 128000
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
      // Enviar chunk binario al backend Python
      event.data.arrayBuffer().then(buffer => {
        ws.send(buffer);
      });
    }
  };

  mediaRecorder.onstart = () => console.log('[offscreen] MediaRecorder iniciado');
  mediaRecorder.onerror = (e) => console.error('[offscreen] MediaRecorder error:', e);

  // timeslice de 250ms = buena latencia para STT en tiempo real
  mediaRecorder.start(250);
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  if (ws) {
    clearTimeout(reconnectTimer);
    ws.close();
  }
  mediaRecorder = null;
  stream = null;
  ws = null;
}

// ------- Listener de mensajes -------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Filtrar solo mensajes dirigidos al offscreen
  if (message.target !== 'offscreen') return false;

  if (message.type === 'OFFSCREEN_START') {
    startCapture(message.streamId).then(sendResponse);
    return true;
  }

  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }
});

console.log('[offscreen] Contexto offscreen listo');