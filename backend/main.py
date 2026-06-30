import os
os.add_dll_directory(r"C:\interprete_ai\venv\Lib\site-packages\nvidia\cublas\bin")

import asyncio
import websockets
import json
import time
import threading
import queue
import numpy as np
import torch
from http.server import BaseHTTPRequestHandler, HTTPServer
from faster_whisper import WhisperModel
from transformers import MarianMTModel, MarianTokenizer

# ─────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────
MODEL_SIZE          = "medium"
USE_GPU             = True
DASHBOARD_PORT      = 8766
WS_PORT             = 8765

# CAMBIO: ya no transcribimos un archivo que crece sin límite. Mantenemos
# una ventana chica en memoria y la deslizamos hacia adelante.
SAMPLE_RATE          = 16000  # debe coincidir con STT_SAMPLE_RATE en offscreen.js
TRANSCRIBE_INTERVAL  = 0.6    # cada cuánto re-transcribimos (antes: 2.5s)
WINDOW_SECONDS       = 8.0    # cuánto contexto mantenemos para el modelo
STABILITY_MARGIN     = 1.5    # un segmento debe terminar esto detrás del borde
                              # en vivo para considerarse "definitivo"
COMMIT_OVERLAP       = 1.0    # contexto que conservamos después de confirmar
MAX_WINDOW_SECONDS   = 15.0   # válvula de seguridad si nos quedamos atrás

# ─────────────────────────────────────────────
# MODEL
# ─────────────────────────────────────────────
device  = "cuda" if USE_GPU else "cpu"
compute = "float16" if USE_GPU else "int8"

print(f"[main] Loading model '{MODEL_SIZE}' on {device.upper()}...")
model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute)
print("[main] Model ready.")

# ─────────────────────────────────────────────
# TRANSLATION MODELS
# Modelos locales Opus-MT (Helsinki-NLP), uno por dirección. Corren con
# transformers/PyTorch — un stack distinto al de faster-whisper (CTranslate2),
# así que es una dependencia nueva: pip install transformers torch sentencepiece
# Se descargan una sola vez desde Hugging Face en el primer arranque; después
# de eso, todo corre local — ninguna conversación sale de la máquina.
# ─────────────────────────────────────────────
TRANSLATION_MODELS = {
    "en": "Helsinki-NLP/opus-mt-en-es",  # traduce DESDE inglés HACIA español
    "es": "Helsinki-NLP/opus-mt-es-en",  # traduce DESDE español HACIA inglés
}

print("[main] Loading translation models...")
translators = {}
for src_lang, model_name in TRANSLATION_MODELS.items():
    tok = MarianTokenizer.from_pretrained(model_name)
    mdl = MarianMTModel.from_pretrained(model_name).to(device)
    mdl.eval()
    translators[src_lang] = (tok, mdl)
print("[main] Translation models ready.")


def translate(text: str, source_lang: str):
    """
    Traduce text desde source_lang hacia el otro idioma del par.
    Devuelve None si no tenemos modelo para ese idioma (por ejemplo, si
    Whisper detectó algo que no sea 'en' o 'es') — el dashboard simplemente
    no muestra traducción en esa línea, en vez de mostrar algo incorrecto.
    """
    pair = translators.get(source_lang)
    if pair is None or not text.strip():
        return None

    tokenizer, trans_model = pair
    batch = tokenizer([text], return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        generated = trans_model.generate(**batch, max_new_tokens=256)
    return tokenizer.decode(generated[0], skip_special_tokens=True)

# ─────────────────────────────────────────────
# SSE BROKER
# Holds a list of active SSE client queues.
# When a transcript arrives, it's pushed to all queues.
# ─────────────────────────────────────────────
sse_clients = []
sse_lock    = threading.Lock()

def broadcast(text: str, language: str, translated: str = None):
    """Push a transcript segment (+ optional translation) to all SSE clients."""
    payload = json.dumps({"text": text, "language": language, "translated": translated})
    with sse_lock:
        dead = []
        for q in sse_clients:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            sse_clients.remove(q)

# ─────────────────────────────────────────────
# DASHBOARD HTTP SERVER
# GET  /           → serves dashboard.html
# GET  /events     → SSE stream for live transcripts
# ─────────────────────────────────────────────
DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))

class DashboardHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path in ('/', '/dashboard', '/dashboard.html'):
            self._serve_file('dashboard.html', 'text/html')

        elif self.path == '/events':
            self._serve_sse()

        else:
            self.send_response(404)
            self.end_headers()

    def _serve_file(self, filename, content_type):
        filepath = os.path.join(DASHBOARD_DIR, filename)
        try:
            with open(filepath, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(data))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()

    def _serve_sse(self):
        """Keep connection open, stream transcript events as SSE."""
        self.send_response(200)
        self.send_header('Content-Type',  'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection',    'keep-alive')
        # Allow dashboard served from any origin
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        q = queue.Queue()
        with sse_lock:
            sse_clients.append(q)

        try:
            # Send a heartbeat comment every 15s to keep the connection alive
            while True:
                try:
                    payload = q.get(timeout=15)
                    msg = f"data: {payload}\n\n"
                except queue.Empty:
                    msg = ": heartbeat\n\n"   # SSE comment, ignored by browser

                self.wfile.write(msg.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with sse_lock:
                if q in sse_clients:
                    sse_clients.remove(q)

    def log_message(self, *args):
        pass  # silence HTTP logs


def start_dashboard_server():
    server = HTTPServer(('localhost', DASHBOARD_PORT), DashboardHandler)
    print(f"[main] Dashboard → http://localhost:{DASHBOARD_PORT}")
    server.serve_forever()

threading.Thread(target=start_dashboard_server, daemon=True).start()

# ─────────────────────────────────────────────
# WEBSOCKET HANDLER
# Receives audio from the Chrome extension,
# transcribes with Whisper, broadcasts via SSE.
# ─────────────────────────────────────────────
async def handler(websocket):
    client_id = id(websocket)
    print(f"[main] Extension connected: {client_id}")

    # CAMBIO: ya no hay bytearray ni archivo en disco. `buffer` es la ventana
    # de audio en memoria; `buffer_start_time` es el instante absoluto (en
    # segundos desde que arrancó la sesión) al que corresponde buffer[0].
    # Esto nos deja comparar timestamps de Whisper entre pasadas distintas,
    # algo que el conteo de segmentos de antes no podía hacer.
    buffer            = np.zeros(0, dtype=np.float32)
    buffer_start_time = 0.0
    committed_until   = 0.0   # hasta qué instante absoluto ya transmitimos texto
    last_transcribe   = time.time()

    def run_pass(buf, buf_start, committed, final=False):
        """
        Transcribe la ventana actual y devuelve (texto_nuevo_emitido,
        nuevo_committed_until). Si final=True (la conexión se está
        cerrando) trata todo lo que quede como definitivo, sin esperar
        el margen de estabilidad.
        """
        try:
            segments, info = model.transcribe(
                buf,
                beam_size=1,
                language=None,     # se re-detecta en cada pasada, sobre la
                                    # ventana reciente — no sobre audio viejo
                vad_filter=True,
            )
            segments = list(segments)
        except Exception as e:
            print(f"[main] Transcription error (skipping): {e}")
            return committed

        now = buf_start + len(buf) / SAMPLE_RATE
        commit_boundary = now if final else now - STABILITY_MARGIN
        newly_committed = committed

        for seg in segments:
            abs_end = buf_start + seg.end
            if abs_end <= commit_boundary and abs_end > committed:
                text = seg.text.strip()
                if text:
                    lang = info.language or "auto"
                    translated = translate(text, lang)
                    print(f"[{lang}] {text}" + (f"  →  {translated}" if translated else ""))
                    broadcast(text, lang, translated)
                newly_committed = max(newly_committed, abs_end)

        return newly_committed

    try:
        async for message in websocket:

            # Reservado para futuros mensajes de control (JSON)
            if isinstance(message, str):
                continue

            try:
                chunk = np.frombuffer(message, dtype=np.float32)
            except Exception as e:
                print(f"[main] Bad PCM chunk (skipping): {e}")
                continue

            buffer = np.concatenate([buffer, chunk])

            if time.time() - last_transcribe < TRANSCRIBE_INTERVAL:
                continue
            last_transcribe = time.time()

            # Necesitamos al menos ~1s de audio para que valga la pena
            if len(buffer) < SAMPLE_RATE * 1.0:
                continue

            # ── Válvula de seguridad ──────────────────────
            # Si nos quedamos atrás (GPU saturada, picos de carga), preferimos
            # saltar audio viejo a dejar que la ventana crezca sin límite de
            # nuevo. Esto SÍ puede perder algo de habla — es la contrapartida
            # consciente de nunca dejar que el costo por pasada vuelva a ser
            # proporcional a toda la sesión.
            if len(buffer) / SAMPLE_RATE > MAX_WINDOW_SECONDS:
                drop = len(buffer) - int(WINDOW_SECONDS * SAMPLE_RATE)
                print(f"[main] {client_id}: falling behind, dropping {drop/SAMPLE_RATE:.1f}s")
                buffer            = buffer[drop:]
                buffer_start_time += drop / SAMPLE_RATE
                committed_until   = max(committed_until, buffer_start_time)

            committed_until = run_pass(buffer, buffer_start_time, committed_until)

            # Recortamos todo lo ya confirmado, dejando un poco de contexto
            # de superposición para que la próxima pasada no arranque "en frío".
            trim_to      = max(buffer_start_time, committed_until - COMMIT_OVERLAP)
            drop_samples = int((trim_to - buffer_start_time) * SAMPLE_RATE)
            if drop_samples > 0:
                buffer            = buffer[drop_samples:]
                buffer_start_time = trim_to

    except websockets.exceptions.ConnectionClosed as e:
        print(f"[main] Extension disconnected: {client_id} (code {e.code})")
    except Exception as e:
        print(f"[main] Unexpected error: {e}")
    finally:
        # Flush final: lo que quedó en la ventana todavía no cruzó el margen
        # de estabilidad, pero la sesión terminó — no hay "borde en vivo" que
        # esperar, así que lo tratamos como definitivo en vez de perderlo.
        if len(buffer) > 0:
            run_pass(buffer, buffer_start_time, committed_until, final=True)
        print(f"[main] Cleaned up: {client_id}")


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
async def main():
    print(f"[main] WebSocket → ws://localhost:{WS_PORT}")
    async with websockets.serve(
        handler,
        "localhost",
        WS_PORT,
        max_size=10 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=60,
    ):
        print("[main] Ready.\n")
        await asyncio.Future()

asyncio.run(main())