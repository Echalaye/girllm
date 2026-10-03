import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { readAppearance } from '../src/characters/schema.js';
import { ChatService } from '../src/chat/chatService.js';
import { ComfyClient, ComfyError } from '../src/images/comfyClient.js';
import { ImageService } from '../src/images/imageService.js';
import { ImageStore } from '../src/images/imageStore.js';
import { parsePhotoIdea } from '../src/images/photoPrompt.js';
import { assertSafe, cardStatesMinorAge, ImageRefusedError, mentionsMinor } from '../src/images/safety.js';
import { buildTxt2ImgWorkflow } from '../src/images/workflow.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { GatedLlmProvider } from '../src/llm/gated.js';
import { FakeComfy, makeCharacter, makeStore, ScriptedLlm } from './helpers.js';

const silentLog = { warn: () => {}, info: () => {} };

describe('safety', () => {
  it('detects minors in English and French, and under-18 ages', () => {
    for (const t of [
      'a teen at school',
      'little girl',
      'loli style',
      'une adolescente',
      'en uniforme scolaire',
      'elle a 16 ans',
      '15-year-old',
      'aged 12',
      'lycéenne',
    ]) {
      expect(mentionsMinor(t), t).toBe(true);
    }
  });

  it('accepts adult descriptions', () => {
    for (const t of [
      'woman, 26 years old, auburn hair',
      'elle a 26 ans',
      'mirror selfie, cozy sweater',
      'jeune femme de 30 ans',
    ]) {
      expect(mentionsMinor(t), t).toBe(false);
    }
  });

  it('only rejects explicit minor ages in cards (free text about children is fine)', () => {
    expect(cardStatesMinorAge("She illustrates children's books")).toBe(false);
    expect(cardStatesMinorAge('She is 17 years old')).toBe(true);
    expect(() => {
      assertSafe('ok', 'teenager');
    }).toThrow(ImageRefusedError);
  });
});

describe('workflow', () => {
  it('builds a linked SDXL txt2img graph', () => {
    const wf = buildTxt2ImgWorkflow({
      checkpoint: 'x.safetensors',
      positive: 'p',
      negative: 'n',
      width: 832,
      height: 1216,
      steps: 25,
      cfg: 5.5,
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      seed: 42,
    });
    expect(wf['1']).toEqual({ class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } });
    expect(wf['5']!.inputs).toMatchObject({
      seed: 42,
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['2', 0],
    });
    // Every link points to an existing node.
    for (const node of Object.values(wf)) {
      for (const v of Object.values(node.inputs)) if (Array.isArray(v)) expect(wf).toHaveProperty(String(v[0]));
    }
  });
});

describe('parsePhotoIdea / readAppearance', () => {
  it('parses tolerant JSON and rejects garbage', () => {
    expect(parsePhotoIdea('Sure! ```{"caption": "Tadaa", "scene": "selfie,\\n beach"}```')).toEqual({
      caption: 'Tadaa',
      scene: 'selfie, beach',
    });
    expect(parsePhotoIdea('no json')).toBeUndefined();
    expect(parsePhotoIdea('{"caption": ""}')).toBeUndefined();
  });

  it('reads extensions.girllm.appearance defensively', () => {
    expect(readAppearance({ girllm: { appearance: '  red hair ' } })).toBe('red hair');
    expect(readAppearance({ girllm: 'oops' })).toBe('');
    expect(readAppearance({})).toBe('');
  });
});

describe('GpuGate', () => {
  it('exclusive jobs wait for running shared users and block new ones', async () => {
    const gate = new GpuGate();
    const log: string[] = [];
    const leave = await gate.enterShared();
    const exclusive = gate.runExclusive(async () => {
      log.push('exclusive');
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual([]); // still waiting for the shared user
    const lateShared = gate.enterShared().then((l) => {
      log.push('late shared');
      l();
    });
    leave();
    await Promise.all([exclusive, lateShared]);
    expect(log).toEqual(['exclusive', 'late shared']);
  });

  it('propagates errors and keeps working', async () => {
    const gate = new GpuGate();
    await expect(gate.runExclusive(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await gate.runExclusive(async () => 1)).toBe(1);
    (await gate.enterShared())();
  });
});

describe('ComfyClient', () => {
  it('queues, polls, downloads and frees', async () => {
    const comfy = new FakeComfy();
    comfy.pollsBeforeDone = 2;
    const client = new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch });
    const png = await client.generate({ '1': { class_type: 'X', inputs: {} } });
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(comfy.queued[0]!.prompt['1']!.class_type).toBe('X');
    await client.free();
    expect(comfy.freed).toBe(1);
    expect(await client.status()).toEqual({ ok: true, checkpoints: ['sdxl.safetensors'] });
  });

  it('reports validation and execution errors, and rejects non-PNG data', async () => {
    for (const [failWith, pattern] of [
      ['node_error', /Value not in list: ckpt_name: nope/],
      ['execution', /reported an error/],
      ['not_png', /not a PNG/],
    ] as const) {
      const comfy = new FakeComfy();
      comfy.failWith = failWith;
      const client = new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch });
      await expect(client.generate({})).rejects.toThrow(pattern);
    }
  });

  it('cancels the job when aborted', async () => {
    const comfy = new FakeComfy();
    comfy.pollsBeforeDone = 1000;
    const client = new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 5, fetchImpl: comfy.fetch });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(client.generate({}, controller.signal)).rejects.toThrow();
    expect(comfy.cancelled).toEqual(['/queue', '/interrupt']);
  });

  it('times out with a clear error', async () => {
    const comfy = new FakeComfy();
    comfy.pollsBeforeDone = 1000;
    const client = new ComfyClient({
      baseUrl: 'http://comfy',
      pollIntervalMs: 5,
      timeoutMs: 30,
      fetchImpl: comfy.fetch,
    });
    await expect(client.generate({})).rejects.toThrow(ComfyError);
  });
});

async function setupImages(
  overrides: { character?: Parameters<typeof makeCharacter>[0]; checkpoint?: string | undefined } = {},
) {
  const { db, store } = makeStore();
  const characters = CharacterRepository.fromCharacters([
    makeCharacter({ appearance: 'woman, 26 years old, auburn hair', ...overrides.character }),
  ]);
  const raw = new ScriptedLlm({ chat: 'Bonsoir' });
  const gate = new GpuGate();
  const llm = new GatedLlmProvider(raw, gate);
  const comfy = new FakeComfy();
  const dir = await mkdtemp(join(tmpdir(), 'girllm-img-'));
  const images = new ImageService(
    store,
    characters,
    new ImageStore(db),
    llm,
    new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate,
    silentLog,
    {
      userName: 'Etienne',
      replyLanguage: 'French',
      imagesDir: dir,
      settings: {
        checkpoint: 'checkpoint' in overrides ? overrides.checkpoint : 'sdxl.safetensors',
        width: 832,
        height: 1216,
        steps: 20,
        cfg: 5,
        sampler: 'dpmpp_2m',
        scheduler: 'karras',
        style: 'photograph',
        negative: 'blurry',
      },
    },
  );
  const chat = new ChatService(
    characters,
    store,
    llm,
    { userName: 'Etienne', budget: { contextTokens: 4096, maxReplyTokens: 200 }, temperature: 0.7, topP: 0.9 },
    undefined,
    images,
  );
  return { store, raw, comfy, images, chat, dir };
}

describe('ImageService + ChatService.sendPhoto', () => {
  it('generates a photo: unloads the LLM, frees ComfyUI, stores file + message', async () => {
    const { raw, comfy, images, chat, store } = await setupImages();
    const { session } = chat.createSession('aria');
    const message = await chat.sendPhoto(session.id, 'a selfie with your cat');

    expect(message).toMatchObject({ role: 'assistant', content: '*sourit* Voilà !' });
    expect(message.imageId).toBeTruthy();
    const image = images.get(message.imageId!)!;
    expect(existsSync(images.filePath(image))).toBe(true);
    expect(raw.unloads).toBe(1);
    expect(comfy.freed).toBe(1);

    const positive = comfy.queued[0]!.prompt['3']!.inputs.text as string;
    expect(positive).toMatch(/^adult, mature adult, photograph, woman, 26 years old, auburn hair, selfie/);
    expect(comfy.queued[0]!.prompt['4']!.inputs.text).toMatch(/^blurry, child, .*underage/);
    const saved = store.get(session.id)!.messages;
    expect(saved.at(-1)!.imageId).toBe(image.id);
    expect(saved.at(-2)).toMatchObject({ role: 'user', content: '📷 a selfie with your cat' });
  });

  it('tells the LLM what the photo showed on the next turn', async () => {
    const { raw, chat } = await setupImages();
    const { session } = chat.createSession('aria');
    await chat.sendPhoto(session.id, '');
    await chat.sendMessage(session.id, 'Trop belle !', () => {});
    const lastChat = raw.callsOfKind('chat').at(-1)!;
    expect(lastChat.some((m) => m.content.includes('*Aria sent a photo: selfie, smiling, cozy living room'))).toBe(
      true,
    );
  });

  it('refuses requests or cards involving minors, before calling ComfyUI', async () => {
    const a = await setupImages();
    const s1 = a.chat.createSession('aria').session;
    await expect(a.chat.sendPhoto(s1.id, 'en uniforme scolaire')).rejects.toBeInstanceOf(ImageRefusedError);
    expect(a.comfy.queued).toHaveLength(0);
    expect(a.store.get(s1.id)!.messages).toHaveLength(1); // only the greeting: nothing saved

    const b = await setupImages({ character: { description: '{{char}} is 16 years old.' } });
    const s2 = b.chat.createSession('aria').session;
    await expect(b.chat.sendPhoto(s2.id, '')).rejects.toBeInstanceOf(ImageRefusedError);

    const c = await setupImages();
    const raw = new ScriptedLlm({ photo: '{"caption": "x", "scene": "teenager, school"}' });
    const s3 = c.chat.createSession('aria').session;
    const svc = new ImageService(
      c.store,
      CharacterRepository.fromCharacters([makeCharacter()]),
      new ImageStore(makeStore().db),
      raw,
      new ComfyClient({ baseUrl: 'http://comfy', fetchImpl: c.comfy.fetch }),
      new GpuGate(),
      silentLog,
      {
        userName: 'U',
        imagesDir: c.dir,
        settings: {
          checkpoint: 'sdxl.safetensors',
          width: 832,
          height: 1216,
          steps: 20,
          cfg: 5,
          sampler: 'a',
          scheduler: 'b',
          style: '',
          negative: '',
        },
      },
    );
    await expect(svc.createPhoto(s3.id, '')).rejects.toBeInstanceOf(ImageRefusedError);
    expect(c.comfy.queued).toHaveLength(0);
  });

  it('frees ComfyUI even when generation fails, and reports status', async () => {
    const { comfy, chat, images } = await setupImages();
    comfy.failWith = 'execution';
    const { session } = chat.createSession('aria');
    await expect(chat.sendPhoto(session.id, '')).rejects.toThrow(ComfyError);
    expect(comfy.freed).toBe(1);
    expect(await images.status()).toEqual({ available: true, checkpoint: 'sdxl.safetensors' });
    comfy.checkpoints = ['other.safetensors'];
    expect((await images.status()).reason).toMatch(/not found in ComfyUI/);
    const none = await setupImages({ checkpoint: undefined });
    expect((await none.images.status()).reason).toMatch(/IMAGE_CHECKPOINT/);
  });

  it('deletes image files together with the chat', async () => {
    const { chat, images } = await setupImages();
    const { session } = chat.createSession('aria');
    const message = await chat.sendPhoto(session.id, '');
    const path = images.filePath(images.get(message.imageId!)!);
    chat.deleteSession(session.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(path)).toBe(false);
  });
});

describe('safety age patterns', () => {
  it.each(['15 year old', '15-years-old', '9yo', '17 y/o', 'âgée de 15', '12 ans'])('flags %s', (t) => {
    expect(mentionsMinor(t)).toBe(true);
  });
  it.each(['18 years old', '25-year-old', '30 ans', 'aged 40', '2026 photo', '10 years of experience'])(
    'accepts %s',
    (t) => {
      expect(mentionsMinor(t)).toBe(false);
    },
  );
});

describe('safety with accented words', () => {
  it.each(['un bébé', 'une écolière', 'Bébé.', 'âgée de 15 ans'])('flags %s', (t) => {
    expect(mentionsMinor(t)).toBe(true);
  });
  it.each(['adolescence lointaine', 'adorable', 'kidding', 'minority report'])('accepts %s', (t) => {
    expect(mentionsMinor(t)).toBe(false);
  });
});
