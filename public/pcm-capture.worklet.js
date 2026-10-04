// AudioWorklet processor for the hands-free "call" mode: forwards the raw
// microphone samples (mono, at the AudioContext's sample rate) to the page
// in ~2048-sample batches (≈ 43 ms at 48 kHz), so the main thread isn't
// woken up for every 128-sample render quantum.
// Served from /, so it is allowed by the CSP's script-src 'self'.

const BATCH = 2048;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0]; // first channel is enough (mono mic)
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const take = Math.min(BATCH - this.length, channel.length - offset);
        this.buffer.set(channel.subarray(offset, offset + take), this.length);
        this.length += take;
        offset += take;
        if (this.length === BATCH) {
          // Transfer (no copy) and start a fresh buffer.
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(BATCH);
          this.length = 0;
        }
      }
    }
    return true; // keep running until the node is disconnected
  }
}

registerProcessor('pcm-capture', PcmCapture);
