/**
 * Step 6c: the FLUX.2 face pass. In wide and full-body shots her face is too
 * small for the reference picture to carry her features; the pass redraws
 * it at 1024 px from her face and pastes it back (graph, prompt, render
 * pipeline, ImageService wiring).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { ChatService } from '../src/chat/chatService.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import type { FaceBox, FaceDetector } from '../src/images/faceDetector.js';
import {
  buildFlux2FaceDetailWorkflow,
  buildFlux2FacePrompt,
  buildFlux2Workflow,
  FLUX2_FACE_PASS,
  FLUX2_FACE_REDRAW_SIZE,
  FLUX2_KLEIN_MODEL,
  FLUX2_KLEIN_TEXT_ENCODER,
  FLUX2_VAE,
} from '../src/images/flux2Workflow.js';
import { ImageService, type ImageSettings } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { pngSize, renderPicture, type DetailSettings } from '../src/images/renderPipeline.js';
import { assertSafeStrict } from '../src/images/safety.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const classes = (wf: Record<string, { class_type: string }>) => Object.values(wf).map((n) => n.class_type);

/** A blank PNG of a given size (pngSize reads its header). */
const blankPng = (width: number, height: number): Buffer => PNG.sync.write(new PNG({ width, height }));

/** ComfyUI fake whose pictures are `png` (a full-body photo size). */
function comfyServing(png: Buffer, flux = true) {
  const comfy = new FakeComfy();
  if (flux) {
    comfy.flux = { unet: [FLUX2_KLEIN_MODEL.file], clip: [FLUX2_KLEIN_TEXT_ENCODER.file], vae: [FLUX2_VAE.file] };
  }
  const fetchImpl = (async (input: string | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === '/view' ? new Response(png) : comfy.fetch(input, init)) as typeof fetch;
  return { comfy, client: new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl }) };
}

/** A small face in a full-body picture (832×1216). */
const SMALL_FACE: FaceBox = { x: 380, y: 200, width: 120, height: 150, score: 0.98 };
/** Her face in her 512×512 profile picture. */
const PROFILE_FACE: FaceBox = { x: 156, y: 120, width: 200, height: 250, score: 0.99 };

/** Detector stub: her profile picture (512 px) → PROFILE_FACE, anything else → SMALL_FACE. */
function stubDetector(): FaceDetector {
  return {
    available: () => true,
    detect: async (png: Buffer) => (pngSize(png).width === 512 ? PROFILE_FACE : SMALL_FACE),
  } as unknown as FaceDetector;
}

const CROP = { x: 270, y: 110, width: 336, height: 336 };

describe('FLUX.2 face pass graph', () => {
  const params = {
    image: 'girllm_detail_source.png',
    crop: CROP,
    positive: 'close-up of her face',
    seed: 7,
    face: { image: 'girllm_face_aria_abc.png', crop: { x: 10, y: 20, width: 300, height: 300 } },
    ...FLUX2_FACE_PASS,
  };

  it('re-noises the face crop part-way down the Flux2 schedule and samples it with her face as reference', () => {
    const wf = buildFlux2FaceDetailWorkflow(params);
    // The crop, redrawn at 1024 px.
    expect(wf['31']!.inputs).toMatchObject({ image: ['30', 0], ...CROP });
    expect(wf['32']!.inputs).toMatchObject({ width: FLUX2_FACE_REDRAW_SIZE, height: FLUX2_FACE_REDRAW_SIZE });
    // Schedule of the redraw size, cut at startStep: the low part is sampled from the encoded crop.
    expect(wf['8']!.inputs).toEqual({ steps: 16, width: 1024, height: 1024 });
    expect(wf['34']).toEqual({ class_type: 'SplitSigmas', inputs: { sigmas: ['8', 0], step: 12 } });
    expect(wf['12']!.inputs).toMatchObject({ sigmas: ['34', 1], latent_image: ['33', 0] });
    expect(classes(wf)).not.toContain('EmptyFlux2LatentImage');
    // Distilled model: CFG 1, zeroed negative.
    expect(wf['11']!.inputs).toMatchObject({ cfg: 1, positive: ['23', 0], negative: ['24', 0] });
    expect(wf['5']!.class_type).toBe('ConditioningZeroOut');
    // Her face: the cropped profile picture, as "image 1".
    expect(wf['20']!.inputs.image).toBe('girllm_face_aria_abc.png');
    expect(wf['25']!.inputs).toMatchObject({ x: 10, y: 20, width: 300, height: 300 });
    // Back to the crop size, pasted at the same place with a feathered edge.
    expect(wf['35']!.inputs).toMatchObject({ width: 336, height: 336 });
    expect(wf['37']!.inputs).toMatchObject({ left: 40, top: 40, right: 40, bottom: 40 });
    expect(wf['38']!.inputs).toMatchObject({ destination: ['30', 0], source: ['35', 0], x: 270, y: 110 });
    expect(wf['7']!.inputs.images).toEqual(['38', 0]);
  });

  it('uses the whole profile picture when no face crop is known', () => {
    const wf = buildFlux2FaceDetailWorkflow({ ...params, face: { image: 'face.png' } });
    expect(wf['25']).toBeUndefined();
    expect(wf['21']!.inputs.image).toEqual(['20', 0]);
  });

  it('refuses a start step outside the schedule', () => {
    for (const startStep of [0, 16, 20]) {
      expect(() => buildFlux2FaceDetailWorkflow({ ...params, startStep })).toThrow(RangeError);
    }
  });

  it('keeps a strong enough but partial redraw (start sigma between 0.5 and 0.8)', () => {
    // 16-step Flux2 schedule at 1024²: … 12 → 0.754, 13 → 0.68 (see FLUX2_FACE_PASS).
    expect(FLUX2_FACE_PASS.startStep / FLUX2_FACE_PASS.steps).toBeGreaterThanOrEqual(0.7);
    expect(FLUX2_FACE_PASS.steps - FLUX2_FACE_PASS.startStep).toBeGreaterThanOrEqual(3);
  });

  it('leaves the main graph unchanged by the shared reference helper', () => {
    const wf = buildFlux2Workflow({
      positive: 'p',
      seed: 1,
      width: 832,
      height: 1216,
      steps: 8,
      cfg: 1,
      sampler: 'euler',
      referenceImage: 'face.png',
      referenceCrop: { x: 1, y: 2, width: 3, height: 3 },
    });
    expect(wf['23']!.inputs).toEqual({ conditioning: ['4', 0], latent: ['22', 0] });
    expect(wf['11']!.inputs).toMatchObject({ positive: ['23', 0], negative: ['24', 0] });
    expect(wf['21']!.inputs.image).toEqual(['25', 0]);
  });
});

describe('FLUX.2 face pass prompt', () => {
  it('asks for a close-up of her face from image 1, as an adult, keeping the picture', () => {
    const text = buildFlux2FacePrompt({ style: 'realistic', gender: 'female', appearance: 'long white hair' });
    expect(text).toMatch(/^A candid photo of an adult woman\. Scene: Close-up of her face/);
    expect(text).toContain('long white hair');
    expect(text).toContain('image 1');
    expect(text).toContain('head angle, expression, lighting');
    expect(() => {
      assertSafeStrict(text);
    }).not.toThrow();
  });

  it('speaks of him for a male character', () => {
    const text = buildFlux2FacePrompt({ style: 'realistic', gender: 'male', appearance: 'short beard' });
    expect(text).toContain('adult man');
    expect(text).toContain('Close-up of his face');
    expect(text).not.toMatch(/\bher\b/);
  });
});

describe('render pipeline with the FLUX.2 face pass', () => {
  const detail: DetailSettings = {
    kind: 'flux2',
    positive: 'face',
    seed: 3,
    face: { image: 'face.png' },
    ...FLUX2_FACE_PASS,
  };
  const job = { workflow: { '1': { class_type: 'X', inputs: {} } }, detail };

  it('runs the FLUX.2 face graph (not the SDXL one) on the uploaded picture', async () => {
    const { comfy, client } = comfyServing(blankPng(832, 1216));
    const result = await renderPicture(client, stubDetector(), job, silent);
    expect(result.detail).toBe('done');
    expect(comfy.uploads.map((u) => u.name)).toEqual(['girllm_detail_source.png']);
    const wf = comfy.queued[1]!.prompt;
    expect(classes(wf)).toContain('SplitSigmas');
    expect(classes(wf)).not.toContain('CheckpointLoaderSimple');
    expect(wf['30']!.inputs.image).toBe('girllm_detail_source.png');
  });

  it('skips close-ups, like the SDXL pass', async () => {
    const { comfy, client } = comfyServing(blankPng(832, 1216));
    const closeUp = {
      available: () => true,
      detect: async () => ({ x: 100, y: 100, width: 600, height: 700, score: 1 }),
    } as unknown as FaceDetector;
    const result = await renderPicture(client, closeUp, job, silent);
    expect(result.detail).toBe('close-up');
    expect(comfy.queued).toHaveLength(1);
  });
});

describe('ImageService: FLUX.2 photos get her face back', () => {
  const settings: ImageSettings = {
    engine: 'flux2-klein',
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

  async function setup(o: { detailStrength?: number; face?: boolean } = {}) {
    const { db, store } = makeStore();
    const repo = CharacterRepository.fromCharacters([makeCharacter({ first_mes: 'Hey' })]);
    const gate = new GpuGate();
    const llm = new GatedLlmProvider(new ScriptedLlm({ chat: 'Coucou' }), gate);
    const { comfy, client } = comfyServing(blankPng(832, 1216));
    const faces = new FaceStore(await mkdtemp(join(tmpdir(), 'girllm-faces-')));
    if (o.face !== false) {
      await faces.save('aria', { type: 'png', bytes: blankPng(512, 512), width: 512, height: 512 });
    }
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
      faces,
      stubDetector(),
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

  it('redraws her face in a chat photo from her (cropped) profile picture, same seed', async () => {
    const { chat, comfy } = await setup();
    const s = chat.createSession('aria').session;
    await chat.sendPhoto(s.id, 'full body photo in the park');
    expect(comfy.queued).toHaveLength(2);
    const [main, face] = comfy.queued.map((q) => q.prompt);
    expect(classes(face!)).toContain('SplitSigmas');
    expect(face!['20']!.inputs.image).toBe(main!['20']!.inputs.image);
    expect(String(face!['20']!.inputs.image)).toMatch(/^girllm_face_aria_/);
    // Same face crop as the main picture's reference (PROFILE_FACE × 1.3).
    expect(face!['25']!.inputs).toEqual(main!['25']!.inputs);
    expect(face!['10']!.inputs.noise_seed).toBe(main!['10']!.inputs.noise_seed);
    expect(String(face!['4']!.inputs.text)).toMatch(/Close-up of her face/);
    expect(comfy.freed).toBe(1);
  });

  it('also fixes her face in the chat backgrounds', async () => {
    const { comfy, images } = await setup();
    await images.generateBackgrounds('aria', 1);
    expect(comfy.queued).toHaveLength(2);
    expect(classes(comfy.queued[1]!.prompt)).toContain('SplitSigmas');
  });

  it('is off without her face, or when the face pass strength is 0', async () => {
    for (const o of [{ face: false }, { detailStrength: 0 }]) {
      const { chat, comfy } = await setup(o);
      const s = chat.createSession('aria').session;
      await chat.sendPhoto(s.id, 'full body photo in the park');
      expect(comfy.queued).toHaveLength(1);
    }
  });
});
