import { describe, expect, it } from 'vitest';
// Plain browser ES module, shared with the front-end.
import { Downsampler, frameDb, VoiceActivityDetector, type VadEvent } from '../public/vad.js';

const RATE = 16000;
const samplesFor = (ms: number) => Math.round((RATE * ms) / 1000);

/** Deterministic pseudo-random noise (no flaky tests). */
function noise(ms: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(samplesFor(ms));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out[i] = ((x / 2 ** 31) * 2 - 1) * amplitude;
  }
  return out;
}

/** A "voice": a 220 Hz tone, loud enough to stand out from the noise. */
function voice(ms: number, amplitude = 0.2): Float32Array {
  const out = new Float32Array(samplesFor(ms));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude;
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Feed audio in worklet-sized chunks and collect the events. */
function feed(vad: VoiceActivityDetector, audio: Float32Array, chunk = 1024): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < audio.length; i += chunk) events.push(...vad.push(audio.subarray(i, i + chunk)));
  return events;
}

describe('frameDb', () => {
  it('measures RMS level in dBFS', () => {
    expect(frameDb(new Float32Array(100).fill(1))).toBeCloseTo(0, 5);
    expect(frameDb(new Float32Array(100).fill(0.1))).toBeCloseTo(-20, 5);
    expect(frameDb(new Float32Array(100))).toBeLessThan(-100);
  });
});

describe('Downsampler', () => {
  it('converts 48 kHz to 16 kHz across chunk boundaries', () => {
    const d = new Downsampler(48000);
    const input = new Float32Array(4800).map((_, i) => i % 3); // 0,1,2 → mean 1
    let total = 0;
    for (let i = 0; i < input.length; i += 128) {
      const out = d.push(input.subarray(i, i + 128));
      total += out.length;
      for (const v of out) expect(v).toBeCloseTo(1, 5);
    }
    expect(total).toBe(1600);
  });

  it('handles non-integer ratios (44.1 kHz) without drift', () => {
    const d = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.push(new Float32Array(441)).length;
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
  });

  it('passes 16 kHz through and refuses upsampling', () => {
    expect(new Downsampler(16000).push(new Float32Array([1, 2])).length).toBe(2);
    expect(() => new Downsampler(8000)).toThrow(RangeError);
  });
});

describe('VoiceActivityDetector', () => {
  it('detects an utterance between silences, with pre-roll and a short tail', () => {
    const vad = new VoiceActivityDetector();
    const events = feed(vad, concat(noise(1000, 0.003), voice(1200), noise(1500, 0.003)));
    expect(events.map((e) => e.type)).toEqual(['speechstart', 'speechend']);
    const end = events[1] as Extract<VadEvent, { type: 'speechend' }>;
    expect(end.forced).toBe(false);
    // ≈ 1.2 s of voice + ≤ 300 ms pre-roll + ≤ 200 ms tail (frame rounding aside).
    const seconds = end.audio.length / RATE;
    expect(seconds).toBeGreaterThan(1.2);
    expect(seconds).toBeLessThan(1.8);
  });

  it('keeps one utterance across short pauses between words', () => {
    const vad = new VoiceActivityDetector();
    const events = feed(
      vad,
      concat(noise(800, 0.003), voice(500), noise(400, 0.003), voice(500), noise(1500, 0.003, 7)),
    );
    expect(events.filter((e) => e.type === 'speechend')).toHaveLength(1);
  });

  it('ignores clicks shorter than the minimum speech time', () => {
    const vad = new VoiceActivityDetector();
    const events = feed(vad, concat(noise(800, 0.003), voice(90), noise(1500, 0.003)));
    expect(events.map((e) => e.type)).toEqual(['discarded']);
  });

  it('adapts to a louder room instead of hearing speech forever', () => {
    const vad = new VoiceActivityDetector();
    // A fan starts: steady noise 20 dB louder than before.
    const events = feed(vad, concat(noise(500, 0.002), noise(8000, 0.03, 3)));
    const ends = events.filter((e) => e.type === 'speechend');
    expect(ends.length).toBeLessThanOrEqual(1);
    expect(vad.noiseFloorDb!).toBeGreaterThan(-40);
    // …and a voice above the fan is still heard.
    const later = feed(vad, concat(voice(1000, 0.4), noise(1500, 0.03, 5)));
    expect(later.map((e) => e.type)).toContain('speechend');
  });

  it('cuts very long utterances', () => {
    const vad = new VoiceActivityDetector({ maxUtteranceMs: 2000 });
    const events = feed(vad, concat(noise(500, 0.003), voice(5000)));
    const end = events.find((e) => e.type === 'speechend') as Extract<VadEvent, { type: 'speechend' }>;
    expect(end.forced).toBe(true);
    expect(end.audio.length / RATE).toBeCloseTo(2, 1);
  });

  it('reset() drops a running utterance but keeps the noise estimate', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, concat(noise(800, 0.003), voice(600)));
    expect(vad.speaking).toBe(true);
    const floor = vad.noiseFloorDb;
    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(vad.noiseFloorDb).toBe(floor);
    expect(feed(vad, noise(1500, 0.003))).toEqual([]);
  });
});
