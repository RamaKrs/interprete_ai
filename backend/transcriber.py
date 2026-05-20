from faster_whisper import WhisperModel
import numpy as np

model = WhisperModel(
    "base",
    device="cpu",
    compute_type="int8"
)

def transcribe(audio):

    audio = np.array(audio)

    # convertir a mono si viene stereo
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # convertir a float32
    audio = audio.astype(np.float32)

    # normalizar si viene en int16
    if np.max(np.abs(audio)) > 1:
        audio = audio / 32768.0

    segments, _ = model.transcribe(
        audio,
        beam_size=1
    )

    text = ""
    for seg in segments:
        text += seg.text

    return text.strip()