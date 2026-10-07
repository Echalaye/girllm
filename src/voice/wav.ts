/**
 * Audio helpers (no dependencies): float32 PCM uploads from the browser
 * (speech-to-text, and voice clips the user records or brings, step 7b),
 * WAV encoding for those clips, resampling and level checks.
 */

/**
 * Decode little-endian float32 PCM sent by the browser. Non-finite values
 * (NaN/Infinity from a buggy client) are zeroed and the rest clamped.
 * @throws Error if the byte length isn't a multiple of 4.
 */
export function decodeFloat32(bytes: Buffer): Float32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error('Audio payload must be float32 samples');
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    const v = bytes.readFloatLE(i * 4);
    out[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return out;
}

/**
 * Encode mono float samples as a 16-bit PCM WAV file (what ComfyUI's
 * LoadAudio reads, and every browser plays). Samples are clamped.
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/**
 * Linear-interpolation resampling. Good enough for speech recognition input
 * (Whisper wants 16 kHz); not used for what she says.
 */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), samples.length - 1);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = pos - i0;
    out[i] = samples[i0]! * (1 - t) + samples[i1]! * t;
  }
  return out;
}

/** Root mean square level (0 = silence, ~0.1 = normal speech). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/**
 * Scale so the loudest sample reaches `peak` (−1 dBFS by default): a quiet
 * mic recording and a loud file make an equally loud reference. Returns a
 * copy; silence is returned unchanged.
 */
export function peakNormalize(samples: Float32Array, peak = 0.89): Float32Array {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max < 1e-4) return samples.slice();
  const gain = peak / max;
  return samples.map((s) => s * gain);
}

/**
 * Trim leading and trailing silence, keeping `padSeconds` around the speech
 * so the first and last syllables aren't clipped. "Silence" is relative to
 * the clip's loudest sample (5 % of it), so a quiet mic recording isn't
 * mistaken for silence; pass `threshold` to use a fixed level instead.
 */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  threshold?: number,
  padSeconds = 0.15,
): Float32Array {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const level = threshold ?? Math.max(0.002, peak * 0.05);
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]!) < level) start++;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]!) < level) end--;
  if (start >= end) return new Float32Array(0);
  const pad = Math.round(padSeconds * sampleRate);
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}
