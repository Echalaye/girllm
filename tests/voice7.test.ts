/**
 * Step 7: her voice with Qwen3-TTS in ComfyUI — pinned install, workflows,
 * the "adult voice" rule, the voice store, ComfyUI audio, the speech
 * service (GPU swap, automatic voice, cache) and the HTTP routes.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { CharacterService } from '../src/characters/characterService.js';
import { CharacterInputSchema, type Character } from '../src/characters/schema.js';
import { ChatService } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import {
  buildVoiceCloneWorkflow,
  buildVoiceDesignWorkflow,
  qwenLanguage,
  QWEN_TTS_BASE_FILES,
  QWEN_TTS_DESIGN_FILES,
  QWEN_TTS_NODES,
  QWEN_TTS_PYTHON_PACKAGES,
  voiceSampleText,
} from '../src/voice/qwenTts.js';
import {
  DEFAULT_VOICE_DESCRIPTION,
  MAX_CACHED_CLIPS,
  MAX_SPEECH_CHARS,
  prepareSpeech,
  SpeechService,
} from '../src/voice/speechService.js';
import { VoiceUnavailableError } from '../src/voice/types.js';
import { adultVoicePrefix, assertVoiceSafe, mentionsChildVoice, VoiceRefusedError } from '../src/voice/voiceSafety.js';
import { VoiceStore } from '../src/voice/voiceStore.js';
import { pipInstall, pythonHas, versionAtLeast } from '../scripts/comfySetupLib.js';
import { download, MAX_UNHASHED_BYTES } from '../scripts/downloadLib.js';
import { FakeComfy, fakeFlac, makeCharacter, makeStore, ScriptedLlm } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const HOST = '127.0.0.1:3210';
const classes = (wf: Record<string, { class_type: string }>) => Object.values(wf).map((n) => n.class_type);
const tempDir = (name: string) => mkdtemp(join(tmpdir(), `girllm-${name}-`));
const info = (text = 'Salut, c’est moi !') => ({
  text,
  description: 'warm voice',
  language: 'French',
  createdAt: '2026-10-06T10:00:00.000Z',
});

describe('Qwen3-TTS install (pinned)', () => {
  it('pins the node pack to a full commit', () => {
    expect(QWEN_TTS_NODES.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(QWEN_TTS_NODES.repo).toBe('https://github.com/flybirdxx/ComfyUI-Qwen-TTS.git');
  });

  it('pins every model file to a Hugging Face commit, and the weights to a SHA-256', () => {
    for (const files of [QWEN_TTS_BASE_FILES, QWEN_TTS_DESIGN_FILES]) {
      for (const f of files) {
        expect(f.url).toMatch(
          /^https:\/\/huggingface\.co\/Qwen\/Qwen3-TTS-12Hz-1\.7B-[A-Za-z]+\/resolve\/[0-9a-f]{40}\//,
        );
        expect(f.folder.startsWith('qwen-tts/Qwen3-TTS-12Hz-1.7B-')).toBe(true);
        expect(f.url.endsWith(`/${f.file}`)).toBe(true);
        expect(f.url.includes('/speech_tokenizer/')).toBe(f.folder.endsWith('/speech_tokenizer'));
        if (f.file.endsWith('.safetensors')) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        else expect(f.sha256).toBeNull();
      }
      expect(files.filter((f) => f.sha256)).toHaveLength(2); // model + speech tokenizer
    }
    // The nodes find a model by its folder name: "1.7B" + the model type.
    expect(QWEN_TTS_BASE_FILES[0]!.folder).toMatch(/1\.7B-Base$/);
    expect(QWEN_TTS_DESIGN_FILES[0]!.folder).toMatch(/1\.7B-VoiceDesign$/);
  });

  it('installs exact Python versions only, never the Intel-only onnxruntime-openvino', () => {
    for (const p of QWEN_TTS_PYTHON_PACKAGES) expect(p.spec).toMatch(/^[a-z_-]+==[0-9.]+$/);
    expect(QWEN_TTS_PYTHON_PACKAGES.map((p) => p.spec).join(' ')).not.toContain('openvino');
  });

  it('refuses unpinned pip specs and odd module names before running anything', () => {
    expect(() => {
      pipInstall('python', ['librosa']);
    }).toThrow(/unpinned/);
    expect(() => {
      pipInstall('python', ['librosa>=0.10']);
    }).toThrow(/unpinned/);
    expect(() => pythonHas('python', 'os; import shutil')).toThrow(/Invalid module/);
  });

  it('compares versions numerically', () => {
    expect(versionAtLeast('4.57.3', '4.57.0')).toBe(true);
    expect(versionAtLeast('4.9.0', '4.57.0')).toBe(false);
    expect(versionAtLeast('5.0', '4.57.0')).toBe(true);
    expect(versionAtLeast('4.57.0.dev0', '4.57.0')).toBe(true);
  });

  it('refuses an unhashed download bigger than a config file', async () => {
    const dir = await tempDir('dl');
    const big = new Uint8Array(MAX_UNHASHED_BYTES + 1);
    vi.stubGlobal('fetch', async () => new Response(big));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(download('https://example.test/config.json', join(dir, 'x'), null)).rejects.toThrow(/refused/);
      expect(existsSync(join(dir, 'x'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      write.mockRestore();
    }
  });
});

describe('Qwen3-TTS workflows', () => {
  it('maps the reply language to a model language', () => {
    expect(qwenLanguage('French')).toBe('French');
    expect(qwenLanguage('français')).toBe('French');
    expect(qwenLanguage('fr')).toBe('French');
    expect(qwenLanguage('English')).toBe('English');
    expect(qwenLanguage('espagnol')).toBe('Spanish');
    expect(qwenLanguage('')).toBe('Auto');
    expect(qwenLanguage(undefined)).toBe('Auto');
    expect(qwenLanguage('Klingon')).toBe('Auto');
    expect(voiceSampleText('French')).toMatch(/^Salut/);
    expect(voiceSampleText('Auto')).toMatch(/^Hi/);
  });

  it('designs a voice and saves it as audio, unloading the model afterwards', () => {
    const wf = buildVoiceDesignWorkflow({
      description: 'An adult woman’s voice. warm',
      text: 'Salut',
      language: 'French',
      seed: 7,
    });
    expect(classes(wf)).toEqual(['FB_Qwen3TTSVoiceDesign', 'SaveAudio']);
    expect(wf['1']!.inputs).toMatchObject({
      instruct: 'An adult woman’s voice. warm',
      text: 'Salut',
      language: 'French',
      model_choice: '1.7B',
      unload_model_after_generate: true,
      seed: 7,
    });
    expect(wf['2']!.inputs.audio).toEqual(['1', 0]);
  });

  it('clones her reference clip (with its transcript), core LoadAudio only, no LoadSpeaker', () => {
    const wf = buildVoiceCloneWorkflow({
      referenceAudio: 'girllm_voice_aria_x.flac',
      referenceText: 'Salut',
      text: 'Bonsoir',
      language: 'French',
      seed: 1,
    });
    expect(classes(wf)).toEqual(['LoadAudio', 'FB_Qwen3TTSVoiceClone', 'SaveAudio']);
    expect(wf['2']!.inputs).toMatchObject({
      target_text: 'Bonsoir',
      ref_audio: ['1', 0],
      ref_text: 'Salut',
      x_vector_only: false,
      unload_model_after_generate: true,
    });
    expect(JSON.stringify(wf)).not.toContain('LoadSpeaker');
  });
});

describe('adult voices only', () => {
  it('refuses descriptions of a child’s voice, in English and French', () => {
    for (const text of [
      'a little girl voice',
      'teenage girl, 16',
      'childlike and squeaky',
      'baby voice, cute',
      "voix d'enfant",
      'voix de petite fille',
      'une gamine de 12 ans',
    ]) {
      expect(mentionsChildVoice(text)).toBe(true);
      expect(() => {
        assertVoiceSafe(text);
      }).toThrow(VoiceRefusedError);
    }
  });

  it('accepts ordinary adult descriptions, and always says "adult"', () => {
    for (const text of [
      'Woman in her late twenties, warm and slightly husky, calm',
      'Femme de 30 ans, voix douce et posée',
      'Young woman, bright and playful',
    ]) {
      expect(mentionsChildVoice(text)).toBe(false);
    }
    expect(adultVoicePrefix('female')).toMatch(/adult woman/);
    expect(adultVoicePrefix('male')).toMatch(/adult man/);
  });
});

describe('VoiceStore', () => {
  it('stores her clip with its transcript, and hashes it', async () => {
    const store = new VoiceStore(await tempDir('voices'));
    expect(await store.get('aria')).toBeUndefined();
    await store.save('aria', fakeFlac(1), info());
    const v = await store.get('aria');
    expect(v?.info.text).toBe('Salut, c’est moi !');
    expect(v?.hash).toMatch(/^[0-9a-f]{64}$/);
    await store.save('aria', fakeFlac(2), info());
    expect((await store.get('aria'))?.hash).not.toBe(v?.hash);
    await store.remove('aria');
    expect(await store.get('aria')).toBeUndefined();
  });

  it('treats a clip without its description as no voice', async () => {
    const dir = await tempDir('voices');
    await writeFile(join(dir, 'aria.flac'), fakeFlac());
    expect(await new VoiceStore(dir).get('aria')).toBeUndefined();
    await writeFile(join(dir, 'aria.json'), '{"text": 42}');
    expect(await new VoiceStore(dir).get('aria')).toBeUndefined();
  });

  it('keeps candidates until one is promoted or they expire', async () => {
    const dir = await tempDir('voices');
    const store = new VoiceStore(dir);
    const a = await store.addCandidate(fakeFlac(1), info('A'));
    const b = await store.addCandidate(fakeFlac(2), info('B'));
    expect(store.candidatePath(a)).toBeDefined();
    expect(await store.promote('aria', b)).toBe(true);
    expect((await store.get('aria'))?.info.text).toBe('B');
    expect(store.candidatePath(b)).toBeUndefined();
    expect(await store.promote('aria', b)).toBe(false);
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const name of await readdir(join(dir, 'candidates'))) await utimes(join(dir, 'candidates', name), old, old);
    await store.cleanupCandidates(3600_000);
    expect(store.candidatePath(a)).toBeUndefined();
  });

  it('refuses ids that could escape its folder', async () => {
    const store = new VoiceStore(await tempDir('voices'));
    await expect(store.get('../x')).rejects.toThrow(/Invalid id/);
    expect(() => store.candidatePath('../../etc/passwd')).toThrow(/Invalid id/);
  });
});

describe('ComfyClient audio', () => {
  const client = (comfy: FakeComfy) =>
    new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch });
  const wf = buildVoiceDesignWorkflow({ description: 'x', text: 'y', language: 'Auto', seed: 1 });

  it('downloads the FLAC of a SaveAudio output', async () => {
    const comfy = new FakeComfy();
    const flac = await client(comfy).generateAudio(wf);
    expect(flac.subarray(0, 4).toString('ascii')).toBe('fLaC');
  });

  it('refuses something that is not FLAC', async () => {
    const comfy = new FakeComfy();
    comfy.failWith = 'not_png';
    await expect(client(comfy).generateAudio(wf)).rejects.toThrow(/not a FLAC audio file/);
  });

  it('uploads a voice clip as audio', async () => {
    const comfy = new FakeComfy();
    expect(await client(comfy).uploadFile(fakeFlac(), 'v.flac', 'audio/flac')).toBe('v.flac');
    expect(comfy.uploads).toEqual([{ name: 'v.flac', size: fakeFlac().length, type: 'audio/flac' }]);
  });

  it('says what to install when the Qwen3-TTS nodes are missing', async () => {
    const comfy = new FakeComfy();
    expect(await client(comfy).qwenTtsSupport()).toMatchObject({ ready: false, reason: /setup:voice/ });
    comfy.qwen = true;
    expect(await client(comfy).qwenTtsSupport()).toEqual({ ready: true });
  });
});

describe('prepareSpeech', () => {
  it('cleans the text and cuts a long reply at a sentence end', () => {
    expect(prepareSpeech('*sourit* Coucou 😊')).toBe('Coucou');
    expect(prepareSpeech('*sourit*')).toBe('');
    const long = `${'Une phrase assez longue pour remplir. '.repeat(60)}Fin`;
    const said = prepareSpeech(long);
    expect(said.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(said.endsWith('.')).toBe(true);
  });
});

async function speechSetup(o: { character?: Partial<Character>; qwen?: boolean; language?: string } = {}) {
  const comfy = new FakeComfy();
  comfy.qwen = o.qwen ?? true;
  const llm = new ScriptedLlm();
  const gate = new GpuGate();
  const voices = new VoiceStore(await tempDir('voices'));
  const cacheDir = await tempDir('speech');
  const characters = CharacterRepository.fromCharacters([makeCharacter(o.character)]);
  const speech = new SpeechService({
    comfy: new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate,
    llm,
    characters,
    voices,
    cacheDir,
    log: silent,
    options: { replyLanguage: o.language ?? 'French' },
  });
  return { comfy, llm, gate, voices, cacheDir, speech, characters };
}

describe('SpeechService', () => {
  it('first time: designs her voice (default, adult) and keeps it, then speaks with it', async () => {
    const { comfy, llm, voices, speech } = await speechSetup();
    const flac = await speech.speak('aria', '*sourit* Coucou toi !');
    expect(flac?.subarray(0, 4).toString('ascii')).toBe('fLaC');
    const [design, clone] = comfy.queued.map((q) => q.prompt);
    expect(design!['1']!.class_type).toBe('FB_Qwen3TTSVoiceDesign');
    expect(design!['1']!.inputs.instruct).toBe(`An adult woman's voice. ${DEFAULT_VOICE_DESCRIPTION.female}`);
    expect(design!['1']!.inputs.text).toBe(voiceSampleText('French'));
    expect(clone!['2']!.inputs).toMatchObject({
      target_text: 'Coucou toi !',
      ref_text: voiceSampleText('French'),
      language: 'French',
    });
    expect(String(clone!['1']!.inputs.audio)).toMatch(/^girllm_voice_aria_[0-9a-f]{16}\.flac$/);
    expect(comfy.uploads[0]?.type).toBe('audio/flac');
    expect(await voices.get('aria')).toBeDefined();
    // Each GPU job: the chat model is unloaded first, ComfyUI freed after.
    expect(llm.unloads).toBe(2);
    expect(comfy.freed).toBe(2);
  });

  it('uses the voice description of her card', async () => {
    const { comfy, speech } = await speechSetup({
      character: { voiceDescription: 'Husky, slow, low pitch', gender: 'male' },
    });
    await speech.speak('aria', 'Salut');
    expect(comfy.queued[0]!.prompt['1']!.inputs.instruct).toBe("An adult man's voice. Husky, slow, low pitch");
  });

  it('replays a message from the cache, and says something new with the same voice', async () => {
    const { comfy, llm, speech, cacheDir } = await speechSetup();
    const first = await speech.speak('aria', 'Coucou');
    const again = await speech.speak('aria', '  Coucou  ');
    expect(again?.equals(first!)).toBe(true);
    expect(comfy.queued).toHaveLength(2); // design + one clone
    expect(llm.unloads).toBe(2);
    await speech.speak('aria', 'Autre chose');
    expect(comfy.queued.map((q) => classes(q.prompt)[1] ?? classes(q.prompt)[0])).toEqual([
      'SaveAudio',
      'FB_Qwen3TTSVoiceClone',
      'FB_Qwen3TTSVoiceClone',
    ]);
    expect((await readdir(cacheDir)).filter((n) => n.endsWith('.flac'))).toHaveLength(2);
  });

  it('shares one generation between identical requests running together', async () => {
    const { comfy, speech, voices } = await speechSetup();
    await voices.save('aria', fakeFlac(9), info());
    const [a, b] = await Promise.all([speech.speak('aria', 'Coucou'), speech.speak('aria', 'Coucou')]);
    expect(a?.equals(b!)).toBe(true);
    expect(comfy.queued).toHaveLength(1);
  });

  it('returns nothing to say for an *action* only, without touching the GPU', async () => {
    const { comfy, speech } = await speechSetup();
    expect(await speech.speak('aria', '*la regarde*')).toBeUndefined();
    expect(comfy.queued).toHaveLength(0);
  });

  it('fails fast when ComfyUI cannot speak, without unloading the chat model', async () => {
    const { llm, speech } = await speechSetup({ qwen: false });
    await expect(speech.speak('aria', 'Coucou')).rejects.toBeInstanceOf(VoiceUnavailableError);
    expect(llm.unloads).toBe(0);
    expect(await speech.status()).toMatchObject({ available: false, reason: /setup:voice/ });
  });

  it('refuses a voice for a card stating an under-18 age, and child-voice descriptions', async () => {
    const minor = await speechSetup({ character: { description: '{{char}} is 16 years old.' } });
    await expect(minor.speech.speak('aria', 'Coucou')).rejects.toBeInstanceOf(VoiceRefusedError);
    const adult = await speechSetup();
    await expect(adult.speech.designCandidate('aria', 'a little girl voice')).rejects.toBeInstanceOf(VoiceRefusedError);
    expect(adult.comfy.queued).toHaveLength(0);
  });

  it('designs candidates for the editor in the chat language', async () => {
    const { comfy, speech, voices } = await speechSetup({ language: 'English' });
    const id = await speech.designCandidate('aria', 'warm and calm');
    expect(voices.candidatePath(id)).toBeDefined();
    expect(comfy.queued[0]!.prompt['1']!.inputs).toMatchObject({
      language: 'English',
      text: voiceSampleText('English'),
    });
    expect(await voices.get('aria')).toBeUndefined(); // only kept when the user picks it
  });

  it('keeps at most MAX_CACHED_CLIPS spoken messages', async () => {
    const { speech, voices, cacheDir } = await speechSetup();
    await voices.save('aria', fakeFlac(), info());
    const old = new Date(Date.now() - 3600_000);
    for (let i = 0; i < MAX_CACHED_CLIPS; i++) {
      const path = join(cacheDir, `${i.toString(16).padStart(64, '0')}.flac`);
      await writeFile(path, fakeFlac(i));
      await utimes(path, old, old);
    }
    await speech.speak('aria', 'Nouveau');
    const left = (await readdir(cacheDir)).filter((n) => n.endsWith('.flac'));
    expect(left).toHaveLength(MAX_CACHED_CLIPS);
    expect(left).not.toContain(`${'0'.repeat(64)}.flac`); // the oldest went first
  });
});

describe('HTTP: her voice in the editor', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function makeApp() {
    const { db, store } = makeStore();
    // A real (folder) repository: deleting a character removes its card file.
    const characters = await CharacterRepository.loadFromDirectory(await tempDir('cards'), silent);
    await characters.save(CharacterInputSchema.parse({ name: 'Aria', description: '{{char}} is 25.' }));
    const llm = new ScriptedLlm();
    const chat = new ChatService(characters, store, llm, {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.8,
      topP: 0.9,
    });
    const voices = new VoiceStore(await tempDir('voices'));
    const memoryStore = new MemoryStore(db);
    const faces = new FaceStore(await tempDir('faces'));
    const designed: string[] = [];
    const tts = {
      status: async () => ({ available: true, model: 'fake' }),
      speak: async () => fakeFlac(),
      designCandidate: async (_id: string, description: string) => {
        designed.push(description);
        return voices.addCandidate(fakeFlac(5), { ...info(), description });
      },
    };
    app = await buildApp({
      chat,
      characters,
      llm,
      memoryStore,
      faces,
      voices,
      voice: { stt: { status: () => ({ available: true, model: 'x' }), transcribe: async () => '' }, tts },
      characterService: new CharacterService(characters, chat, store, memoryStore, faces, undefined, voices),
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    return { voices, designed };
  }

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });

  it('designs a candidate, plays it, keeps it, then serves and deletes her voice', async () => {
    const { voices, designed } = await makeApp();
    expect((await req('GET', '/api/characters/aria/voice')).statusCode).toBe(404);
    expect((await req('GET', '/api/characters/aria')).json().voice).toBeNull();

    const created = await req('POST', '/api/characters/aria/voice/candidates', { description: 'warm and calm' });
    expect(created.statusCode).toBe(200);
    const { candidate } = created.json();
    expect(designed).toEqual(['warm and calm']);
    const preview = await req('GET', `/api/characters/aria/voice/candidates/${candidate}`);
    expect(preview.headers['content-type']).toBe('audio/flac');

    expect((await req('POST', `/api/characters/aria/voice/candidates/${candidate}`)).statusCode).toBe(204);
    const voice = await req('GET', '/api/characters/aria/voice');
    expect(voice.statusCode).toBe(200);
    expect(voice.rawPayload.subarray(0, 4).toString('ascii')).toBe('fLaC');
    expect((await req('GET', '/api/characters/aria')).json().voice).toMatchObject({ description: 'warm and calm' });

    expect((await req('DELETE', '/api/characters/aria/voice')).statusCode).toBe(204);
    expect(await voices.get('aria')).toBeUndefined();
  });

  it('validates descriptions and candidate ids', async () => {
    await makeApp();
    expect((await req('POST', '/api/characters/aria/voice/candidates', { description: '' })).statusCode).toBe(400);
    expect(
      (await req('POST', '/api/characters/aria/voice/candidates', { description: 'a'.repeat(501) })).statusCode,
    ).toBe(400);
    expect((await req('GET', '/api/characters/aria/voice/candidates/nope')).statusCode).toBe(400);
    expect((await req('POST', '/api/characters/ghost/voice/candidates', { description: 'x' })).statusCode).toBe(404);
  });

  it('deletes her voice with the character', async () => {
    const { voices } = await makeApp();
    await voices.save('aria', fakeFlac(), info());
    expect((await req('DELETE', '/api/characters/aria')).statusCode).toBe(200);
    expect(await voices.get('aria')).toBeUndefined();
  });
});
