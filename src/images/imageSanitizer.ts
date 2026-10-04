/**
 * Validation and metadata stripping for images uploaded by the user (the
 * character's reference face). No dependency: PNG chunks and JPEG segments
 * are walked directly.
 *
 * Why strip: photos carry EXIF (GPS position, device, date). Nothing is
 * re-encoded, so the pixels are untouched; only metadata blocks are removed.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_SIDE = 64;
export const MAX_SIDE = 4096;

export type ImageType = 'png' | 'jpeg';

export interface SanitizedImage {
  type: ImageType;
  width: number;
  height: number;
  bytes: Buffer;
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG chunks that carry pixels or colour information (everything else is dropped). */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);

/** Detect the type from the first bytes (never trust the file name or Content-Type). */
export function detectImageType(bytes: Buffer): ImageType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return undefined;
}

/** Keep only pixel/colour chunks; returns the new file and its size. */
function sanitizePng(png: Buffer): { bytes: Buffer; width: number; height: number } {
  const kept: Buffer[] = [PNG_SIGNATURE];
  let width = 0;
  let height = 0;
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new InvalidImageError('Truncated PNG');
    if (type === 'IHDR') {
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
    }
    if (PNG_KEEP.has(type)) kept.push(png.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || width === 0) throw new InvalidImageError('Incomplete PNG');
  return { bytes: Buffer.concat(kept), width, height };
}

/** JPEG markers that carry metadata: APP1 (EXIF/XMP), APP13 (IPTC), COM (comments). */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);
/** Start-of-frame markers (contain the dimensions). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sanitizeJpeg(jpg: Buffer): { bytes: Buffer; width: number; height: number } {
  const kept: Buffer[] = [jpg.subarray(0, 2)]; // SOI
  let width = 0;
  let height = 0;
  let offset = 2;
  while (offset + 4 <= jpg.length) {
    if (jpg[offset] !== 0xff) throw new InvalidImageError('Corrupted JPEG');
    const marker = jpg[offset + 1]!;
    if (marker === 0xda) {
      // Start of scan: compressed data follows until the end, keep it all.
      kept.push(jpg.subarray(offset));
      offset = jpg.length;
      break;
    }
    const length = jpg.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > jpg.length) throw new InvalidImageError('Truncated JPEG');
    if (JPEG_SOF.has(marker)) {
      height = jpg.readUInt16BE(offset + 5);
      width = jpg.readUInt16BE(offset + 7);
    }
    if (!JPEG_DROP.has(marker)) kept.push(jpg.subarray(offset, end));
    offset = end;
  }
  if (width === 0 || height === 0) throw new InvalidImageError('JPEG without image data');
  return { bytes: Buffer.concat(kept), width, height };
}

/**
 * Validate an uploaded image and strip its metadata.
 * @throws InvalidImageError with a user-readable message.
 */
export function sanitizeImage(bytes: Buffer): SanitizedImage {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new InvalidImageError('Image too large (max 10 MB)');
  const type = detectImageType(bytes);
  if (!type) throw new InvalidImageError('Only PNG and JPEG images are supported');
  const result = type === 'png' ? sanitizePng(bytes) : sanitizeJpeg(bytes);
  const { width, height } = result;
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    throw new InvalidImageError(`Image must be between ${MIN_SIDE} and ${MAX_SIDE} pixels per side`);
  }
  return { type, ...result };
}
