"""
transcriber.py — Módulo de transcripción reutilizable.

Este archivo no es usado directamente por main.py en esta versión,
pero está disponible si querés modularizar o testear la transcripción
de forma independiente (por ejemplo, desde un script de prueba).

CAMBIO respecto a la versión anterior:
- Antes cargaba el modelo en CPU con compute_type="int8"
- Ahora usa GPU (CUDA) con compute_type="float16"
- Se agrega soporte a vad_filter para ignorar silencios
"""

from faster_whisper import WhisperModel
import numpy as np

# ─────────────────────────────────────────────
# MODELO — se instancia una sola vez al importar el módulo
# ─────────────────────────────────────────────
# CAMBIO: device="cpu" → device="cuda"
#         compute_type="int8" → compute_type="float16"
# Esto usa tu GPU NVIDIA y reduce el tiempo de transcripción
# de ~3-8s (CPU) a ~0.3-0.8s (GPU) por chunk de audio.
model = WhisperModel(
    "small",           # "tiny" | "base" | "small" | "medium"
    device="cuda",
    compute_type="float16"
)


def transcribe(audio: np.ndarray, language: str = None, translate: bool = False) -> str:
    """
    Transcribe un array de audio (numpy) y devuelve el texto.

    Args:
        audio:     Array numpy con las muestras de audio.
        language:  Forzar idioma ("es", "en", None=autodetectar).
        translate: Si True, traduce al inglés automáticamente.

    Returns:
        Texto transcripto como string.
    """

    # Convertir a mono si viene en estéreo
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Asegurar float32
    audio = audio.astype(np.float32)

    # Normalizar si viene en int16 (rango -32768 a 32767 → -1.0 a 1.0)
    if np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0

    task = "translate" if translate else "transcribe"

    segments, info = model.transcribe(
        audio,
        beam_size=1,       # greedy decoding: el más rápido
        task=task,
        language=language, # None = autodetectar entre español e inglés
        vad_filter=True,   # CAMBIO: filtra silencios → menos tokens, más velocidad
    )

    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()
