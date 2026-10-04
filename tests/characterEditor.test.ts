/**
 * Character editor (step 4c): repository writes, reference faces, cascade
 * deletion, and the HTTP routes (consent, sanitizing, portrait candidates).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRejectedError, CharacterRepository } from '../src/characters/characterRepository.js';
import { CharacterService } from '../src/characters/characterService.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { CharacterInputSchema } from '../src/characters/schema.js';
import { ChatService, SessionBusyError } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { CONSENT_HEADER, CONSENT_VALUE } from '../src/http/routes/characterRoutes.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { ImageService } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { FakeComfy, FakeLlm, makeStore, ScriptedLlm } from './helpers.js';

const HOST = '127.0.0.1:3210';
const silent = { info: () => undefined, warn: () => undefined };

/**
 * Minimal structurally valid PNG (the sanitizer only reads chunks).
 * @param extra tEXt payloads (metadata that must be stripped)
 * @param idatBytes size of the pixel chunk (to test upload limits)
 */
function png(width = 256, height = 256, extra: Buffer[] = [], idatBytes = 6): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map((e) => chunk('tEXt', e)),
    chunk('IDAT', Buffer.alloc(idatBytes, 1)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const input = (overrides: Record<string, unknown> = {}) =>
  CharacterInputSchema.parse({
    name: 'Lena',
    description: '{{char}} is a 27-year-old nurse.',
    first_mes: 'Hey {{user}}',
    style: 'texting',
    appearance: 'woman, 27 years old, black hair',
    ...overrides,
  });

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function emptyRepo() {
  const dir = await tempDir('girllm-chars-');
  return { dir, repo: await CharacterRepository.loadFromDirectory(dir, silent) };
}

// ---------------------------------------------------------------------------

describe('CharacterRepository (writable)', () => {
  it('creates a V2 JSON card that loads back identically', async () => {
    const { dir, repo } = await emptyRepo();
    const c = await repo.save(input());
    expect(c).toMatchObject({
      id: 'lena',
      name: 'Lena',
      style: 'texting',
      appearance: 'woman, 27 years old, black hair',
    });

    const reloaded = await CharacterRepository.loadFromDirectory(dir, silent);
    expect(reloaded.get('lena')).toMatchObject({ name: 'Lena', style: 'texting', first_mes: 'Hey {{user}}' });
    const raw = JSON.parse(await readFile(join(dir, 'lena.json'), 'utf8'));
    expect(raw).toMatchObject({ spec: 'chara_card_v2', data: { extensions: { girllm: { style: 'texting' } } } });
  });

  it('keeps the id stable on rename and avoids id collisions', async () => {
    const { dir, repo } = await emptyRepo();
    await repo.save(input());
    const twin = await repo.save(input());
    expect(twin.id).toBe('lena-2');
    const renamed = await repo.save(input({ name: 'Helena' }), 'lena');
    expect(renamed.id).toBe('lena');
    expect(renamed.name).toBe('Helena');
    expect((await readdir(dir)).sort()).toEqual(['lena-2.json', 'lena.json']);
  });

  it('serializes concurrent creations (no duplicate ids)', async () => {
    const { repo } = await emptyRepo();
    const made = await Promise.all([repo.save(input()), repo.save(input()), repo.save(input())]);
    expect(new Set(made.map((c) => c.id)).size).toBe(3);
  });

  it('moves an edited card stored under another file name aside (no duplicate on reload)', async () => {
    const { dir } = await emptyRepo();
    await writeFile(
      join(dir, 'My Lena Card.json'),
      JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Lena', description: 'adult' } }),
    );
    const repo = await CharacterRepository.loadFromDirectory(dir, silent);
    const id = repo.list()[0]!.id;
    await repo.save(input(), id);
    expect(existsSync(join(dir, '.originals', 'My Lena Card.json'))).toBe(true);
    const reloaded = await CharacterRepository.loadFromDirectory(dir, silent);
    expect(reloaded.list()).toHaveLength(1);
  });

  it('refuses characters under 18', async () => {
    const { repo } = await emptyRepo();
    await expect(repo.save(input({ description: '{{char}} is 16 years old.' }))).rejects.toThrow(
      CharacterRejectedError,
    );
    await expect(repo.save(input({ appearance: 'teenage girl' }))).rejects.toThrow(CharacterRejectedError);
    expect(repo.list()).toHaveLength(0);
  });

  it('imports card fields and removes cards', async () => {
    const { dir, repo } = await emptyRepo();
    const c = await repo.import({
      ...input(),
      alternate_greetings: [],
      creator: '',
      character_version: '',
      extensions: { girllm: { style: 'roleplay' } },
    });
    expect(c.style).toBe('roleplay');
    expect(repo.exportCard(c.id)).toMatchObject({ spec: 'chara_card_v2', data: { name: 'Lena' } });
    expect(await repo.remove(c.id)).toBe(true);
    expect(await repo.remove(c.id)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('is read-only when built from memory (tests)', async () => {
    const repo = CharacterRepository.fromCharacters([]);
    await expect(repo.save(input())).rejects.toThrow(/read-only/);
  });
});

// ---------------------------------------------------------------------------

describe('FaceStore', () => {
  it('saves, replaces and removes a face; rejects bad ids', async () => {
    const faces = new FaceStore(await tempDir('girllm-faces-'));
    expect(faces.get('lena')).toBeUndefined();
    await faces.save('lena', { type: 'jpeg', bytes: Buffer.from('jpg'), width: 64, height: 64 });
    expect(faces.get('lena')?.type).toBe('jpeg');
    await faces.save('lena', { type: 'png', bytes: png(), width: 256, height: 256 });
    expect(faces.get('lena')?.type).toBe('png'); // the jpeg is gone
    await faces.remove('lena');
    expect(faces.get('lena')).toBeUndefined();
    expect(() => faces.get('../etc/passwd')).toThrow(/Invalid id/);
    expect(() => faces.candidatePath('../../x')).toThrow(/Invalid id/);
  });

  it('promotes candidates and cleans up old ones', async () => {
    const faces = new FaceStore(await tempDir('girllm-faces-'));
    const keep = await faces.addCandidate(png());
    const old = await faces.addCandidate(png());
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(faces.candidatePath(old)!, longAgo, longAgo);
    await faces.cleanupCandidates(3600_000);
    expect(faces.candidatePath(old)).toBeUndefined();

    expect(await faces.promote('lena', keep)).toBe(true);
    expect(faces.get('lena')?.type).toBe('png');
    expect(faces.candidatePath(keep)).toBeUndefined();
    expect(await faces.promote('lena', keep)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

async function setup(opts: { withImages?: boolean; slowLlm?: boolean } = {}) {
  const { dir, repo } = await emptyRepo();
  const facesDir = await tempDir('girllm-faces-');
  const faces = new FaceStore(facesDir);
  const { db, store } = makeStore();
  const memoryStore = new MemoryStore(db);
  const gate = new GpuGate();
  const comfy = new FakeComfy();
  const llm = opts.slowLlm ? new FakeLlm(['a', 'b', 'c'], 30) : new GatedLlmProvider(new ScriptedLlm(), gate);
  const images = opts.withImages
    ? new ImageService(
        store,
        repo,
        new ImageStore(db),
        llm,
        new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
        gate,
        silent,
        {
          userName: 'Etienne',
          imagesDir: await tempDir('girllm-img-'),
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
          },
        },
      )
    : undefined;
  const chat = new ChatService(
    repo,
    store,
    llm,
    { userName: 'Etienne', budget: { contextTokens: 4096, maxReplyTokens: 200 }, temperature: 0.7, topP: 0.9 },
    undefined,
    images,
  );
  const characterService = new CharacterService(repo, chat, store, memoryStore, faces);
  return { dir, repo, faces, store, memoryStore, chat, characterService, comfy, images, llm };
}

describe('CharacterService.remove', () => {
  it('deletes chats, memories, face and card together', async () => {
    const s = await setup();
    const c = await s.repo.save(input());
    s.chat.createSession(c.id);
    s.chat.createSession(c.id);
    s.memoryStore.add({ characterId: c.id, category: 'user', content: 'Etienne likes jazz' });
    await s.faces.save(c.id, { type: 'png', bytes: png(), width: 256, height: 256 });

    expect(await s.characterService.remove(c.id)).toEqual({ chats: 2, memories: 1 });
    expect(s.repo.get(c.id)).toBeUndefined();
    expect(s.store.listIdsByCharacter(c.id)).toEqual([]);
    expect(s.memoryStore.list(c.id)).toEqual([]);
    expect(s.faces.get(c.id)).toBeUndefined();
    expect(await s.characterService.remove(c.id)).toBe(false);
  });

  it('refuses while one of its chats is generating, and changes nothing', async () => {
    const s = await setup({ slowLlm: true });
    const c = await s.repo.save(input());
    const { session } = s.chat.createSession(c.id);
    const pending = s.chat.sendMessage(session.id, 'hello', () => undefined);
    await expect(s.characterService.remove(c.id)).rejects.toThrow(SessionBusyError);
    await pending;
    expect(s.repo.get(c.id)).toBeDefined();
    expect(s.store.listIdsByCharacter(c.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('Character editor HTTP API', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function makeApp(withImages = false) {
    const s = await setup({ withImages });
    app = await buildApp({
      chat: s.chat,
      characters: s.repo,
      llm: s.llm,
      memoryStore: s.memoryStore,
      images: s.images,
      characterService: s.characterService,
      faces: s.faces,
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    return s;
  }

  const send = (method: 'POST' | 'PUT', url: string, body: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const upload = (method: 'POST' | 'PUT', url: string, bytes: Buffer, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, 'content-type': 'application/octet-stream', ...headers },
      payload: bytes,
    });

  it('creates, reads, updates, lists, exports and deletes a character', async () => {
    await makeApp();
    const created = await send('POST', '/api/characters', input());
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'lena', style: 'texting', hasFace: false });

    const got = await app.inject({ method: 'GET', url: '/api/characters/lena', headers: { host: HOST } });
    expect(got.json().card).toMatchObject({ name: 'Lena', first_mes: 'Hey {{user}}' });

    const updated = await send('PUT', '/api/characters/lena', { ...got.json().card, name: 'Lena B.' });
    expect(updated.json()).toMatchObject({ id: 'lena', name: 'Lena B.' });

    const list = await app.inject({ method: 'GET', url: '/api/characters', headers: { host: HOST } });
    expect(list.json()).toEqual([expect.objectContaining({ id: 'lena', style: 'texting', hasFace: false })]);

    const exported = await app.inject({ method: 'GET', url: '/api/characters/lena/export', headers: { host: HOST } });
    expect(exported.headers['content-disposition']).toContain('lena.json');
    expect(exported.json()).toMatchObject({ spec: 'chara_card_v2', data: { name: 'Lena B.' } });

    const del = await app.inject({ method: 'DELETE', url: '/api/characters/lena', headers: { host: HOST } });
    expect(del.json()).toEqual({ deleted: true, chats: 0, memories: 0 });
    const gone = await app.inject({ method: 'GET', url: '/api/characters/lena', headers: { host: HOST } });
    expect(gone.statusCode).toBe(404);
  });

  it('validates input and refuses minors (422)', async () => {
    await makeApp();
    expect((await send('POST', '/api/characters', { name: '' })).statusCode).toBe(400);
    expect((await send('POST', '/api/characters', { ...input(), style: 'poem' })).statusCode).toBe(400);
    const minor = await send('POST', '/api/characters', input({ description: '{{char}} is 15 years old.' }));
    expect(minor.statusCode).toBe(422);
    expect(minor.json().error).toMatch(/adults/);
    expect((await send('PUT', '/api/characters/nobody', input())).statusCode).toBe(404);
  });

  it('imports JSON cards and rejects garbage', async () => {
    await makeApp();
    const card = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Mia', description: 'adult' } }));
    const res = await upload('POST', '/api/characters/import', card);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'mia', name: 'Mia' });
    expect((await upload('POST', '/api/characters/import', Buffer.from('{nope'))).statusCode).toBe(400);
    expect((await upload('POST', '/api/characters/import', png())).statusCode).toBe(400); // PNG without card
  });

  it('requires consent for face uploads and strips metadata', async () => {
    const s = await makeApp();
    await send('POST', '/api/characters', input());
    const face = png(256, 256, [Buffer.from('Author\0Somebody')]);

    expect((await upload('PUT', '/api/characters/lena/face', face)).statusCode).toBe(428);
    const ok = await upload('PUT', '/api/characters/lena/face', face, { [CONSENT_HEADER]: CONSENT_VALUE });
    expect(ok.statusCode).toBe(204);
    const stored = await readFile(s.faces.get('lena')!.path);
    expect(stored.toString('latin1')).not.toContain('Somebody');

    const served = await app.inject({ method: 'GET', url: '/api/characters/lena/face', headers: { host: HOST } });
    expect(served.headers['content-type']).toBe('image/png');
    const list = await app.inject({ method: 'GET', url: '/api/characters', headers: { host: HOST } });
    expect(list.json()[0].hasFace).toBe(true);

    const bad = await upload('PUT', '/api/characters/lena/face', Buffer.from('not an image'), {
      [CONSENT_HEADER]: CONSENT_VALUE,
    });
    expect(bad.statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url: '/api/characters/lena/face', headers: { host: HOST } });
    expect(del.statusCode).toBe(204);
    expect(s.faces.get('lena')).toBeUndefined();
  });

  it('accepts face uploads above the 4 MB audio limit but below 10 MB', async () => {
    await makeApp();
    await send('POST', '/api/characters', input());
    const huge = png(256, 256, [], 5 * 1024 * 1024);
    const res = await upload('PUT', '/api/characters/lena/face', huge, { [CONSENT_HEADER]: CONSENT_VALUE });
    expect(res.statusCode).toBe(204);
  });

  it('generates portrait candidates and promotes the chosen one', async () => {
    const s = await makeApp(true);
    await send('POST', '/api/characters', input());
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters/lena/face/candidates',
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(200);
    const { candidates } = res.json<{ candidates: string[] }>();
    expect(candidates).toHaveLength(4);
    expect(s.comfy.queued).toHaveLength(4);
    expect(s.comfy.freed).toBe(1);
    // Portraits are square, with the adult safety terms and the appearance.
    const prompt = JSON.stringify(s.comfy.queued[0]!.prompt);
    expect(prompt).toContain('black hair');
    expect(prompt).toMatch(/adult/);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/characters/lena/face/candidates/${candidates[0]}`,
      headers: { host: HOST },
    });
    expect(preview.headers['content-type']).toBe('image/png');

    const pick = await app.inject({
      method: 'POST',
      url: `/api/characters/lena/face/candidates/${candidates[1]}`,
      headers: { host: HOST },
    });
    expect(pick.statusCode).toBe(204);
    expect(s.faces.get('lena')?.type).toBe('png');
  });

  it('refuses portrait generation when photos are disabled', async () => {
    await makeApp(false);
    await send('POST', '/api/characters', input());
    const res = await app.inject({
      method: 'POST',
      url: '/api/characters/lena/face/candidates',
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(503);
  });
});
