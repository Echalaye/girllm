import { describe, expect, it } from 'vitest';
import { detectImageType, InvalidImageError, sanitizeImage } from '../src/images/imageSanitizer.js';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', Buffer.from('pixels')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function jpeg(width: number, height: number, extra: Buffer[] = []): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0')),
    ...extra,
    segment(0xc0, sof),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
  ]);
}

describe('sanitizeImage', () => {
  it('strips PNG text/EXIF/time chunks and keeps pixels', () => {
    const input = png(512, 768, [
      chunk('tEXt', Buffer.from('Author\0Someone')),
      chunk('eXIf', Buffer.from('GPS')),
      chunk('tIME', Buffer.alloc(7)),
    ]);
    const out = sanitizeImage(input);
    expect(out).toMatchObject({ type: 'png', width: 512, height: 768 });
    const text = out.bytes.toString('latin1');
    expect(text).not.toContain('tEXt');
    expect(text).not.toContain('eXIf');
    expect(text).toContain('IDAT');
    expect(text).toContain('pixels');
  });

  it('strips JPEG EXIF (APP1), IPTC (APP13) and comments, keeps JFIF and scan data', () => {
    const input = jpeg(1024, 1536, [
      segment(0xe1, Buffer.from('Exif\0\0GPS-LAT')),
      segment(0xed, Buffer.from('IPTC')),
      segment(0xfe, Buffer.from('comment')),
    ]);
    const out = sanitizeImage(input);
    expect(out).toMatchObject({ type: 'jpeg', width: 1024, height: 1536 });
    const text = out.bytes.toString('latin1');
    expect(text).not.toContain('GPS-LAT');
    expect(text).not.toContain('IPTC');
    expect(text).not.toContain('comment');
    expect(text).toContain('JFIF');
    expect(out.bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('rejects other formats, truncated files and bad sizes', () => {
    expect(detectImageType(Buffer.from('GIF89a'))).toBeUndefined();
    expect(() => sanitizeImage(Buffer.from('<svg/>'))).toThrow(/PNG and JPEG/);
    expect(() => sanitizeImage(png(512, 512).subarray(0, 40))).toThrow(InvalidImageError);
    expect(() => sanitizeImage(png(32, 512))).toThrow(/between 64 and 4096/);
    expect(() => sanitizeImage(jpeg(5000, 100))).toThrow(/between 64 and 4096/);
    expect(() => sanitizeImage(Buffer.concat([png(512, 512), Buffer.alloc(11 * 1024 * 1024)]))).toThrow(/too large/);
  });
});
