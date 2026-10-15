import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { jpegOrientation, orientPixels, prepareFaceImage } from '../src/images/faceImage.js';

/** A real JPEG with an EXIF orientation tag (TIFF big endian this time). */
function jpegWithOrientation(width: number, height: number, orientation: number, gps = false): Buffer {
  const encoded = jpeg.encode({ data: Buffer.alloc(width * height * 4, 120), width, height }, 90).data;
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
    gps ? Buffer.from('GPS 43.6N 1.4E') : Buffer.alloc(0),
  ]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([encoded.subarray(0, 2), app1, payload, encoded.subarray(2)]);
}

describe('faceImage', () => {
  it('reads the EXIF orientation (1 when there is none)', () => {
    expect(jpegOrientation(jpegWithOrientation(16, 8, 6))).toBe(6);
    expect(jpegOrientation(jpegWithOrientation(16, 8, 3))).toBe(3);
    const plain = jpeg.encode({ data: Buffer.alloc(16 * 8 * 4), width: 16, height: 8 }, 90).data;
    expect(jpegOrientation(plain)).toBe(1);
  });

  it('turns pixels upright for every orientation', () => {
    // 2×1 image: A (1) on the left, B (2) on the right (red channel).
    const ab = new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255]);
    const red = (o: { data: Uint8Array }) => Array.from(o.data).filter((_, i) => i % 4 === 0);
    expect(red(orientPixels(ab, 2, 1, 1))).toEqual([1, 2]);
    expect(red(orientPixels(ab, 2, 1, 2))).toEqual([2, 1]); // mirrored
    expect(red(orientPixels(ab, 2, 1, 3))).toEqual([2, 1]); // 180°
    const cw = orientPixels(ab, 2, 1, 6); // 90° clockwise: A on top
    expect([cw.width, cw.height, ...red(cw)]).toEqual([1, 2, 1, 2]);
    const ccw = orientPixels(ab, 2, 1, 8); // 90° counter-clockwise: B on top
    expect([ccw.width, ccw.height, ...red(ccw)]).toEqual([1, 2, 2, 1]);
  });

  it('converts a JPEG to an upright PNG without its metadata', () => {
    const face = prepareFaceImage(jpegWithOrientation(80, 64, 6, true));
    expect(face.type).toBe('png');
    expect([face.width, face.height]).toEqual([64, 80]);
    const png = PNG.sync.read(face.bytes);
    expect([png.width, png.height]).toEqual([64, 80]);
    expect(face.bytes.toString('latin1')).not.toContain('GPS');
    expect(face.bytes.toString('latin1')).not.toContain('Exif');
  });

  it('keeps PNG faces as they are and refuses what is not an image', () => {
    const png = new PNG({ width: 64, height: 64 });
    const bytes = PNG.sync.write(png);
    expect(prepareFaceImage(bytes).type).toBe('png');
    expect(() => prepareFaceImage(Buffer.from('nope'))).toThrow();
  });
});
