/**
 * Step 5: art styles (realistic / anime), gender, chat backgrounds.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { CharacterService } from '../src/characters/characterService.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { CharacterInputSchema, type Character } from '../src/characters/schema.js';
import { ChatService } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import {
  ANIME_CHECKPOINT_FILE,
  buildNegativePrompt,
  buildPositivePrompt,
  subjectTags,
} from '../src/images/artStyle.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { ImageService, ImageUnavailableError, type ImageSettings } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { buildPhotoPrompt } from '../src/images/photoPrompt.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm, TINY_PNG } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const HOST = '127.0.0.1:3210';

const realistic: ImageSettings = {
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
const anime: ImageSettings = {
  ...realistic,
  checkpoint: ANIME_CHECKPOINT_FILE,
  steps: 28,
  cfg: 5,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  style: 'masterpiece, high score',
  negative: 'lowres, worst quality',
  faceWeight: 0,
};

async function setup(characters: Character[], o: { anime?: ImageSettings | undefined } = { anime }) {
  const { db, store } = makeStore();
  const repo = CharacterRepository.fromCharacters(characters);
  const raw = new ScriptedLlm({ chat: 'Coucou' });
  const gate = new GpuGate();
  const llm = new GatedLlmProvider(raw, gate);
  const comfy = new FakeComfy();
  comfy.checkpoints = ['sdxl.safetensors', ANIME_CHECKPOINT_FILE];
  const faces = new FaceStore(await mkdtemp(join(tmpdir(), 'girllm-faces-')));
  const images = new ImageService(
    store,
    repo,
    new ImageStore(db),
    llm,
    new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate,
    silent,
    {
      userName: 'Etienne',
      imagesDir: await mkdtemp(join(tmpdir(), 'girllm-img-')),
      settings: realistic,
      anime: o.anime,
    },
    faces,
  );
  const chat = new ChatService(
    repo,
    store,
    llm,
    {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.7,
      topP: 0.9,
      photoFrequency: 'often',
    },
    undefined,
    images,
  );
  return { db, store, repo, raw, comfy, faces, images, chat };
}

const mika = () =>
  makeCharacter({
    id: 'mika',
    name: 'Mika',
    artStyle: 'anime',
    appearance: 'long hair, black hair, red eyes',
    first_mes: 'Yo',
  });

describe('prompt building per art style', () => {
  it('always states an adult, in each style and gender', () => {
    expect(subjectTags('anime', 'female')).toBe('1girl, solo, adult, mature female');
    expect(subjectTags('anime', 'male')).toBe('1boy, solo, adult, mature male');
    expect(subjectTags('realistic', 'male')).toBe('adult, mature adult, man, solo');
  });

  it('puts anime quality tags last and realistic style tags first', () => {
    const parts = { gender: 'female' as const, styleTags: 'QUALITY', appearance: 'LOOK', scene: 'SCENE' };
    expect(buildPositivePrompt({ ...parts, style: 'anime' })).toBe(
      '1girl, solo, adult, mature female, LOOK, SCENE, QUALITY',
    );
    expect(buildPositivePrompt({ ...parts, style: 'realistic' })).toBe(
      'adult, mature adult, woman, solo, QUALITY, LOOK, SCENE',
    );
  });

  it('adds youth-related negatives, more for anime', () => {
    expect(buildNegativePrompt('realistic', 'cgi')).toMatch(/^cgi, child, .*loli/);
    expect(buildNegativePrompt('anime', 'lowres')).toMatch(/shota, aged down/);
    expect(buildNegativePrompt('realistic', 'cgi')).not.toMatch(/shota/);
  });

  it('asks the LLM for Danbooru tags for anime characters', () => {
    const prompt = buildPhotoPrompt({ character: mika(), userName: 'Etienne', recent: [], summary: '', request: '' });
    expect(prompt[0]!.content).toMatch(/ANIME image generator.*Danbooru/s);
    const real = buildPhotoPrompt({ character: makeCharacter(), userName: 'E', recent: [], summary: '', request: '' });
    expect(real[0]!.content).not.toMatch(/Danbooru/);
  });
});

describe('ImageService with two profiles', () => {
  it('draws anime characters with the anime model and its settings', async () => {
    const { chat, comfy } = await setup([mika()]);
    const s = chat.createSession('mika').session;
    await chat.sendPhoto(s.id, 'selfie');
    const wf = comfy.queued[0]!.prompt;
    expect(wf['1']!.inputs.ckpt_name).toBe(ANIME_CHECKPOINT_FILE);
    expect(wf['5']!.inputs).toMatchObject({ sampler_name: 'euler_ancestral', scheduler: 'normal', steps: 28, cfg: 5 });
    const positive = wf['3']!.inputs.text as string;
    expect(positive.startsWith('1girl, solo, adult, mature female, long hair, black hair, red eyes')).toBe(true);
    expect(positive.endsWith('masterpiece, high score')).toBe(true);
    expect(wf['4']!.inputs.text).toMatch(/^lowres, worst quality, .*shota/);
    expect(wf['15']).toBeUndefined(); // face weight 0 for anime
  });

  it('keeps realistic characters on the realistic model, with "man" for male characters', async () => {
    const { chat, comfy } = await setup([
      makeCharacter({ gender: 'male', appearance: 'man, 30 years old', first_mes: 'Hey' }),
    ]);
    const s = chat.createSession('aria').session;
    await chat.sendPhoto(s.id, '');
    expect(comfy.queued[0]!.prompt['1']!.inputs.ckpt_name).toBe('sdxl.safetensors');
    expect(comfy.queued[0]!.prompt['3']!.inputs.text).toMatch(/^adult, mature adult, man, solo, RAW photo/);
  });

  it('explains how to install the anime model when it is missing', async () => {
    const { chat, images, comfy } = await setup([mika()], { anime: undefined });
    const s = chat.createSession('mika').session;
    await expect(chat.sendPhoto(s.id, 'selfie')).rejects.toThrow(ImageUnavailableError);
    await expect(chat.sendPhoto(s.id, 'selfie')).rejects.toThrow(/setup:images -- --anime/);
    expect(images.configured('anime')).toBe(false);
    expect((await images.status()).anime).toMatchObject({ available: false });
    comfy.checkpoints = ['sdxl.safetensors'];
    const env = await setup([mika()]);
    env.comfy.checkpoints = ['sdxl.safetensors'];
    expect((await env.images.status()).anime.reason).toMatch(
      /not found in ComfyUI \(run: npm run setup:images -- --anime\)/,
    );
  });

  it('makes anime portraits and landscape backgrounds', async () => {
    const { images, comfy, faces } = await setup([mika(), makeCharacter()]);
    await images.generatePortraits({ appearance: 'short hair', artStyle: 'anime', gender: 'male' }, 2);
    expect(comfy.queued).toHaveLength(2);
    expect(comfy.queued[0]!.prompt['3']!.inputs.text).toMatch(/^1boy, solo, adult, mature male, short hair, portrait/);

    await faces.save('aria', { type: 'png', bytes: TINY_PNG, width: 64, height: 64 });
    const pngs = await images.generateBackgrounds('aria', 2);
    expect(pngs).toHaveLength(2);
    const bg = comfy.queued[2]!.prompt;
    expect(bg['2']!.inputs).toMatchObject({ width: 1216, height: 832 });
    expect(bg['15']?.class_type).toBe('IPAdapterAdvanced'); // her face in her scene
  });

  it("doesn't offer spontaneous photos when the character's model is missing", async () => {
    const { chat, raw } = await setup([mika()], { anime: undefined });
    const s = chat.createSession('mika').session;
    await chat.sendMessage(s.id, 'Salut', () => {});
    expect(raw.calls.at(-1)![0]!.content).not.toMatch(/\[photo:/);
  });
});

describe('cards: art style, gender, background', () => {
  it('defaults old cards to realistic / female / scene and round-trips the fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girllm-cards-'));
    const repo = await CharacterRepository.loadFromDirectory(dir, silent);
    const saved = await repo.save(CharacterInputSchema.parse({ name: 'Old', description: 'adult' }));
    expect(saved).toMatchObject({ artStyle: 'realistic', gender: 'female', backgroundMode: 'scene' });
    await repo.save(
      CharacterInputSchema.parse({
        name: 'Kai',
        description: 'adult',
        artStyle: 'anime',
        gender: 'male',
        background: 'latest',
      }),
    );
    const reloaded = await CharacterRepository.loadFromDirectory(dir, silent);
    expect(reloaded.get('kai')).toMatchObject({ artStyle: 'anime', gender: 'male', backgroundMode: 'latest' });
    expect(() => CharacterInputSchema.parse({ name: 'X', artStyle: 'cartoon' })).toThrow();
  });
});

describe('HTTP: chat backgrounds', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('generates scene candidates, promotes one, serves it, and deletes it with the character', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girllm-cards-'));
    const env = await setup([]);
    const repo = await CharacterRepository.loadFromDirectory(dir, silent);
    const images = new ImageService(
      env.store,
      repo,
      new ImageStore(env.db),
      new ScriptedLlm(),
      new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: env.comfy.fetch }),
      new GpuGate(),
      silent,
      { userName: 'Etienne', imagesDir: await mkdtemp(join(tmpdir(), 'girllm-img-')), settings: realistic, anime },
      env.faces,
    );
    const chat = new ChatService(repo, env.store, new ScriptedLlm(), {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.7,
      topP: 0.9,
    });
    const backgrounds = new FaceStore(await mkdtemp(join(tmpdir(), 'girllm-bg-')));
    const memoryStore = new MemoryStore(env.db);
    app = await buildApp({
      chat,
      characters: repo,
      llm: new ScriptedLlm(),
      memoryStore,
      images,
      faces: env.faces,
      backgrounds,
      characterService: new CharacterService(repo, chat, env.store, memoryStore, env.faces, backgrounds),
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    const req = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: { host: HOST, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });

    await req('POST', '/api/characters', { name: 'Lena', description: 'adult', appearance: 'woman, 27 years old' });
    const gen = await req('POST', '/api/characters/lena/background/candidates');
    expect(gen.statusCode).toBe(200);
    const { candidates } = gen.json<{ candidates: string[] }>();
    expect(candidates).toHaveLength(2);
    expect((await req('POST', `/api/characters/lena/background/candidates/${candidates[0]}`)).statusCode).toBe(204);
    const served = await req('GET', '/api/characters/lena/background');
    expect(served.headers['content-type']).toBe('image/png');
    expect((await req('GET', '/api/characters')).json()[0]).toMatchObject({ hasBackground: true, background: 'scene' });

    await req('DELETE', '/api/characters/lena');
    expect(backgrounds.get('lena')).toBeUndefined();
  });
});
