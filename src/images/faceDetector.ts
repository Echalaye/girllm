/**
 * Face detection for the face detail pass (step 6).
 *
 * Model: "Ultra-Light-Fast-Generic-Face-Detector-1MB", RFB-640 (MIT, 1.6 MB),
 * downloaded by `npm run setup:images` and pinned by SHA-256. It runs on the
 * CPU through onnxruntime-web (WebAssembly): no native binaries, no Python,
 * ~100 ms per image. Only the bounding box is used; the redraw itself
 * happens in ComfyUI (see detailWorkflow.ts).
 *
 * Input:  RGB, 640×480, (pixel − 127) / 128, NCHW; the picture is letterboxed
 *         (scaled to fit, centred, black padding) so faces keep their shape.
 * Output: "scores" [1, N, 2] (background, face) and "boxes" [1, N, 4]
 *         (x1, y1, x2, y2 normalised to the 640×480 input).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';

/** Pinned download of the detector (installed into MODELS_DIR by setup:images). */
export const FACE_DETECTOR_MODEL = {
  dir: 'face-detector',
  file: 'version-RFB-640.onnx',
  url:
    'https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/' +
    'dffdddda9794a50607cba8f318507a28c1c27cab/models/onnx/version-RFB-640.onnx',
  sha256: '8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430',
  sizeMb: 1.6,
} as const;

const INPUT_W = 640;
const INPUT_H = 480;
/** Below this confidence a box is ignored. */
const MIN_SCORE = 0.7;

export interface FaceBox {
  /** Pixel coordinates in the original picture. */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** Where the detector lives inside MODELS_DIR. */
export function faceDetectorPath(modelsDir: string): string {
  return join(modelsDir, FACE_DETECTOR_MODEL.dir, FACE_DETECTOR_MODEL.file);
}

/** Minimal view of onnxruntime-web used here (keeps the import lazy and typed). */
interface Ort {
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  env: { wasm: { numThreads: number }; logLevel?: string };
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

/**
 * Letterbox an RGBA picture into the detector's input tensor.
 * Pure function (exported for tests).
 */
export function toInputTensor(
  rgba: Uint8Array,
  width: number,
  height: number,
): { data: Float32Array; scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(INPUT_W / width, INPUT_H / height);
  const scaledW = Math.round(width * scale);
  const scaledH = Math.round(height * scale);
  const offsetX = Math.floor((INPUT_W - scaledW) / 2);
  const offsetY = Math.floor((INPUT_H - scaledH) / 2);
  const plane = INPUT_W * INPUT_H;
  // Padding is black: (0 − 127) / 128.
  const data = new Float32Array(3 * plane).fill(-127 / 128);
  for (let y = 0; y < scaledH; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < scaledW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const i = (sy * width + sx) * 4;
      const p = (y + offsetY) * INPUT_W + (x + offsetX);
      data[p] = (rgba[i]! - 127) / 128;
      data[plane + p] = (rgba[i + 1]! - 127) / 128;
      data[2 * plane + p] = (rgba[i + 2]! - 127) / 128;
    }
  }
  return { data, scale, offsetX, offsetY };
}

/**
 * Best face from raw detector outputs, mapped back to picture pixels.
 * Pure function (exported for tests). Many overlapping boxes describe the
 * same face, so the single most confident one is enough here.
 */
export function bestFace(
  scores: Float32Array,
  boxes: Float32Array,
  map: { scale: number; offsetX: number; offsetY: number; width: number; height: number },
): FaceBox | undefined {
  let best = -1;
  let bestScore = MIN_SCORE;
  for (let i = 0; i < scores.length / 2; i++) {
    const s = scores[i * 2 + 1]!;
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best < 0) return undefined;
  const toX = (v: number) => Math.min(map.width, Math.max(0, (v * INPUT_W - map.offsetX) / map.scale));
  const toY = (v: number) => Math.min(map.height, Math.max(0, (v * INPUT_H - map.offsetY) / map.scale));
  const x1 = toX(boxes[best * 4]!);
  const y1 = toY(boxes[best * 4 + 1]!);
  const x2 = toX(boxes[best * 4 + 2]!);
  const y2 = toY(boxes[best * 4 + 3]!);
  if (x2 - x1 < 4 || y2 - y1 < 4) return undefined;
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1),
    score: bestScore,
  };
}

export class FaceDetector {
  private session?: Promise<{ ort: Ort; session: OrtSession }>;

  constructor(private readonly modelPath: string) {}

  /** Is the model downloaded? (the detail pass is skipped otherwise) */
  available(): boolean {
    return existsSync(this.modelPath);
  }

  /** Most confident face in a PNG picture, or undefined. */
  async detect(png: Buffer): Promise<FaceBox | undefined> {
    const { ort, session } = await this.load();
    const image = PNG.sync.read(png);
    const { data, scale, offsetX, offsetY } = toInputTensor(image.data, image.width, image.height);
    const output = await session.run({
      [session.inputNames[0]!]: new ort.Tensor('float32', data, [1, 3, INPUT_H, INPUT_W]),
    });
    const scores = output.scores?.data;
    const boxes = output.boxes?.data;
    if (!scores || !boxes) throw new Error('Unexpected face detector outputs');
    return bestFace(scores, boxes, { scale, offsetX, offsetY, width: image.width, height: image.height });
  }

  private load() {
    this.session ??= (async () => {
      // Loaded on first use only: the WebAssembly runtime is ~10 MB.
      const ort = (await import('onnxruntime-web')) as unknown as Ort;
      ort.env.wasm.numThreads = 1; // tiny model: threads would only add overhead
      ort.env.logLevel = 'error'; // the model triggers harmless graph warnings
      const model = await readFile(this.modelPath);
      return { ort, session: await ort.InferenceSession.create(model, { logSeverityLevel: 3 }) };
    })();
    this.session.catch(() => (this.session = undefined));
    return this.session;
  }
}
