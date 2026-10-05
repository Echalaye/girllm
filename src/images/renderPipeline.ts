/**
 * One picture, end to end in ComfyUI: generate, then (optionally) redraw
 * the face when it is small (step 6). Shared by the app (ImageService) and
 * the test bench (scripts/compareImages.ts) so both see exactly the same
 * results. The caller owns the GPU (exclusive phase) and frees ComfyUI.
 */
import type { ComfyClient } from './comfyClient.js';
import { buildFaceDetailWorkflow, planFaceCrop, type DetailWorkflowParams } from './detailWorkflow.js';
import type { FaceDetector } from './faceDetector.js';
import type { ComfyWorkflow } from './workflow.js';

/** Everything the face redraw needs except the picture and the crop. */
export type DetailSettings = Omit<DetailWorkflowParams, 'image' | 'crop'>;

export interface RenderJob {
  workflow: ComfyWorkflow;
  /** Face detail pass; undefined or denoise 0 = off. */
  detail?: DetailSettings | undefined;
}

export interface RenderResult {
  /** Final picture (with the face redrawn when it happened). */
  png: Buffer;
  /** The picture before the face pass (same as png when it was skipped). */
  base: Buffer;
  /** Why the face pass did or didn't run (logs, test bench). */
  detail: 'done' | 'off' | 'no-detector' | 'no-face' | 'close-up' | 'failed';
}

export interface RenderLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * The picture is uploaded under one fixed name: jobs run one at a time (GPU
 * gate), and ComfyUI re-reads a LoadImage file whose content changed, so
 * its input folder doesn't fill up with copies.
 */
const SOURCE_NAME = 'girllm_detail_source.png';

/** Pixel size of a PNG (reads the header only). */
export function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR: width and height are the first 8 bytes after the 16-byte signature + chunk header.
  if (png.length < 24) throw new Error('Not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function renderPicture(
  comfy: ComfyClient,
  detector: FaceDetector | undefined,
  job: RenderJob,
  log: RenderLogger,
  signal?: AbortSignal,
): Promise<RenderResult> {
  const base = await comfy.generate(job.workflow, signal);
  const detail = job.detail;
  if (!detail || detail.denoise <= 0) return { png: base, base, detail: 'off' };
  if (!detector?.available()) return { png: base, base, detail: 'no-detector' };

  try {
    const face = await detector.detect(base);
    if (!face) return { png: base, base, detail: 'no-face' };
    const { width, height } = pngSize(base);
    const crop = planFaceCrop(face, width, height);
    if (!crop) return { png: base, base, detail: 'close-up' };
    const image = await comfy.uploadImage(base, SOURCE_NAME, 'image/png');
    const png = await comfy.generate(buildFaceDetailWorkflow({ ...detail, image, crop }), signal);
    return { png, base, detail: 'done' };
  } catch (err) {
    signal?.throwIfAborted(); // a cancel is a cancel, not a "failed detail"
    // The picture itself is fine: keep it rather than failing the photo.
    log.warn({ err }, 'face detail pass failed; keeping the picture as generated');
    return { png: base, base, detail: 'failed' };
  }
}
