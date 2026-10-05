/**
 * Step 6: face detail pass (detector maths, crop planning, ComfyUI graph,
 * render pipeline, ImageService integration), model presets, full-body framing.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { ChatService } from '../src/chat/chatService.js';
import { FULL_BODY_SIZE, frameForScene } from '../src/images/artStyle.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import {
  buildFaceDetailWorkflow,
  FACE_DETAIL_TAGS,
  MAX_FACE_SHARE,
  planFaceCrop,
  type DetailWorkflowParams,
} from '../src/images/detailWorkflow.js';
import { bestFace, toInputTensor, type FaceBox, type FaceDetector } from '../src/images/faceDetector.js';
import { ImageService, type ImageSettings } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { JUGGERNAUT_MODEL, MODEL_PRESETS, OPTIONAL_MODELS, presetFor } from '../src/images/presets.js';
import { pngSize, renderPicture, type DetailSettings } from '../src/images/renderPipeline.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm, TINY_PNG } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };

/** A blank PNG of a given size (pngSize reads its header). */
function blankPng(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

/** ComfyUI fake whose pictures are `png` instead of the 1×1 TINY_PNG. */
function comfyServing(png: Buffer) {
  const comfy = new FakeComfy();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === '/view' ? new Response(png) : comfy.fetch(input, init)) as typeof fetch;
  return { comfy, client: new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl }) };
}

/** Detector stub: always "finds" the given face (or none). */
function stubDetector(face: FaceBox | undefined, o: { available?: boolean; fail?: boolean } = {}) {
  const calls: Buffer[] = [];
  const detector = {
    available: () => o.available ?? true,
    detect: async (png: Buffer) => {
      calls.push(png);
      if (o.fail) throw new Error('boom');
      return face;
    },
  } as unknown as FaceDetector;
  return { detector, calls };
}

const SMALL_FACE: FaceBox = { x: 380, y: 200, width: 150, height: 180, score: 0.98 };

const detail: DetailSettings = {
  checkpoint: 'sdxl.safetensors',
  positive: 'adult, woman, selfie',
  negative: 'cgi',
  seed: 42,
  steps: 30,
  cfg: 4,
  sampler: 'dpmpp_sde',
  scheduler: 'karras',
  denoise: 0.35,
};

describe('face detector maths', () => {
  it('letterboxes the picture into the 640×480 tensor, normalised', () => {
    // 2×2 white picture → scaled ×240 to 480×480, centred (80 px of black padding on each side).
    const rgba = new Uint8Array(2 * 2 * 4).fill(255);
    const { data, scale, offsetX, offsetY } = toInputTensor(rgba, 2, 2);
    expect(data).toHaveLength(3 * 640 * 480);
    expect(scale).toBe(240);
    expect([offsetX, offsetY]).toEqual([80, 0]);
    expect(data[0]).toBeCloseTo(-127 / 128); // padding
    expect(data[80]).toBeCloseTo(1); // (255 − 127) / 128
    expect(data[640 * 480 + 80]).toBeCloseTo(1); // green plane too
  });

  it('keeps the most confident face above the threshold and maps it back to pixels', () => {
    // Two candidates: 0.6 (ignored, below threshold) and 0.95.
    const scores = new Float32Array([0.4, 0.6, 0.05, 0.95]);
    const boxes = new Float32Array([0, 0, 0.1, 0.1, 0.25, 0.25, 0.5, 0.5]);
    const face = bestFace(scores, boxes, { scale: 0.5, offsetX: 0, offsetY: 0, width: 1280, height: 960 });
    expect(face).toEqual({ x: 320, y: 240, width: 320, height: 240, score: expect.closeTo(0.95, 5) });
  });

  it('finds nothing when every score is low or the box is degenerate', () => {
    const map = { scale: 1, offsetX: 0, offsetY: 0, width: 640, height: 480 };
    expect(bestFace(new Float32Array([0.9, 0.1]), new Float32Array([0, 0, 1, 1]), map)).toBeUndefined();
    expect(bestFace(new Float32Array([0, 1]), new Float32Array([0.5, 0.5, 0.501, 0.501]), map)).toBeUndefined();
  });
});

describe('face crop planning', () => {
  it('skips close-ups (the face is already big)', () => {
    expect(planFaceCrop({ ...SMALL_FACE, height: 1216 * MAX_FACE_SHARE + 1 }, 832, 1216)).toBeUndefined();
  });

  it('plans a square crop around the face with context, a multiple of 8', () => {
    const crop = planFaceCrop(SMALL_FACE, 832, 1216)!;
    expect(crop.width).toBe(crop.height);
    expect(crop.width % 8).toBe(0);
    expect(crop.width).toBe(392); // 180 × 2.2 = 396 → 392
    // Centred on the face.
    expect(crop.x + crop.width / 2).toBeCloseTo(SMALL_FACE.x + SMALL_FACE.width / 2, -1);
    expect(crop.y + crop.height / 2).toBeCloseTo(SMALL_FACE.y + SMALL_FACE.height / 2, -1);
  });

  it('keeps the crop inside the picture near an edge', () => {
    const crop = planFaceCrop({ x: 0, y: 0, width: 100, height: 120, score: 1 }, 832, 1216)!;
    expect(crop).toMatchObject({ x: 0, y: 0 });
    const right = planFaceCrop({ x: 780, y: 1150, width: 50, height: 60, score: 1 }, 832, 1216)!;
    expect(right.x + right.width).toBeLessThanOrEqual(832);
    expect(right.y + right.height).toBeLessThanOrEqual(1216);
  });
});

describe('face detail workflow', () => {
  const params: DetailWorkflowParams = {
    ...detail,
    image: 'girllm_detail_source.png',
    crop: { x: 260, y: 96, width: 400, height: 400 },
  };

  it('crops, redraws at 1024 px and pastes back with a feathered mask (core nodes only)', () => {
    const wf = buildFaceDetailWorkflow(params);
    expect(wf['20']!.inputs).toEqual({ image: 'girllm_detail_source.png' });
    expect(wf['21']!.inputs).toMatchObject({ width: 400, height: 400, x: 260, y: 96 });
    expect(wf['22']!.inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(wf['24']!.inputs).toMatchObject({ denoise: 0.35, seed: 42, model: ['1', 0] });
    expect(wf['26']!.inputs).toMatchObject({ width: 400, height: 400 });
    expect(wf['28']!.inputs).toMatchObject({ left: 48, top: 48, right: 48, bottom: 48 });
    expect(wf['29']!.inputs).toMatchObject({ destination: ['20', 0], source: ['26', 0], x: 260, y: 96 });
    expect(wf['7']!.inputs.images).toEqual(['29', 0]);
    expect(wf['3']!.inputs.text).toBe(`adult, woman, selfie, ${FACE_DETAIL_TAGS}`);
    expect(wf['15']).toBeUndefined();
    const custom = Object.values(wf).filter((n) => /IPAdapter|Impact|Detailer/.test(n.class_type));
    expect(custom).toEqual([]);
  });

  it('uses her reference face (IP-Adapter) when given', () => {
    const wf = buildFaceDetailWorkflow({ ...params, face: { image: 'face.png', weight: 0.6 } });
    expect(wf['15']).toBeDefined();
    expect(wf['24']!.inputs.model).toEqual(['15', 0]);
    const off = buildFaceDetailWorkflow({ ...params, face: { image: 'face.png', weight: 0 } });
    expect(off['15']).toBeUndefined();
    expect(off['24']!.inputs.model).toEqual(['1', 0]);
  });
});

describe('render pipeline', () => {
  const job = { workflow: { '1': { class_type: 'X', inputs: {} } }, detail };

  it('reads the PNG size from its header', () => {
    expect(pngSize(blankPng(832, 1216))).toEqual({ width: 832, height: 1216 });
    expect(() => pngSize(Buffer.from('nope'))).toThrow(/Not a PNG/);
  });

  it('redraws a small face: upload under a fixed name, second job, before/after kept', async () => {
    const big = blankPng(832, 1216);
    const { comfy, client } = comfyServing(big);
    const { detector } = stubDetector(SMALL_FACE);
    const result = await renderPicture(client, detector, job, silent);
    expect(result.detail).toBe('done');
    expect(comfy.queued).toHaveLength(2);
    expect(comfy.uploads.map((u) => u.name)).toEqual(['girllm_detail_source.png']);
    expect(comfy.queued[1]!.prompt['21']!.inputs).toMatchObject({ width: 392, height: 392 });
    expect(result.base.equals(big)).toBe(true);
  });

  it.each([
    ['off', { ...job, detail: undefined }, stubDetector(SMALL_FACE).detector],
    ['off', { ...job, detail: { ...detail, denoise: 0 } }, stubDetector(SMALL_FACE).detector],
    ['no-detector', job, undefined],
    ['no-detector', job, stubDetector(SMALL_FACE, { available: false }).detector],
    ['no-face', job, stubDetector(undefined).detector],
    ['close-up', job, stubDetector({ x: 100, y: 100, width: 600, height: 700, score: 1 }).detector],
  ] as const)('skips the face pass: %s', async (expected, theJob, detector) => {
    const { comfy, client } = comfyServing(blankPng(832, 1216));
    const result = await renderPicture(client, detector, theJob, silent);
    expect(result.detail).toBe(expected);
    expect(comfy.queued).toHaveLength(1);
    expect(result.png).toBe(result.base);
  });

  it('keeps the generated picture when the face pass fails', async () => {
    const { client } = comfyServing(blankPng(832, 1216));
    const warnings: string[] = [];
    const result = await renderPicture(client, stubDetector(SMALL_FACE, { fail: true }).detector, job, {
      warn: (_o, msg) => warnings.push(msg ?? ''),
    });
    expect(result.detail).toBe('failed');
    expect(result.png.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/face detail pass failed/);
  });

  it('still reports a cancel as a cancel', async () => {
    const { client } = comfyServing(blankPng(832, 1216));
    const ctrl = new AbortController();
    const detector = {
      available: () => true,
      detect: async () => {
        ctrl.abort();
        throw new Error('aborted');
      },
    } as unknown as FaceDetector;
    await expect(renderPicture(client, detector, job, silent, ctrl.signal)).rejects.toThrow();
  });
});

describe('model presets', () => {
  it('recognises the known models by file name', () => {
    expect(presetFor('RealVisXL_V5.0_fp16.safetensors')?.name).toBe('RealVisXL');
    expect(presetFor(JUGGERNAUT_MODEL.file)).toMatchObject({ sampler: 'dpmpp_2m', steps: 35, cfg: 4.5 });
    expect(presetFor('animagine-xl-4.0-opt.safetensors')?.scheduler).toBe('normal');
    expect(presetFor('my-own-model.safetensors')).toBeUndefined();
    expect(new Set(MODEL_PRESETS.map((p) => p.name)).size).toBe(MODEL_PRESETS.length);
  });

  it('pins the optional downloads (https + sha256)', () => {
    for (const model of Object.values(OPTIONAL_MODELS).flat()) {
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\//);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.file).toMatch(/^[\w.-]+\.safetensors$/); // never a path or a pickle
    }
    expect(Object.keys(OPTIONAL_MODELS).sort()).toEqual([
      '--anime',
      '--flux2-klein',
      '--flux2-klein-base',
      '--juggernaut',
    ]);
    expect(OPTIONAL_MODELS['--flux2-klein']!.map((m) => m.folder)).toEqual([
      'diffusion_models',
      'text_encoders',
      'vae',
    ]);
  });
});

describe('full-body framing', () => {
  it('uses the taller frame for full-body scenes in portrait orientation only', () => {
    expect(frameForScene('mirror selfie, full body, jeans', 832, 1216)).toEqual(FULL_BODY_SIZE);
    expect(frameForScene('Full-length photo, standing', 832, 1216)).toEqual(FULL_BODY_SIZE);
    expect(frameForScene('waist-up selfie', 832, 1216)).toEqual({ width: 832, height: 1216 });
    expect(frameForScene('full body, beach', 1216, 832)).toEqual({ width: 1216, height: 832 });
    // Same pixel budget as the default frame (same speed on the GPU).
    expect(FULL_BODY_SIZE.width * FULL_BODY_SIZE.height).toBeLessThanOrEqual(832 * 1216 * 1.03);
  });
});

describe('ImageService with the face detail pass', () => {
  const settings: ImageSettings = {
    checkpoint: 'sdxl.safetensors',
    width: 832,
    height: 1216,
    steps: 30,
    cfg: 4,
    sampler: 'dpmpp_sde',
    scheduler: 'karras',
    style: 'RAW photo',
    negative: 'cgi',
    detailStrength: 0.35,
  };

  async function setup(o: { detailStrength?: number; photo?: string } = {}) {
    const { db, store } = makeStore();
    const repo = CharacterRepository.fromCharacters([makeCharacter({ first_mes: 'Hey' })]);
    const raw = new ScriptedLlm({ chat: 'Coucou', photo: o.photo });
    const gate = new GpuGate();
    const llm = new GatedLlmProvider(raw, gate);
    const { comfy, client } = comfyServing(blankPng(832, 1216));
    const images = new ImageService(
      store,
      repo,
      new ImageStore(db),
      llm,
      client,
      gate,
      silent,
      {
        userName: 'Etienne',
        imagesDir: await mkdtemp(join(tmpdir(), 'girllm-img-')),
        settings: { ...settings, detailStrength: o.detailStrength ?? settings.detailStrength },
      },
      undefined,
      stubDetector(SMALL_FACE).detector,
    );
    const chat = new ChatService(
      repo,
      store,
      llm,
      { userName: 'Etienne', budget: { contextTokens: 4096, maxReplyTokens: 200 }, temperature: 0.7, topP: 0.9 },
      undefined,
      images,
    );
    return { chat, comfy, images };
  }

  it('redraws the face of chat photos with the same seed and settings', async () => {
    const { chat, comfy } = await setup();
    const s = chat.createSession('aria').session;
    await chat.sendPhoto(s.id, 'selfie');
    expect(comfy.queued).toHaveLength(2);
    const [gen, redraw] = comfy.queued.map((q) => q.prompt);
    expect(redraw!['24']!.inputs).toMatchObject({ seed: gen!['5']!.inputs.seed, denoise: 0.35, steps: 30 });
    expect(comfy.freed).toBe(1); // one GPU phase for both jobs
  });

  it('has no second job when the strength is 0', async () => {
    const { chat, comfy } = await setup({ detailStrength: 0 });
    await chat.sendPhoto(chat.createSession('aria').session.id, 'selfie');
    expect(comfy.queued).toHaveLength(1);
  });

  it('never redraws reference portraits (they are close-ups)', async () => {
    const { images, comfy } = await setup();
    await images.generatePortraits({ appearance: 'woman, brown hair', artStyle: 'realistic', gender: 'female' }, 2);
    expect(comfy.queued).toHaveLength(2);
    expect(comfy.queued.every((q) => q.prompt['20'] === undefined)).toBe(true);
  });

  it('draws full-body photos in the taller frame', async () => {
    const { chat, comfy } = await setup({
      photo: '{"caption": "Tadaa", "scene": "full body photo, standing, summer dress, kitchen"}',
    });
    await chat.sendPhoto(chat.createSession('aria').session.id, 'show me your dress');
    expect(comfy.queued[0]!.prompt['2']!.inputs).toMatchObject(FULL_BODY_SIZE);
  });
});

// TINY_PNG stays the default picture of FakeComfy (1×1: always a "close-up").
it('treats the 1×1 test picture as a close-up', async () => {
  const comfy = new FakeComfy();
  const client = new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch });
  const result = await renderPicture(
    client,
    stubDetector({ x: 0, y: 0, width: 1, height: 1, score: 1 }).detector,
    { workflow: {}, detail },
    silent,
  );
  expect(result.detail).toBe('close-up');
  expect(result.png.equals(TINY_PNG)).toBe(true);
});
