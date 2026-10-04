// Browser audio: microphone capture for speech-to-text, and a playback
// queue for spoken replies. Audio never leaves your machine: it is sent
// to the local girllm server only.

/** Whisper expects 16 kHz mono. */
const STT_SAMPLE_RATE = 16000;
/** Safety cap, matches the server limit (~60 s). */
const MAX_RECORDING_MS = 60_000;

/** Microphone access needs a secure context (http://127.0.0.1 or localhost qualify). */
export const micSupported = () =>
  Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export class Recorder {
  #stream = null;
  #recorder = null;
  #chunks = [];
  #timer = null;
  #stopped = null;

  get recording() {
    return this.#recorder?.state === 'recording';
  }

  /** @param {() => void} onAutoStop called if the max duration is reached. */
  async start(onAutoStop) {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.#chunks = [];
    this.#recorder = new MediaRecorder(this.#stream);
    this.#recorder.ondataavailable = (e) => e.data.size && this.#chunks.push(e.data);
    this.#stopped = new Promise((resolve) => (this.#recorder.onstop = resolve));
    this.#recorder.start();
    this.#timer = setTimeout(onAutoStop, MAX_RECORDING_MS);
  }

  /** Stop and return the recording as 16 kHz mono Float32Array. */
  async stop() {
    if (!this.#recorder) return new Float32Array(0);
    clearTimeout(this.#timer);
    if (this.#recorder.state !== 'inactive') this.#recorder.stop();
    await this.#stopped;
    this.#release();

    const blob = new Blob(this.#chunks, { type: this.#recorder.mimeType });
    this.#recorder = null;
    if (blob.size === 0) return new Float32Array(0);

    // Decode (webm/opus, ogg…) with the browser, then resample to 16 kHz mono.
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE), STT_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally {
      void ctx.close();
    }
  }

  /** Abort without returning audio (e.g. page change). */
  cancel() {
    clearTimeout(this.#timer);
    if (this.#recorder?.state === 'recording') this.#recorder.stop();
    this.#recorder = null;
    this.#release();
  }

  #release() {
    this.#stream?.getTracks().forEach((t) => t.stop()); // turns the mic indicator off
    this.#stream = null;
  }
}

/**
 * Plays spoken sentences in order. Synthesis requests start immediately
 * (the server processes them one by one) so the next sentence is usually
 * ready when the current one ends.
 */
export class Speaker {
  #queue = [];
  #playing = false;
  #generation = 0; // bumped by stop(): stale items are discarded
  #audio = new Audio();
  #endCurrent = null;
  /** Resolvers waiting for the queue to drain (see whenIdle). */
  #idleWaiters = [];

  /** @param {(text: string) => Promise<Blob | null>} synthesize */
  constructor(synthesize) {
    this.synthesize = synthesize;
  }

  enqueue(text) {
    const item = { generation: this.#generation, audio: this.synthesize(text).catch(() => null) };
    this.#queue.push(item);
    void this.#pump();
  }

  /** True while something is playing or waiting to be played. */
  get busy() {
    return this.#playing || this.#queue.length > 0;
  }

  /** Resolves once everything queued has been played (or stopped). */
  whenIdle() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Silence immediately and drop everything queued. */
  stop() {
    this.#generation++;
    this.#queue = [];
    this.#audio.pause();
    this.#endCurrent?.();
  }

  async #pump() {
    if (this.#playing) return;
    this.#playing = true;
    try {
      while (this.#queue.length) {
        const item = this.#queue.shift();
        const blob = await item.audio;
        if (!blob || item.generation !== this.#generation) continue;
        await this.#play(blob);
      }
    } finally {
      this.#playing = false;
      if (!this.#queue.length) this.#idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  #play(blob) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve) => {
      const done = () => {
        this.#audio.onended = this.#audio.onerror = null;
        this.#endCurrent = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      this.#endCurrent = done;
      this.#audio.onended = this.#audio.onerror = done;
      this.#audio.src = url;
      this.#audio.play().catch(done); // autoplay blocked -> skip, don't hang
    });
  }
}
