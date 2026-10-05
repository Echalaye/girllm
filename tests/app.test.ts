import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { ChatService } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { FakeLlm, makeCharacter, makeStore } from './helpers.js';

const HOST = '127.0.0.1:3210';
let app: FastifyInstance;

/** Fake voice engines: echo-style, no models needed. */
const fakeVoice = {
  stt: {
    status: () => ({ available: true, model: 'fake-stt' }),
    transcribe: async (a: { samples: Float32Array }) => `heard ${a.samples.length} samples`,
  },
  tts: {
    status: () => ({ available: true, model: 'fake-tts' }),
    lastText: '',
    async synthesize(text: string) {
      this.lastText = text;
      return { samples: new Float32Array(100), sampleRate: 22050 };
    },
  },
};

async function makeApp(withVoice = false) {
  const llm = new FakeLlm(['Hi', ' Etienne']);
  const characters = CharacterRepository.fromCharacters([makeCharacter()]);
  const { db, store } = makeStore();
  const chat = new ChatService(characters, store, llm, {
    userName: 'Etienne',
    budget: { contextTokens: 4096, maxReplyTokens: 200 },
    temperature: 0.8,
    topP: 0.9,
  });
  app = await buildApp({
    chat,
    characters,
    llm,
    memoryStore: new MemoryStore(db),
    voice: withVoice ? fakeVoice : undefined,
    allowedHosts: [HOST],
    userName: 'Etienne',
  });
  return app;
}

afterEach(async () => {
  await app.close();
});

const json = (body: unknown) => ({
  headers: { host: HOST, 'content-type': 'application/json' },
  payload: JSON.stringify(body),
});

describe('HTTP API', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/characters', headers: { host: 'evil.example:3210' } });
    expect(res.statusCode).toBe(421);
  });

  it('rejects cross-origin requests', async () => {
    await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      ...json({ characterId: 'aria' }),
      headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves the UI with a strict CSP', async () => {
    await makeApp();
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('lists characters without internal fields', async () => {
    await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/characters', headers: { host: HOST } });
    expect(res.json()).toEqual([
      {
        id: 'aria',
        name: 'Aria',
        creatorNotes: '',
        tags: [],
        style: 'roleplay',
        artStyle: 'realistic',
        gender: 'female',
        background: 'scene',
        hasFace: false,
        hasBackground: false,
      },
    ]);
  });

  it('validates input', async () => {
    await makeApp();
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: '../etc' }) })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: 'ghost' }) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions/not-a-uuid', headers: { host: HOST } })).statusCode,
    ).toBe(400);
  });

  it('creates a session and streams a reply as SSE', async () => {
    await makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: 'aria' }) });
    expect(created.statusCode).toBe(201);
    const { session } = created.json();
    expect(session.messages[0].content).toBe('Hi Etienne!'); // macros resolved in the greeting

    const empty = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/messages`,
      ...json({ text: '   ' }),
    });
    expect(empty.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/messages`,
      ...json({ text: 'Hello' }),
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: token\ndata: {"text":"Hi"}');
    expect(res.body).toContain('event: done');

    const after = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, headers: { host: HOST } });
    expect(after.json().session.messages.at(-1).content).toBe('Hi Etienne');
  });
});

describe('HTTP API - chats and memories', () => {
  it('lists and deletes chats', async () => {
    await makeApp();
    const { session } = (
      await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: 'aria' }) })
    ).json();
    const list = await app.inject({ method: 'GET', url: '/api/characters/aria/sessions', headers: { host: HOST } });
    expect(list.json()).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: { host: HOST } });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: { host: HOST } });
    expect(again.statusCode).toBe(404);
  });

  it('adds, lists and deletes memories with validation', async () => {
    await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/characters/aria/memories',
      ...json({ category: 'user', content: 'Etienne loves climbing' }),
    });
    expect(created.statusCode).toBe(201);
    const list = (
      await app.inject({ method: 'GET', url: '/api/characters/aria/memories', headers: { host: HOST } })
    ).json();
    expect(list).toMatchObject([{ category: 'user', content: 'Etienne loves climbing' }]);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/characters/aria/memories',
      ...json({ category: 'admin', content: 'x' }),
    });
    expect(bad.statusCode).toBe(400);
    const ghost = await app.inject({ method: 'GET', url: '/api/characters/ghost/memories', headers: { host: HOST } });
    expect(ghost.statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: `/api/memories/${list[0].id}`, headers: { host: HOST } });
    expect(del.statusCode).toBe(204);
  });
});

describe('HTTP API - voice', () => {
  const audio = (bytes: number) => ({
    headers: { host: HOST, 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(bytes),
  });

  it('reports voice as disabled and refuses requests when not configured', async () => {
    await makeApp(false);
    const status = (await app.inject({ method: 'GET', url: '/api/voice', headers: { host: HOST } })).json();
    expect(status.stt.available).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/tts', ...json({ text: 'Bonjour' }) })).statusCode).toBe(503);
  });

  it('transcribes float32 audio and validates the payload', async () => {
    await makeApp(true);
    const ok = await app.inject({ method: 'POST', url: '/api/stt', ...audio(16000 * 4) });
    expect(ok.json()).toEqual({ text: 'heard 16000 samples' });
    expect((await app.inject({ method: 'POST', url: '/api/stt', ...audio(400) })).json()).toEqual({ text: '' });
    expect((await app.inject({ method: 'POST', url: '/api/stt', ...audio(7) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/stt', ...json({}) })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/stt', ...audio(5 * 1024 * 1024) })).statusCode).toBe(413);
  });

  it('synthesizes cleaned text as WAV, 204 when nothing is speakable', async () => {
    await makeApp(true);
    const res = await app.inject({ method: 'POST', url: '/api/tts', ...json({ text: '*sourit* Coucou 😊' }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
    expect(fakeVoice.tts.lastText).toBe('Coucou');
    expect((await app.inject({ method: 'POST', url: '/api/tts', ...json({ text: '*sourit*' }) })).statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'POST', url: '/api/tts', ...json({ text: 'a'.repeat(1001) }) })).statusCode,
    ).toBe(400);
  });

  it('allows blob: media in the CSP for audio playback', async () => {
    await makeApp(true);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(res.headers['content-security-policy']).toContain("media-src 'self' blob:");
  });
});

describe('HTTP API - photos', () => {
  async function makePhotoApp() {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ImageService } = await import('../src/images/imageService.js');
    const { ImageStore } = await import('../src/images/imageStore.js');
    const { ComfyClient } = await import('../src/images/comfyClient.js');
    const { GpuGate } = await import('../src/util/gpuGate.js');
    const { ScriptedLlm, FakeComfy } = await import('./helpers.js');

    const llm = new ScriptedLlm();
    const characters = CharacterRepository.fromCharacters([makeCharacter({ appearance: 'woman, 26 years old' })]);
    const { db, store } = makeStore();
    const comfy = new FakeComfy();
    const images = new ImageService(
      store,
      characters,
      new ImageStore(db),
      llm,
      new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
      new GpuGate(),
      { warn: () => {}, info: () => {} },
      {
        userName: 'Etienne',
        imagesDir: await mkdtemp(join(tmpdir(), 'girllm-http-img-')),
        settings: {
          checkpoint: 'sdxl.safetensors',
          width: 832,
          height: 1216,
          steps: 20,
          cfg: 5,
          sampler: 'dpmpp_2m',
          scheduler: 'karras',
          style: '',
          negative: '',
        },
      },
    );
    const chat = new ChatService(
      characters,
      store,
      llm,
      { userName: 'Etienne', budget: { contextTokens: 4096, maxReplyTokens: 200 }, temperature: 0.8, topP: 0.9 },
      undefined,
      images,
    );
    app = await buildApp({
      chat,
      characters,
      llm,
      memoryStore: new MemoryStore(db),
      images,
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    return app;
  }

  it('reports status, generates a photo and serves it', async () => {
    await makePhotoApp();
    expect(
      (await app.inject({ method: 'GET', url: '/api/images/status', headers: { host: HOST } })).json(),
    ).toMatchObject({
      available: true,
      checkpoint: 'sdxl.safetensors',
    });

    const { session } = (
      await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: 'aria' }) })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/photo`,
      ...json({ request: 'selfie at the beach' }),
    });
    expect(res.statusCode).toBe(200);
    const { message } = res.json();
    expect(message).toMatchObject({ role: 'assistant', content: '*sourit* Voilà !' });

    const img = await app.inject({ method: 'GET', url: `/api/images/${message.imageId}`, headers: { host: HOST } });
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    const reloaded = (
      await app.inject({ method: 'GET', url: `/api/sessions/${session.id}`, headers: { host: HOST } })
    ).json();
    expect(reloaded.session.messages.at(-1).imageId).toBe(message.imageId);
  });

  it('validates ids, refuses unsafe requests and reports disabled photos', async () => {
    await makePhotoApp();
    expect(
      (await app.inject({ method: 'GET', url: '/api/images/../../etc/passwd', headers: { host: HOST } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/images/not-a-uuid', headers: { host: HOST } })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/images/00000000-0000-4000-8000-000000000000',
          headers: { host: HOST },
        })
      ).statusCode,
    ).toBe(404);

    const { session } = (
      await app.inject({ method: 'POST', url: '/api/sessions', ...json({ characterId: 'aria' }) })
    ).json();
    const refused = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/photo`,
      ...json({ request: 'as a schoolgirl' }),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("This photo can't be generated.");
    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/photo`,
      ...json({ request: 'x'.repeat(301) }),
    });
    expect(tooLong.statusCode).toBe(400);
    await app.close();

    await makeApp();
    expect(
      (await app.inject({ method: 'GET', url: '/api/images/status', headers: { host: HOST } })).json().reason,
    ).toMatch(/^disabled/);
  });
});

describe('HTTP API - settings', () => {
  async function makeSettingsApp() {
    const { SettingsService } = await import('../src/settings/settingsService.js');
    const { defaultsFromConfig } = await import('../src/settings/settingsSchema.js');
    const { parseConfig } = await import('../src/config.js');
    const llm = new FakeLlm();
    const characters = CharacterRepository.fromCharacters([makeCharacter()]);
    const { db, store } = makeStore();
    const settings = new SettingsService(db, defaultsFromConfig(parseConfig({ USER_NAME: 'Etienne' })), 4096);
    const chat = new ChatService(characters, store, llm, {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.8,
      topP: 0.9,
    });
    app = await buildApp({
      chat,
      characters,
      llm,
      memoryStore: new MemoryStore(db),
      settings,
      allowedHosts: [HOST],
      userName: () => settings.get().userName,
    });
    return settings;
  }

  it('returns values, defaults and options (models from the backend, voices with install state)', async () => {
    await makeSettingsApp();
    const res = (await app.inject({ method: 'GET', url: '/api/settings', headers: { host: HOST } })).json();
    expect(res.values.userName).toBe('Etienne');
    expect(res.options.models).toEqual(['fake']);
    expect(res.options.voices.find((v: { id: string }) => v.id === 'fr-siwis')).toMatchObject({ installed: false }); // Recommended settings per known model (step 6), regex sent as a string.
    expect(res.options.presets).toContainEqual(
      expect.objectContaining({ name: 'Juggernaut XL', pattern: 'juggernaut' }),
    );
  });

  it('updates live (visible in /api/config), validates, and resets', async () => {
    await makeSettingsApp();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      ...json({ userName: 'Tim', temperature: 0.9 }),
    });
    expect(put.json().overridden.sort()).toEqual(['temperature', 'userName']);
    expect((await app.inject({ method: 'GET', url: '/api/config', headers: { host: HOST } })).json().userName).toBe(
      'Tim',
    );

    const bad = await app.inject({ method: 'PUT', url: '/api/settings', ...json({ temperature: 'hot' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/temperature/);

    const reset = await app.inject({ method: 'POST', url: '/api/settings/reset', ...json({ keys: ['userName'] }) });
    expect(reset.json().overridden).toEqual(['temperature']);
    expect(
      (await app.inject({ method: 'POST', url: '/api/settings/reset', ...json({ keys: ['nope'] }) })).statusCode,
    ).toBe(400);
  });
});
