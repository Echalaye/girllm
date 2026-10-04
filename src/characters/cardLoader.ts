/**
 * Loads character cards from `.json` files or `.png` images.
 *
 * PNG cards store the JSON base64-encoded in a `tEXt` chunk whose keyword
 * is `chara` (V2) or `ccv3` (V3, whose `data` block is V2-compatible).
 * The PNG reader below is deliberately minimal and defensive: it only walks
 * chunk headers and never decodes image data.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { CardV1Schema, CardV2Schema, characterFromCard, type CardFields, type Character } from './schema.js';

/** Cards above this size are rejected before being read into memory. */
export const MAX_CARD_FILE_BYTES = 20 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD_KEYWORDS = ['ccv3', 'chara'] as const; // ccv3 preferred when both exist

export class CardLoadError extends Error {
  constructor(file: string, reason: string) {
    super(`Cannot load character card "${file}": ${reason}`);
    this.name = 'CardLoadError';
  }
}

/** Turn a file name into a URL-safe id: "My Waifu (v2).png" -> "my-waifu-v2". */
export function slugify(fileName: string): string {
  const slug = basename(fileName, extname(fileName))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'character';
}

/**
 * Extract the embedded card JSON string from a PNG buffer.
 * @throws Error if the buffer is not a PNG or has no card chunk.
 */
export function extractCardJsonFromPng(png: Buffer): string {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }

  const found = new Map<string, string>();
  let offset = 8;
  // Each chunk: length (4) | type (4) | data (length) | CRC (4)
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error('truncated PNG chunk');

    if (type === 'tEXt') {
      const data = png.subarray(dataStart, dataEnd);
      const sep = data.indexOf(0);
      if (sep > 0) {
        const keyword = data.toString('latin1', 0, sep);
        if ((CARD_KEYWORDS as readonly string[]).includes(keyword)) {
          found.set(keyword, data.toString('latin1', sep + 1));
        }
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  for (const keyword of CARD_KEYWORDS) {
    const b64 = found.get(keyword);
    if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  }
  throw new Error('no character data (tEXt "chara"/"ccv3") found in PNG');
}

/**
 * Validate a parsed JSON value as a V2 (or V3-wrapped) or V1 card.
 * @throws Error describing the first validation problems.
 */
export function parseCardObject(raw: unknown): CardFields {
  // V3 cards keep a V2-compatible `data` object: validate it as V2.
  if (raw && typeof raw === 'object' && (raw as { spec?: unknown }).spec === 'chara_card_v3') {
    raw = { ...raw, spec: 'chara_card_v2' };
  }
  const v2 = CardV2Schema.safeParse(raw);
  if (v2.success) return v2.data.data;

  const v1 = CardV1Schema.safeParse(raw);
  if (v1.success) return v1.data;

  const issues = v2.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  throw new Error(`invalid card format (${issues})`);
}

/** Load and validate one card file (.json or .png). */
export async function loadCardFile(filePath: string): Promise<Character> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.json' && ext !== '.png') {
    throw new CardLoadError(filePath, `unsupported extension "${ext}"`);
  }

  const { size } = await stat(filePath);
  if (size > MAX_CARD_FILE_BYTES) {
    throw new CardLoadError(filePath, `file too large (${size} bytes)`);
  }

  try {
    const buffer = await readFile(filePath);
    const json = ext === '.png' ? extractCardJsonFromPng(buffer) : buffer.toString('utf8');
    const fields = parseCardObject(JSON.parse(json));
    return characterFromCard(fields, slugify(filePath), filePath);
  } catch (err) {
    throw new CardLoadError(filePath, (err as Error).message);
  }
}
