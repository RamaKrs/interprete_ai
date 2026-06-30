// offscreen.js — Captura audio crudo (PCM) y lo transmite al backend.
//
// CAMBIO respecto a la versión anterior:
// - Se reemplaza MediaRecorder (webm/opus) por un AudioWorkletNode que
//   entrega muestras PCM crudas en mono a 16kHz — el formato que Whisper
//   espera directamente. Esto elimina la necesidad de decodificar un
//   contenedor de audio en el backend en cada pasada de transcripción.
// - Se usa un AudioContext separado a 16kHz solo para la captura STT,
//   distinto del contexto de reproducción, para no degradar el audio
//   que el usuario escucha por los parlantes.
// - El overlay visual y el manejo de mensajes WS entrantes quedan igual
//   que antes — el backend sigue mandando texto plano por WebSocket.

let stream = null;
let playbackContext = null;
let sttContext = null;
let workletNode = null;
let ws = null;
let reconnectTimer = null;
const WS_URL = 'ws://localhost:8765';
const STT_SAMPLE_RATE = 16000; // lo que espera faster-whisper

// ─────────────────────────────────────────────
// OVERLAY — muestra las transcripciones en pantalla
// ─────────────────────────────────────────────
let overlayDiv = null;
let transcriptLines = [];
const MAX_LINES = 6; // cuántas líneas mostrar a la vez

function getOrCreateOverlay() {
  if (overlayDiv) return overlayDiv;

  overlayDiv = document.createElement('div');
  overlayDiv.id = 'stt-overlay';
  overlayDiv.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 16px;
    line-height: 1.5;
    padding: 12px 20px;
    border-radius: 10px;
    max-width: 700px;
    width: 90vw;
    z-index: 2147483647;
    text-align: center;
    pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    transition: opacity 0.3s ease;
  `;
  document.body.appendChild(overlayDiv);
  return overlayDiv;
}

function showTranscription(text) {
  const overlay = getOrCreateOverlay();
  transcriptLines.push(text);
  if (transcriptLines.length > MAX_LINES) {
    transcriptLines.shift(); // elimina la línea más vieja
  }
  overlay.textContent = transcriptLines.join(' ');
  overlay.style.opacity = '1';
}

// ─────────────────────────────────────────────
// WEBSOCKET — sin cambios respecto a la versión anterior
// ─────────────────────────────────────────────
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

  ws.onmessage = (event) => {
    const text = event.data;
    if (typeof text === 'string' && text.trim()) {
      console.log('[offscreen] Transcripción recibida:', text);
      showTranscription(text);
    }
  };

  ws.onclose = (e) => {
    console.warn('[offscreen] WebSocket cerrado, reconectando en 3s...', e.code);
    reconnectTimer = setTimeout(() => connectWebSocket(), 3000);
  };

  ws.onerror = (err) => {
    console.error('[offscreen] WebSocket error:', err);
  };
}

// ─────────────────────────────────────────────
// CAPTURA DE AUDIO — PCM crudo vía AudioWorklet
// ─────────────────────────────────────────────
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

    // Contexto de reproducción — calidad completa, lo que el usuario escucha.
    // No tiene nada que ver con la captura STT.
    playbackContext = new AudioContext();
    const playbackSource = playbackContext.createMediaStreamSource(stream);
    playbackSource.connect(playbackContext.destination);

    // Contexto de captura STT — corre a 16kHz para que el navegador haga
    // el resampleo por nosotros. Nunca llega a los parlantes.
    sttContext = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    console.log('[offscreen] STT context corriendo a', sttContext.sampleRate, 'Hz... Si esto loguea 48000 en lugar de 16000, Chrome no está honrando', );
    // ↑ Si esto loguea 48000 en lugar de 16000, Chrome no está honrando el
    // sampleRate pedido para este tipo de stream — avisame y resampleamos
    // del lado del backend en vez de confiar en esto.

    await sttContext.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));

    const sttSource = sttContext.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(sttContext, 'pcm-capture');

    workletNode.port.onmessage = (event) => {
      const chunk = event.data; // Float32Array mono a 16kHz
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(chunk.buffer);
      }
    };

    // El worklet solo se sigue ejecutando si está en un camino activo del
    // grafo de audio. Lo conectamos a través de una ganancia en cero para
    // que nunca suene, en vez de dejarlo desconectado.
    const muteGain = sttContext.createGain();
    muteGain.gain.value = 0;

    sttSource.connect(workletNode);
    workletNode.connect(muteGain);
    muteGain.connect(sttContext.destination);

    connectWebSocket(() => {
      console.log('[offscreen] Streaming de PCM activo');
    });

    return { success: true };
  } catch (err) {
    console.error('[offscreen] getUserMedia error:', err);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
// STOP — limpieza + ocultar overlay
// ─────────────────────────────────────────────
function stopCapture() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sttContext) {
    sttContext.close();
    sttContext = null;
  }
  if (playbackContext) {
    playbackContext.close();
    playbackContext = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (ws) {
    clearTimeout(reconnectTimer);
    ws.close();
    ws = null;
  }
  if (overlayDiv) {
    overlayDiv.remove();
    overlayDiv = null;
    transcriptLines = [];
  }
}

// ─────────────────────────────────────────────
// LISTENER DE MENSAJES — sin cambios
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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