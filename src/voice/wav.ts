/** Audio decoding helper for speech-to-text uploads (no dependencies). */

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
