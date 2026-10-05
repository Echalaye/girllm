/**
 * Step 6: FLUX.2 [klein] in the app (realistic characters), its stricter
 * safety check, and retaking a photo.
 */
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import type { Character } from '../src/characters/schema.js';
import { ChatService } from '../src/chat/chatService.js';
import { parseConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { FLUX2_KLEIN_MODEL, FLUX2_KLEIN_TEXT_ENCODER, FLUX2_VAE } from '../src/images/flux2Workflow.js';
import {
  ImageService,
  ImageUnavailableError,
  type ImageServiceOptions,
  type ImageSettings,
} from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { assertSafe, assertSafeStrict, ImageRefusedError, mentionsYoungLook } from '../src/images/safety.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm, TINY_PNG } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const HOST = '127.0.0.1:3210';
const FLUX_FILES = {
  unet: [FLUX2_KLEIN_MODEL.file],
  clip: [FLUX2_KLEIN_TEXT_ENCODER.file],
  vae: [FLUX2_VAE.file],
};

const realistic: ImageSettings = {
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
  faceWeight: 0.7,
};

async function setup(
  o: {
    settings?: ImageSettings;
    flux?: boolean;
    photo?: string;
    characters?: Character[];
    face?: boolean;
  } = {},
) {
  const { db, store } = makeStore();
  const repo = CharacterRepository.fromCharacters(o.characters ?? [makeCharacter({ first_mes: 'Hey' })]);
  const raw = new ScriptedLlm({ chat: 'Coucou', photo: o.photo });
  const gate = new GpuGate();
  const llm = new GatedLlmProvider(raw, gate);
  const comfy = new FakeComfy();
  if (o.flux !== false) comfy.flux = FLUX_FILES;
  const faces = new FaceStore(await mkdtemp(join(tmpdir(), 'girllm-faces-')));
  if (o.face) await faces.save('aria', { type: 'png', bytes: TINY_PNG, width: 1, height: 1 });
  const imageStore = new ImageStore(db);
  const options: ImageServiceOptions = {
    userName: 'Etienne',
    imagesDir: await mkdtemp(join(tmpdir(), 'girllm-img-')),
    settings: o.settings ?? realistic,
  };
  const images = new ImageService(
    store,
    repo,
    imageStore,
    llm,
    new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate,
    silent,
    options,
    faces,
  );
  const chat = new ChatService(
    repo,
    store,
    llm,
    { userName: 'Etienne', budget: { contextTokens: 4096, maxReplyTokens: 200 }, temperature: 0.7, topP: 0.9 },
    undefined,
    images,
  );
  return { db, store, repo, comfy, chat, images, imageStore, faces };
}

const classes = (wf: Record<string, { class_type: string }>) => Object.values(wf).map((n) => n.class_type);

describe('stricter safety for models without a negative prompt', () => {
  it('refuses young-look words that the normal check lets through', () => {
    for (const text of ['pigtails, school bag', 'young-looking', 'flat-chested', 'visage enfantin', 'couettes']) {
      expect(mentionsYoungLook(text)).toBe(true);
      expect(() => {
        assertSafe(text);
      }).not.toThrow();
      expect(() => {
        assertSafeStrict(text);
      }).toThrow(ImageRefusedError);
    }
  });

  it('keeps refusing what the normal check refuses, and accepts ordinary scenes', () => {
    expect(() => {
      assertSafeStrict('a teenager');
    }).toThrow(ImageRefusedError);
    expect(() => {
      assertSafeStrict('woman, 26 years old, reading a book on a sofa, she lies down');
    }).not.toThrow();
    // Whole words only: "bracelet" is not "braces".
    expect(mentionsYoungLook('silver bracelet')).toBe(false);
  });
});

describe('realistic photos with FLUX.2 [klein]', () => {
  it('draws chat photos with FLUX.2 (8 steps, sentences, her face as reference), no SDXL detail pass', async () => {
    const { chat, comfy } = await setup({ face: true });
    const s = chat.createSession('aria').session;
    await chat.sendPhoto(s.id, 'selfie');
    expect(comfy.queued).toHaveLength(1); // no second (face detail) job
    const wf = comfy.queued[0]!.prompt;
    expect(classes(wf)).toContain('UNETLoader');
    expect(classes(wf)).not.toContain('CheckpointLoaderSimple');
    expect(wf['1']!.inputs.unet_name).toBe(FLUX2_KLEIN_MODEL.file);
    expect(wf['8']!.inputs.steps).toBe(8);
    expect(wf['11']!.inputs.cfg).toBe(1);
    expect(wf['4']!.inputs.text).toMatch(/^A candid photo of an adult woman\. Scene: /);
    expect(wf['4']!.inputs.text).toContain('image 1');
    expect(String(wf['20']!.inputs.image)).toMatch(/^girllm_face_aria_/);
    expect(comfy.freed).toBe(1);
  });

  it('draws without a reference when she has no face yet', async () => {
    const { chat, comfy } = await setup();
    await chat.sendPhoto(chat.createSession('aria').session.id, '');
    const wf = comfy.queued[0]!.prompt;
    expect(wf['20']).toBeUndefined();
    expect(wf['4']!.inputs.text).not.toContain('image 1');
  });

  it('uses the taller frame for full-body scenes', async () => {
    const { chat, comfy } = await setup({
      photo: '{"caption": "Ta-da", "scene": "full body photo, standing, summer dress, kitchen"}',
    });
    await chat.sendPhoto(chat.createSession('aria').session.id, '');
    expect(comfy.queued[0]!.prompt['6']!.inputs).toMatchObject({ width: 768, height: 1344 });
  });

  it('refuses a scene with young-look words (strict check), but SDXL keeps its normal check', async () => {
    const photo = '{"caption": "Hi", "scene": "selfie, pigtails, bedroom"}';
    const flux = await setup({ photo });
    await expect(flux.chat.sendPhoto(flux.chat.createSession('aria').session.id, '')).rejects.toThrow(
      ImageRefusedError,
    );
    expect(flux.comfy.queued).toHaveLength(0);
    const sdxl = await setup({ photo, settings: { ...realistic, engine: 'sdxl' } });
    await sdxl.chat.sendPhoto(sdxl.chat.createSession('aria').session.id, '');
    expect(sdxl.comfy.queued[0]!.prompt['1']!.class_type).toBe('CheckpointLoaderSimple');
  });

  it('falls back to the SDXL checkpoint while FLUX.2 is not installed', async () => {
    const { chat, comfy, images } = await setup({ flux: false });
    await chat.sendPhoto(chat.createSession('aria').session.id, '');
    expect(comfy.queued[0]!.prompt['1']!.inputs.ckpt_name).toBe('sdxl.safetensors');
    const st = await images.status();
    expect(st).toMatchObject({ available: true, engine: 'sdxl' });
    expect(st.note).toMatch(/FLUX\.2 \[klein\] unavailable.*using the SDXL checkpoint/);
  });

  it('says how to install FLUX.2 when there is no SDXL checkpoint to fall back on', async () => {
    const { chat, images } = await setup({ flux: false, settings: { ...realistic, checkpoint: undefined } });
    const s = chat.createSession('aria').session;
    await expect(chat.sendPhoto(s.id, '')).rejects.toThrow(ImageUnavailableError);
    await expect(chat.sendPhoto(s.id, '')).rejects.toThrow(/setup:images -- --flux2-klein/);
    expect(images.configured('realistic')).toBe(true); // FLUX.2 chosen: the button stays, the error explains
    expect((await images.status()).reason).toMatch(/FLUX\.2 \[klein\] unavailable/);
  });

  it('reports FLUX.2 in the status, with the reference face always ready', async () => {
    const { images } = await setup();
    expect(await images.status()).toMatchObject({ available: true, engine: 'flux2-klein', face: { ready: true } });
  });

  it('makes reference portraits (no face reference) and backgrounds (with her face) with FLUX.2', async () => {
    const { images, comfy } = await setup({ face: true });
    await images.generatePortraits({ appearance: 'woman, brown hair', artStyle: 'realistic', gender: 'female' }, 2);
    expect(comfy.queued).toHaveLength(2);
    expect(comfy.queued.every((q) => q.prompt['1']!.class_type === 'UNETLoader' && !q.prompt['20'])).toBe(true);
    expect(comfy.queued[0]!.prompt['6']!.inputs).toMatchObject({ width: 1024, height: 1024 });
    comfy.queued = [];
    await images.generateBackgrounds('aria', 1);
    expect(comfy.queued[0]!.prompt['6']!.inputs).toMatchObject({ width: 1216, height: 832 });
    expect(comfy.queued[0]!.prompt['20']).toBeDefined();
  });

  it('keeps anime characters on their SDXL model', async () => {
    const mika = makeCharacter({ id: 'mika', artStyle: 'anime', appearance: 'long hair', first_mes: 'Yo' });
    const { chat, comfy } = await setup({ characters: [mika] });
    // No anime profile configured: a clear error, never FLUX.2.
    await expect(chat.sendPhoto(chat.createSession('mika').session.id, '')).rejects.toThrow(ImageUnavailableError);
    expect(comfy.queued).toHaveLength(0);
  });
});

describe('retaking a photo', () => {
  it('draws the same scene again with a new seed and replaces the picture in its message', async () => {
    const { chat, comfy, imageStore, store, images } = await setup({ face: true });
    const s = chat.createSession('aria').session;
    const first = await chat.sendPhoto(s.id, 'selfie');
    const old = imageStore.get(first.imageId!)!;
    const oldPath = images.filePath(old);
    expect(existsSync(oldPath)).toBe(true);

    const updated = await chat.retakePhoto(s.id, old.id);
    expect(updated.id).toBe(first.id);
    expect(updated.imageId).not.toBe(old.id);
    const next = imageStore.get(updated.imageId!)!;
    expect(next.scene).toBe(old.scene);
    expect(next.seed).not.toBe(old.seed);
    expect(comfy.queued.at(-1)!.prompt['10']!.inputs.noise_seed).toBe(next.seed);
    // The message shows the new picture; the old one is gone (row and file).
    expect(store.get(s.id)!.messages.find((m) => m.id === first.id)!.imageId).toBe(next.id);
    expect(imageStore.get(old.id)).toBeUndefined();
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(images.filePath(next))).toBe(true);
  });

  it('refuses an image that is not in this chat', async () => {
    const { chat } = await setup();
    const a = chat.createSession('aria').session;
    const b = chat.createSession('aria').session;
    const photo = await chat.sendPhoto(a.id, '');
    await expect(chat.retakePhoto(b.id, photo.imageId!)).rejects.toThrow(/Photo not found/);
  });

  it('keeps the old picture when the retake fails', async () => {
    const { chat, comfy, imageStore } = await setup();
    const s = chat.createSession('aria').session;
    const photo = await chat.sendPhoto(s.id, '');
    comfy.failWith = 'execution';
    await expect(chat.retakePhoto(s.id, photo.imageId!)).rejects.toThrow();
    expect(imageStore.get(photo.imageId!)).toBeDefined();
  });
});

describe('retake route', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('POST /api/sessions/:id/images/:imageId/retake returns the message with its new image', async () => {
    const env = await setup();
    const s = env.chat.createSession('aria').session;
    const photo = await env.chat.sendPhoto(s.id, '');
    app = await buildApp({
      chat: env.chat,
      characters: env.repo,
      llm: new ScriptedLlm(),
      images: env.images,
      memoryStore: new MemoryStore(env.db),
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s.id}/images/${photo.imageId}/retake`,
      headers: { host: HOST, origin: `http://${HOST}` },
    });
    expect(res.statusCode).toBe(200);
    const { message } = res.json<{ message: { id: string; imageId: string } }>();
    expect(message.id).toBe(photo.id);
    expect(message.imageId).not.toBe(photo.imageId);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s.id}/images/00000000-0000-4000-8000-000000000000/retake`,
      headers: { host: HOST, origin: `http://${HOST}` },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/sessions/${s.id}/images/not-a-uuid/retake`,
      headers: { host: HOST, origin: `http://${HOST}` },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('configuration', () => {
  it('uses FLUX.2 [klein] for realistic characters by default, sdxl on request', () => {
    expect(parseConfig({}).images.realisticEngine).toBe('flux2-klein');
    expect(parseConfig({ REALISTIC_ENGINE: 'sdxl' }).images.realisticEngine).toBe('sdxl');
    expect(() => parseConfig({ REALISTIC_ENGINE: 'dalle' })).toThrow();
  });
});
