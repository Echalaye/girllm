/**
 * Step 4d: she writes first, photos she decides to send, reference face
 * (IP-Adapter) — service and HTTP level. (Her voice: tests/voice7.test.ts.)
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { ChatService, NotAllowedError, type ChatEvent } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { ImageService } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { buildTxt2ImgWorkflow } from '../src/images/workflow.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import type { PhotoFrequency } from '../src/config.js';
import { SqliteSessionStore } from '../src/chat/sqliteSessionStore.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm, TINY_PNG } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const HOST = '127.0.0.1:3210';

interface SetupOptions {
  chat?: string;
  firstMes?: string;
  photoFrequency?: PhotoFrequency;
  proactiveAfterMinutes?: number;
  faceWeight?: number;
  withFace?: boolean;
}

async function setup(o: SetupOptions = {}) {
  // One fake clock for the store's timestamps and the service's "now".
  let now = new Date('2026-10-04T10:00:00Z');
  const clock = {
    now: () => now,
    advance: (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000)),
  };
  const { db } = makeStore();
  const store = new SqliteSessionStore(db, clock.now);
  const characters = CharacterRepository.fromCharacters([
    makeCharacter({ first_mes: o.firstMes ?? '', appearance: 'woman, 26 years old, auburn hair' }),
  ]);
  const raw = new ScriptedLlm({ chat: o.chat ?? 'Coucou !' });
  const gate = new GpuGate();
  const llm = new GatedLlmProvider(raw, gate);
  const comfy = new FakeComfy();
  const faces = new FaceStore(await mkdtemp(join(tmpdir(), 'girllm-faces-')));
  if (o.withFace) await faces.save('aria', { type: 'png', bytes: TINY_PNG, width: 64, height: 64 });
  const images = new ImageService(
    store,
    characters,
    new ImageStore(db),
    llm,
    new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate,
    silent,
    {
      userName: 'Etienne',
      imagesDir: await mkdtemp(join(tmpdir(), 'girllm-img-')),
      settings: {
        checkpoint: 'sdxl.safetensors',
        width: 832,
        height: 1216,
        steps: 20,
        cfg: 5,
        sampler: 'euler',
        scheduler: 'normal',
        style: 'photo',
        negative: 'blurry',
        faceWeight: o.faceWeight ?? 0.7,
      },
    },
    faces,
  );
  const chat = new ChatService(
    characters,
    store,
    llm,
    () => ({
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.7,
      topP: 0.9,
      photoFrequency: o.photoFrequency ?? 'off',
      proactiveAfterMinutes: o.proactiveAfterMinutes ?? 0,
      now: clock.now,
    }),
    undefined,
    images,
  );
  return { db, store, characters, raw, comfy, images, chat, clock, faces };
}

const noop = () => {};

describe('she writes first', () => {
  it('opens an empty chat with a generated first message (stage direction never stored)', async () => {
    const { chat, raw } = await setup({ chat: 'Hey, t’es là ?' });
    const { session } = chat.createSession('aria');
    expect(session.messages).toEqual([]);
    expect(chat.canInitiate(session.id, 'opening')).toBe(true);

    const result = await chat.initiate(session.id, 'opening', noop);
    expect(result.message).toMatchObject({ role: 'assistant', content: 'Hey, t’es là ?', kind: 'opening' });
    const sent = raw.calls.at(-1)!;
    expect(sent.at(-1)).toMatchObject({ role: 'user' });
    expect(sent.at(-1)!.content).toMatch(/Etienne has just opened the chat/);
    expect(chat.getSession(session.id).session.messages).toHaveLength(1);
    expect(chat.canInitiate(session.id, 'opening')).toBe(false);
  });

  it('nudges only after the configured silence, never twice in a row', async () => {
    const { chat, raw, clock } = await setup({ firstMes: 'Salut', proactiveAfterMinutes: 60 });
    const { session } = chat.createSession('aria');

    clock.advance(30); // too early
    expect(chat.canInitiate(session.id, 'nudge')).toBe(false);
    await expect(chat.initiate(session.id, 'nudge', noop)).rejects.toThrow(NotAllowedError);
    clock.advance(90); // 2 hours after her greeting
    expect(chat.canInitiate(session.id, 'nudge')).toBe(true);
    const result = await chat.initiate(session.id, 'nudge', noop);
    expect(result.message?.kind).toBe('nudge');
    expect(raw.calls.at(-1)!.at(-1)!.content).toMatch(
      /hasn't written for 2 hours and hasn't answered Aria's last message/,
    );
    clock.advance(600);
    expect(chat.canInitiate(session.id, 'nudge')).toBe(false); // already nudged, waiting for him
  });

  it('is off when the setting is 0, and regenerating a nudge rewrites it as a nudge', async () => {
    const { chat } = await setup({ firstMes: 'Salut', proactiveAfterMinutes: 0 });
    const { session } = chat.createSession('aria');
    expect(chat.canInitiate(session.id, 'nudge')).toBe(false);

    const opened = await setup({ chat: 'Bonjour toi' });
    const s2 = opened.chat.createSession('aria').session;
    await opened.chat.initiate(s2.id, 'opening', noop);
    const again = await opened.chat.regenerate(s2.id, noop);
    expect(again.message?.kind).toBe('opening');
    expect(opened.chat.getSession(s2.id).session.messages).toHaveLength(1);
  });
});

describe('photos she decides to send', () => {
  it('strips the tag, sends "done" before the photo, and attaches the photo to her message', async () => {
    const { chat, comfy } = await setup({
      firstMes: 'Salut',
      photoFrequency: 'rare',
      chat: 'Regarde où je suis ! [photo: selfie on a sunny terrace, coffee cup]',
    });
    const { session } = chat.createSession('aria');
    const tokens: string[] = [];
    const events: ChatEvent['type'][] = [];
    const result = await chat.sendMessage(
      session.id,
      'Tu fais quoi ?',
      (t) => tokens.push(t),
      undefined,
      (e) => events.push(e.type),
    );
    expect(tokens.join('')).toBe('Regarde où je suis ! ');
    expect(events).toEqual(['done', 'photo_start', 'photo']);
    const stored = chat.getSession(session.id).session.messages.at(-1)!;
    expect(stored.content).toBe('Regarde où je suis !');
    expect(stored.imageId).toBeTruthy();
    expect(result.message?.id).toBe(stored.id);
    expect(comfy.queued).toHaveLength(1);
  });

  it('respects the cooldown, unless he asks for a photo', async () => {
    const env = await setup({ firstMes: 'Salut', photoFrequency: 'rare', chat: 'Tiens ! [photo: selfie]' });
    const { session } = env.chat.createSession('aria');
    await env.chat.sendMessage(session.id, 'Salut', noop);
    expect(env.comfy.queued).toHaveLength(1);
    // Right after a photo: the tag is hidden but no photo is generated…
    await env.chat.sendMessage(session.id, 'Et sinon ?', noop);
    expect(env.comfy.queued).toHaveLength(1);
    expect(env.chat.getSession(session.id).session.messages.at(-1)!.content).toBe('Tiens !');
    // …unless he asks.
    await env.chat.sendMessage(session.id, 'Envoie-moi une photo de toi !', noop);
    expect(env.comfy.queued).toHaveLength(2);
    const replies = env.raw.calls.filter((c) => c[0]!.content.includes('[End of notes'));
    const system = replies.at(-1)![0]!.content;
    expect(system).toMatch(/Etienne is asking Aria for a photo/);
  });

  it('never generates when photos are off, and reports a refused photo without losing the text', async () => {
    const off = await setup({ firstMes: 'Salut', photoFrequency: 'off', chat: 'Ok [photo: selfie]' });
    const s = off.chat.createSession('aria').session;
    await off.chat.sendMessage(s.id, 'Envoie une photo', noop);
    expect(off.comfy.queued).toHaveLength(0);
    expect(off.raw.calls.at(-1)![0]!.content).not.toMatch(/\[photo:/);

    const refused = await setup({ firstMes: 'Salut', photoFrequency: 'often', chat: 'Ok [photo: as a schoolgirl]' });
    const s2 = refused.chat.createSession('aria').session;
    const events: ChatEvent[] = [];
    await refused.chat.sendMessage(s2.id, 'Hey', noop, undefined, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['done', 'photo_start', 'photo_error']);
    expect(refused.chat.getSession(s2.id).session.messages.at(-1)).toMatchObject({ content: 'Ok', imageId: null });
  });
});

describe('reference face (IP-Adapter)', () => {
  it('adds the IP-Adapter nodes and patches every sampler', () => {
    const params = {
      checkpoint: 'x',
      positive: 'p',
      negative: 'n',
      width: 832,
      height: 1216,
      steps: 20,
      cfg: 5,
      sampler: 'euler',
      scheduler: 'normal',
      seed: 1,
      hires: { scale: 1.25, denoise: 0.3, steps: 10 },
    };
    const wf = buildTxt2ImgWorkflow({ ...params, face: { image: 'girllm_face_aria.png', weight: 0.7 } });
    expect(wf['15']?.class_type).toBe('IPAdapterAdvanced');
    expect(wf['15']?.inputs).toMatchObject({ weight: 0.7, image: ['12', 0], model: ['1', 0] });
    expect(wf['5']?.inputs.model).toEqual(['15', 0]);
    expect(wf['10']?.inputs.model).toEqual(['15', 0]);

    const plain = buildTxt2ImgWorkflow({ ...params, face: { image: 'f', weight: 0 } });
    expect(plain['15']).toBeUndefined();
    expect(plain['5']?.inputs.model).toEqual(['1', 0]);
  });

  it('uploads her face once and uses it in her photos when everything is installed', async () => {
    const { chat, comfy } = await setup({ firstMes: 'Salut', withFace: true });
    const s = chat.createSession('aria').session;
    await chat.sendPhoto(s.id, 'selfie');
    await chat.sendPhoto(s.id, 'selfie at the beach');
    expect(comfy.uploads).toHaveLength(1);
    expect(comfy.uploads[0]!.name).toMatch(/^girllm_face_aria_[0-9a-f]{16}\.png$/);
    expect(comfy.queued.map((q) => q.prompt['15']?.class_type)).toEqual(['IPAdapterAdvanced', 'IPAdapterAdvanced']);
  });

  it('makes the photo without the face when the nodes are missing, the weight is 0, or there is no face', async () => {
    for (const variant of ['no-nodes', 'weight-0', 'no-face'] as const) {
      const env = await setup({
        firstMes: 'Salut',
        withFace: variant !== 'no-face',
        faceWeight: variant === 'weight-0' ? 0 : 0.7,
      });
      if (variant === 'no-nodes') env.comfy.ipAdapter.nodes = false;
      const s = env.chat.createSession('aria').session;
      await env.chat.sendPhoto(s.id, 'selfie');
      expect(env.comfy.queued[0]!.prompt['15'], variant).toBeUndefined();
    }
  });

  it('reports why faces are not applied', async () => {
    const env = await setup();
    env.comfy.ipAdapter.clipFiles = [];
    expect((await env.images.status()).face).toEqual({
      ready: false,
      reason: expect.stringMatching(/CLIP-ViT-H-14.*npm run setup:images/),
    });
  });
});

describe('HTTP: she writes first', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('streams an opening, and answers 204 when it is not the moment', async () => {
    const env = await setup({ chat: 'Coucou toi' });
    app = await buildApp({
      chat: env.chat,
      characters: env.characters,
      llm: new ScriptedLlm(),
      memoryStore: new MemoryStore(env.db),
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    const { session } = env.chat.createSession('aria');
    const post = (reason: string) =>
      app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/initiate`,
        headers: { host: HOST, 'content-type': 'application/json' },
        payload: JSON.stringify({ reason }),
      });
    const first = await post('opening');
    expect(first.headers['content-type']).toContain('text/event-stream');
    expect(first.body).toContain('Coucou toi');
    expect((await post('opening')).statusCode).toBe(204);
    expect((await post('nudge')).statusCode).toBe(204);
    expect((await post('hello')).statusCode).toBe(400);
  });
});
