// Voice activity detection for the hands-free "call" mode.
// Pure logic (no DOM, no Web Audio): unit-tested in tests/vad.test.ts.
//
// The microphone stream (from an AudioWorklet, see pcm-capture.worklet.js)
// is downsampled to 16 kHz, cut into short frames, and each frame's energy
// is compared with an adaptive estimate of the background noise:
//
//   idle ──loud frame──▶ pending ──enough voiced time──▶ speech
//    ▲                     │ short blip                    │ long silence / too long
//    └─────────────────────┴───────────────────────────────┴──▶ emit the utterance
//
// Hysteresis (a higher threshold to start than to continue) avoids cutting
// words at their quiet ends; a pre-roll keeps the first syllable that
// crossed the threshold late.

/** Sample rate expected by Whisper (and by the /api/stt endpoint). */
export const VAD_SAMPLE_RATE = 16000;

/**
 * Streaming downsampler (e.g. 48 kHz → 16 kHz) with a box filter: each
 * output sample is the mean of the input samples it covers, which is a
 * cheap but sufficient anti-aliasing filter for speech recognition.
 */
export class Downsampler {
  /**
   * @param {number} fromRate input sample rate (AudioContext.sampleRate)
   * @param {number} [toRate] output sample rate
   */
  constructor(fromRate, toRate = VAD_SAMPLE_RATE) {
    if (!(fromRate >= toRate)) throw new RangeError(`Cannot downsample from ${fromRate} Hz to ${toRate} Hz`);
    this.ratio = fromRate / toRate;
    /** Input samples not consumed yet, and the fractional read position in them. */
    this.pending = new Float32Array(0);
    this.position = 0;
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  push(input) {
    if (this.ratio === 1) return input.slice();
    const buf = new Float32Array(this.pending.length + input.length);
    buf.set(this.pending);
    buf.set(input, this.pending.length);

    const out = new Float32Array(Math.floor((buf.length - this.position) / this.ratio));
    let n = 0;
    let pos = this.position;
    while (n < out.length) {
      const start = Math.floor(pos);
      const end = Math.floor(pos + this.ratio);
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      out[n++] = sum / (end - start);
      pos += this.ratio;
    }
    const consumed = Math.floor(pos);
    this.pending = buf.slice(consumed);
    this.position = pos - consumed;
    return out;
  }
}

/** Default tuning; every value can be overridden in the constructor. */
export const VAD_DEFAULTS = Object.freeze({
  sampleRate: VAD_SAMPLE_RATE,
  /** Analysis frame length. */
  frameMs: 30,
  /** A frame must be this much louder than the noise floor to START speech… */
  startMarginDb: 12,
  /** …and this much to CONTINUE it (hysteresis). */
  continueMarginDb: 6,
  /** Never treat anything quieter than this as speech, however silent the room. */
  minSpeechDb: -50,
  /** Voiced time needed before an utterance really starts (filters clicks, coughs). */
  minSpeechMs: 250,
  /** Silence that ends an utterance (natural pauses between words are shorter). */
  hangoverMs: 900,
  /** Audio kept from before the start, so the first syllable isn't clipped. */
  prerollMs: 300,
  /** Silence kept at the end of an utterance. */
  tailMs: 200,
  /** Hard cap per utterance (the server accepts ~60 s). */
  maxUtteranceMs: 30_000,
});

/** dB full scale of a frame's RMS. */
export function frameDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return 10 * Math.log10(sum / Math.max(frame.length, 1) + 1e-12);
}

/**
 * @typedef {{ type: 'speechstart' }
 *   | { type: 'speechend', audio: Float32Array, forced: boolean }
 *   | { type: 'discarded' }} VadEvent
 */

export class VoiceActivityDetector {
  /** @param {Partial<typeof VAD_DEFAULTS>} [options] */
  constructor(options = {}) {
    this.options = { ...VAD_DEFAULTS, ...options };
    const o = this.options;
    this.frameSize = Math.round((o.sampleRate * o.frameMs) / 1000);
    const frames = (ms) => Math.max(1, Math.round(ms / o.frameMs));
    this.limits = {
      minSpeech: frames(o.minSpeechMs),
      hangover: frames(o.hangoverMs),
      preroll: frames(o.prerollMs),
      tail: frames(o.tailMs),
      max: frames(o.maxUtteranceMs),
      /** A "pending" start is abandoned after this much silence. */
      blip: frames(150),
    };
    this.reset();
  }

  /** Forget everything (e.g. after she spoke: her voice must not count). Keeps the noise floor. */
  reset() {
    /** @type {'idle' | 'pending' | 'speech'} */
    this.state = 'idle';
    this.partial = new Float32Array(this.frameSize);
    this.partialLength = 0;
    /** Frames of the current utterance (or the pre-roll ring when idle). */
    this.frames = [];
    this.voiced = 0;
    this.silence = 0;
    this.lastDb = -120;
  }

  /** Estimated background noise level, in dBFS (undefined before the first frame). */
  get noiseFloorDb() {
    return this.floor;
  }

  get speaking() {
    return this.state === 'speech';
  }

  /**
   * Feed 16 kHz mono samples (any length).
   * @param {Float32Array} samples
   * @returns {VadEvent[]}
   */
  push(samples) {
    const events = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSize - this.partialLength, samples.length - offset);
      this.partial.set(samples.subarray(offset, offset + take), this.partialLength);
      this.partialLength += take;
      offset += take;
      if (this.partialLength === this.frameSize) {
        const event = this.#frame(this.partial.slice());
        if (event) events.push(event);
        this.partialLength = 0;
      }
    }
    return events;
  }

  /** @returns {VadEvent | undefined} */
  #frame(frame) {
    const o = this.options;
    const db = frameDb(frame);
    this.lastDb = db;
    this.#trackNoise(db);
    const startThreshold = Math.max(this.floor + o.startMarginDb, o.minSpeechDb);
    const continueThreshold = Math.max(this.floor + o.continueMarginDb, o.minSpeechDb);

    switch (this.state) {
      case 'idle':
        this.frames.push(frame);
        if (this.frames.length > this.limits.preroll) this.frames.shift();
        if (db >= startThreshold) {
          this.state = 'pending';
          this.voiced = 1;
          this.silence = 0;
        }
        return undefined;

      case 'pending':
        this.frames.push(frame);
        if (db >= continueThreshold) {
          this.voiced++;
          this.silence = 0;
        } else if (++this.silence >= this.limits.blip) {
          // Just a click or a short noise: back to idle, keep a pre-roll.
          this.state = 'idle';
          this.frames = this.frames.slice(-this.limits.preroll);
          return { type: 'discarded' };
        }
        if (this.voiced >= this.limits.minSpeech) {
          this.state = 'speech';
          return { type: 'speechstart' };
        }
        return undefined;

      case 'speech': {
        this.frames.push(frame);
        this.silence = db >= continueThreshold ? 0 : this.silence + 1;
        const forced = this.frames.length >= this.limits.max;
        if (this.silence < this.limits.hangover && !forced) return undefined;
        // Drop most of the trailing silence, keep a short natural tail.
        const keep = this.frames.length - Math.max(0, this.silence - this.limits.tail);
        const audio = concat(this.frames.slice(0, keep));
        this.state = 'idle';
        this.frames = [];
        this.voiced = 0;
        this.silence = 0;
        return { type: 'speechend', audio, forced };
      }
    }
    return undefined;
  }

  /**
   * Adaptive noise floor: falls quickly to quieter levels, rises slowly.
   * Idle: ~1.5 s time constant, to follow a fan being switched on. During
   * speech: ~3 s, slower, so the voice doesn't become "noise" (the quiet
   * gaps between syllables pull the floor back down anyway), but still
   * fast enough that steady noise mistaken for speech ends the utterance.
   */
  #trackNoise(db) {
    if (this.floor === undefined) {
      this.floor = Math.min(db, -45);
      return;
    }
    const rise = this.state === 'idle' ? 0.02 : 0.01;
    const rate = db < this.floor ? 0.3 : rise;
    this.floor = Math.min(-20, Math.max(-100, this.floor + (db - this.floor) * rate));
  }
}

function concat(frames) {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
