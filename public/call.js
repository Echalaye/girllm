// Hands-free "call" mode: the microphone stays open, the voice activity
// detector (vad.js) finds where you start and stop talking, and each
// utterance is handed to the page (which transcribes it, sends it, and
// plays her spoken reply). Listening is paused while she thinks and
// speaks, so she never hears herself.
//
// Audio is processed locally in the browser and only sent to the local
// girllm server.

import { Downsampler, VoiceActivityDetector } from './vad.js';

/** Hands-free mode needs AudioWorklet + a secure context (127.0.0.1/localhost). */
export const callSupported = () =>
  Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

/**
 * @typedef {'off' | 'listening' | 'hearing' | 'paused'} CallState
 *   listening: waiting for you to talk; hearing: you are talking;
 *   paused: she is thinking or speaking.
 */

export class CallSession {
  #context = null;
  #stream = null;
  #node = null;
  #vad = null;
  #downsampler = null;
  /** @type {CallState} */
  #state = 'off';

  /**
   * @param {{
   *   onUtterance: (audio: Float32Array) => void,
   *   onState?: (state: CallState) => void,
   *   onLevel?: (db: number) => void,
   * }} handlers  onUtterance receives 16 kHz mono samples; the session is
   *   paused at that point and the page calls resume() when she's done.
   */
  constructor(handlers) {
    this.handlers = handlers;
  }

  get state() {
    return this.#state;
  }

  async start() {
    if (this.#state !== 'off') return;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation matters here: her voice comes out of the speakers.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      this.#context = new AudioContext();
      await this.#context.audioWorklet.addModule('/pcm-capture.worklet.js');
      const source = this.#context.createMediaStreamSource(this.#stream);
      this.#node = new AudioWorkletNode(this.#context, 'pcm-capture', { numberOfOutputs: 1 });
      // Some browsers only process nodes connected to the destination:
      // route through a muted gain so nothing is actually played.
      const mute = this.#context.createGain();
      mute.gain.value = 0;
      source.connect(this.#node).connect(mute).connect(this.#context.destination);

      this.#downsampler = new Downsampler(this.#context.sampleRate);
      this.#vad = new VoiceActivityDetector();
      this.#node.port.onmessage = (e) => this.#onSamples(e.data);
      this.#setState('listening');
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** Stop listening (she is thinking or speaking). Partial speech is dropped. */
  pause() {
    if (this.#state === 'off') return;
    this.#vad.reset();
    this.#setState('paused');
  }

  resume() {
    if (this.#state !== 'paused') return;
    this.#vad.reset();
    this.#setState('listening');
  }

  /** Hang up: release the microphone (its indicator turns off). */
  stop() {
    if (this.#node) this.#node.port.onmessage = null;
    this.#node?.disconnect();
    this.#stream?.getTracks().forEach((t) => t.stop());
    void this.#context?.close();
    this.#node = this.#stream = this.#context = this.#vad = this.#downsampler = null;
    this.#setState('off');
  }

  #onSamples(raw) {
    if (this.#state !== 'listening' && this.#state !== 'hearing') return;
    const samples = this.#downsampler.push(raw);
    for (const event of this.#vad.push(samples)) {
      if (event.type === 'speechstart') this.#setState('hearing');
      else if (event.type === 'discarded') this.#setState('listening');
      else if (event.type === 'speechend') {
        this.pause();
        this.handlers.onUtterance(event.audio);
        return; // ignore the rest of this batch
      }
    }
    this.handlers.onLevel?.(this.#vad.lastDb);
  }

  #setState(state) {
    if (state === this.#state) return;
    this.#state = state;
    this.handlers.onState?.(state);
  }
}
