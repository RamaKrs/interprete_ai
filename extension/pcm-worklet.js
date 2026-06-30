// pcm-worklet.js — corre en el thread de renderizado de audio.
// Reduce a mono y agrupa las muestras en chunks de tamaño fijo antes
// de mandarlas al thread principal.

const CHUNK_SIZE = 4096; // ~256ms a 16kHz

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SIZE);
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true; // no hay señal todavía

    const channelCount = input.length;
    const frameCount = input[0].length;

    for (let i = 0; i < frameCount; i++) {
      // Downmix a mono promediando todos los canales
      let sum = 0;
      for (let c = 0; c < channelCount; c++) sum += input[c][i];
      this.buffer[this.writeIndex++] = sum / channelCount;

      if (this.writeIndex === CHUNK_SIZE) {
        // .slice(0) copia el contenido — el buffer original se reutiliza
        this.port.postMessage(this.buffer.slice(0));
        this.writeIndex = 0;
      }
    }

    return true; // false le diría al navegador que puede descartar el processor
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
