/**
 * Turns an image the user gives (an uploaded photo, or the picture of an
 * imported PNG card) into her reference face: validated, metadata stripped
 * (imageSanitizer), and always stored as PNG.
 *
 * Why PNG: the face detector reads PNG only, so a JPEG face was never cropped
 * to the face. FLUX.2 [klein] then got the whole photo (clothes, background)
 * as its reference and her face came through weakly. Converting once, at
 * upload, fixes it for every engine and the face pass.
 *
 * The JPEG is decoded with jpeg-js (pure JavaScript, no native build) with
 * memory and resolution limits, and its EXIF orientation is applied to the
 * pixels: phones store most photos sideways with an "rotate me" tag, and the
 * metadata (EXIF included) is removed for privacy.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { detectImageType, InvalidImageError, MAX_SIDE, sanitizeImage, type SanitizedImage } from './imageSanitizer.js';

/** Decoding limits: MAX_SIDE² pixels at most, and the memory that needs. */
const DECODE_LIMITS = { maxResolutionInMP: Math.ceil((MAX_SIDE * MAX_SIDE) / 1_000_000), maxMemoryUsageInMB: 512 };

/**
 * EXIF orientation of a JPEG (1–8), 1 when absent or unreadable. Read from
 * the ORIGINAL file: sanitizing removes the EXIF block.
 */
export function jpegOrientation(jpg: Buffer): number {
  let offset = 2;
  while (offset + 4 <= jpg.length && jpg[offset] === 0xff) {
    const marker = jpg[offset + 1]!;
    if (marker === 0xda) break; // start of scan: no more metadata
    const length = jpg.readUInt16BE(offset + 2);
    if (length < 2) break;
    const start = offset + 4;
    if (marker === 0xe1 && jpg.toString('latin1', start, start + 6) === 'Exif\0\0') {
      return exifOrientation(jpg.subarray(start + 6, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return 1;
}

/** Orientation tag (0x0112) of IFD0 in a TIFF block, 1 when missing. */
function exifOrientation(tiff: Buffer): number {
  if (tiff.length < 8) return 1;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Apply an EXIF orientation to RGBA pixels (exported for tests).
 * 2: mirror, 3: 180°, 4: flip, 5: transpose, 6: 90° clockwise, 7: transverse,
 * 8: 90° counter-clockwise.
 */
export function orientPixels(
  data: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { data: Uint8Array; width: number; height: number } {
  if (orientation < 2 || orientation > 8) return { data, width, height };
  const swap = orientation >= 5;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2:
          nx = width - 1 - x;
          ny = y;
          break;
        case 3:
          nx = width - 1 - x;
          ny = height - 1 - y;
          break;
        case 4:
          nx = x;
          ny = height - 1 - y;
          break;
        case 5:
          nx = y;
          ny = x;
          break;
        case 6:
          nx = height - 1 - y;
          ny = x;
          break;
        case 7:
          nx = height - 1 - y;
          ny = width - 1 - x;
          break;
        default: // 8
          nx = y;
          ny = width - 1 - x;
      }
      const from = (y * width + x) * 4;
      const to = (ny * w + nx) * 4;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
      out[to + 3] = data[from + 3]!;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Validate an image given as her face and return it as a clean PNG.
 * PNG: metadata chunks dropped (pixels untouched). JPEG: decoded, turned
 * upright, re-encoded as PNG (no metadata can survive).
 * @throws InvalidImageError with a user-readable message.
 */
export function prepareFaceImage(bytes: Buffer): SanitizedImage {
  const orientation = detectImageType(bytes) === 'jpeg' ? jpegOrientation(bytes) : 1;
  const image = sanitizeImage(bytes);
  if (image.type === 'png') return image;
  let decoded;
  try {
    decoded = jpeg.decode(image.bytes, { useTArray: true, formatAsRGBA: true, ...DECODE_LIMITS });
  } catch (err) {
    throw new InvalidImageError(`This JPEG can't be read (${(err as Error).message})`);
  }
  const upright = orientPixels(decoded.data, decoded.width, decoded.height, orientation);
  const png = new PNG({ width: upright.width, height: upright.height });
  png.data = Buffer.from(upright.data.buffer, upright.data.byteOffset, upright.data.byteLength);
  return { type: 'png', width: upright.width, height: upright.height, bytes: PNG.sync.write(png) };
}
