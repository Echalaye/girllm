/**
 * Step 7b: a real voice for her — the user's own (microphone) or that of an
 * adult who agreed (a file). Audio helpers, WAV clips in the voice store,
 * the checks and transcript of SpeechService.customCandidate, and the HTTP
 * route with its consent header.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { CharacterService } from '../src/characters/characterService.js';
import { CharacterInputSchema } from '../src/characters/schema.js';
import { ChatService } from '../src/chat/chatService.js';
import { buildApp } from '../src/http/app.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { GpuGate } from '../src/util/gpuGate.js';
import { readAloudText } from '../src/voice/qwenTts.js';
import { CUSTOM_VOICE, SpeechService, VoiceClipError } from '../src/voice/speechService.js';
import { VoiceUnavailableError } from '../src/voice/types.js';
import { VoiceRefusedError } from '../src/voice/voiceSafety.js';
import { audioContentType, audioType, VoiceStore } from '../src/voice/voiceStore.js';
import { encodeWav16, peakNormalize, resampleLinear, rms, trimSilence } from '../src/voice/wav.js';
import { FakeComfy, fakeFlac, makeCharacter, makeStore, ScriptedLlm } from './helpers.js';

const silent = { warn: () => {}, info: () => {} };
const HOST = '127.0.0.1:3210';
const RATE = 24_000;
const tempDir = (name: string) => mkdtemp(join(tmpdir(), `girllm-${name}-`));

/** "Speech": a 220 Hz tone of `seconds`, with `pad` seconds of silence on each side. */
function speech(seconds: number, amplitude = 0.3, pad = 0.5): Float32Array {
  const total = Math.round((seconds + 2 * pad) * RATE);
  const start = Math.round(pad * RATE);
  const end = start + Math.round(seconds * RATE);
  const out = new Float32Array(total);
  for (let i = start; i < end; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

describe('audio helpers', () => {
  it('encodes a valid 16-bit mono WAV with clamping', () => {
    const wav = encodeWav16(Float32Array.from([0, 1, -1, 2]), 22050);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, -32768, 32767]);
  });

  it('resamples, measures and levels', () => {
    expect(resampleLinear(new Float32Array(24_000), 24_000, 16_000)).toHaveLength(16_000);
    expect(resampleLinear(Float32Array.from([0, 1]), 1, 2)[1]).toBeCloseTo(0.5);
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
    const levelled = peakNormalize(Float32Array.from([0.1, -0.2]));
    expect(Math.max(...levelled.map(Math.abs))).toBeCloseTo(0.89);
    expect(Array.from(peakNormalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });

  it('trims the silence around speech, relative to the clip’s own level', () => {
    const loud = trimSilence(speech(2), RATE);
    expect(loud.length / RATE).toBeCloseTo(2 + 0.3, 1); // speech + 0.15 s padding each side
    // A very quiet recording is still speech, not silence.
    const quiet = trimSilence(speech(2, 0.01), RATE);
    expect(quiet.length / RATE).toBeGreaterThan(2);
    expect(trimSilence(new Float32Array(1000), RATE)).toHaveLength(0);
  });
});

describe('voice store: WAV clips', () => {
  it('keeps recorded voices as WAV next to designed FLAC ones', async () => {
    const store = new VoiceStore(await tempDir('voices'));
    const wav = encodeWav16(speech(1), RATE);
    const info = {
      text: 'Bonjour',
      description: 'Recorded',
      language: 'French',
      createdAt: 'now',
      source: 'recorded' as const,
      consentAt: 'now',
    };
    const id = await store.addCandidate(wav, info);
    expect(store.candidatePath(id)?.endsWith('.wav')).toBe(true);
    expect(await store.promote('aria', id)).toBe(true);
    const voice = await store.get('aria');
    expect(voice).toMatchObject({ type: 'wav', info: { source: 'recorded', consentAt: 'now' } });
    // Replacing it with a designed voice leaves no stale WAV behind.
    await store.save('aria', fakeFlac(), { text: 'Salut', description: 'warm', language: 'French', createdAt: 'now' });
    expect((await store.get('aria'))?.type).toBe('flac');
    expect(audioContentType(voice!.path)).toBe('audio/wav');
    expect(audioContentType('x.flac')).toBe('audio/flac');
  });

  it('recognises clips by their bytes only', () => {
    expect(audioType(fakeFlac())).toBe('flac');
    expect(audioType(encodeWav16(new Float32Array(1), RATE))).toBe('wav');
    expect(() => audioType(Buffer.from('<script>'))).toThrow(/FLAC or WAV/);
  });
});

async function service(o: { stt?: false; heard?: string; character?: Parameters<typeof makeCharacter>[0] } = {}) {
  const comfy = new FakeComfy();
  comfy.qwen = true;
  const voices = new VoiceStore(await tempDir('voices'));
  const heard: Float32Array[] = [];
  const speechService = new SpeechService({
    comfy: new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
    gate: new GpuGate(),
    llm: new ScriptedLlm(),
    characters: CharacterRepository.fromCharacters([makeCharacter(o.character)]),
    voices,
    cacheDir: await tempDir('speech'),
    log: silent,
    options: { replyLanguage: 'French' },
    stt:
      o.stt === false
        ? undefined
        : {
            transcribe: async (a) => {
              heard.push(a.samples);
              expect(a.sampleRate).toBe(16_000);
              return o.heard ?? "  Bonjour ! Aujourd'hui, j'ai pris le temps…  ";
            },
          },
  });
  return { comfy, voices, speech: speechService, heard };
}

const clip = (samples: Float32Array, source: 'recorded' | 'uploaded' = 'recorded') => ({
  samples,
  sampleRate: RATE,
  source,
  consentAt: '2026-10-07T08:00:00.000Z',
});

describe('SpeechService.customCandidate', () => {
  it('trims, levels and transcribes the clip, then keeps it as a WAV candidate', async () => {
    const { speech: s, voices, heard } = await service();
    const { candidate, transcript } = await s.customCandidate('aria', clip(speech(8, 0.05)));
    expect(transcript).toBe("Bonjour ! Aujourd'hui, j'ai pris le temps…");
    // Whisper got 16 kHz audio of the trimmed speech (8 s + padding).
    expect(heard[0]!.length / 16_000).toBeCloseTo(8.3, 1);
    expect(voices.candidatePath(candidate)?.endsWith('.wav')).toBe(true);
    expect(await voices.promote('aria', candidate)).toBe(true);
    expect((await voices.get('aria'))?.info).toMatchObject({
      text: transcript,
      source: 'recorded',
      consentAt: '2026-10-07T08:00:00.000Z',
    });
  });

  it('then speaks every message with that voice (uploaded to ComfyUI as WAV)', async () => {
    const { speech: s, voices, comfy } = await service();
    const { candidate } = await s.customCandidate('aria', clip(speech(8)));
    await voices.promote('aria', candidate);
    await s.speak('aria', 'Coucou');
    expect(comfy.queued).toHaveLength(1); // no voice design: hers is the recording
    const wf = comfy.queued[0]!.prompt;
    expect(String(wf['1']!.inputs.audio)).toMatch(/^girllm_voice_aria_[0-9a-f]{16}\.wav$/);
    expect(wf['2']!.inputs.ref_text).toBe("Bonjour ! Aujourd'hui, j'ai pris le temps…");
    expect(comfy.uploads[0]?.type).toBe('audio/wav');
  });

  it.each([
    ['too short', speech(CUSTOM_VOICE.minSeconds - 1), /at least 4 seconds/],
    ['silent', new Float32Array(10 * RATE), /at least 4 seconds/],
    ['too long', speech(CUSTOM_VOICE.maxSeconds + 2, 0.3, 0.1), /30 seconds at most/],
    ['far too long', new Float32Array((CUSTOM_VOICE.maxRawSeconds + 1) * RATE), /30 seconds at most/],
  ] as const)('refuses a clip that is %s', async (_label, samples, message) => {
    const { speech: s, voices } = await service();
    const err = await s.customCandidate('aria', clip(samples)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceClipError);
    expect((err as Error).message).toMatch(message);
    expect((err as VoiceClipError).statusCode).toBe(422);
    expect(await voices.get('aria')).toBeUndefined();
  });

  it('refuses an odd sample rate, a clip without words, and works only with Whisper', async () => {
    const { speech: s } = await service();
    await expect(s.customCandidate('aria', { ...clip(speech(8)), sampleRate: 12_345 })).rejects.toThrow(/sample rate/);
    const mute = await service({ heard: 'Sous-titres réalisés par la communauté d’Amara.org' });
    await expect(mute.speech.customCandidate('aria', clip(speech(8)))).rejects.toThrow(/No words/);
    const noStt = await service({ stt: false });
    await expect(noStt.speech.customCandidate('aria', clip(speech(8)))).rejects.toBeInstanceOf(VoiceUnavailableError);
  });

  it('gives no voice at all to a card stating an under-18 age', async () => {
    const { speech: s } = await service({ character: { description: '{{char}} is 15 years old.' } });
    await expect(s.customCandidate('aria', clip(speech(8)))).rejects.toBeInstanceOf(VoiceRefusedError);
  });

  it('offers a sentence to read in the chat language', () => {
    expect(readAloudText('French')).toMatch(/^Bonjour/);
    expect(readAloudText('English')).toMatch(/^Hello/);
    expect(readAloudText('Auto')).toMatch(/^Hello/);
  });
});

describe('HTTP: recording or uploading her voice', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function makeApp() {
    const { db, store } = makeStore();
    const characters = await CharacterRepository.loadFromDirectory(await tempDir('cards'), silent);
    await characters.save(CharacterInputSchema.parse({ name: 'Aria', description: '{{char}} is 25.' }));
    const llm = new ScriptedLlm();
    const chat = new ChatService(characters, store, llm, {
      userName: 'Etienne',
      budget: { contextTokens: 4096, maxReplyTokens: 200 },
      temperature: 0.8,
      topP: 0.9,
    });
    const comfy = new FakeComfy();
    comfy.qwen = true;
    const voices = new VoiceStore(await tempDir('voices'));
    const stt = {
      status: () => ({ available: true, model: 'whisper-base' }),
      transcribe: async () => 'Bonjour à toi.',
    };
    const tts = new SpeechService({
      comfy: new ComfyClient({ baseUrl: 'http://comfy', pollIntervalMs: 1, fetchImpl: comfy.fetch }),
      gate: new GpuGate(),
      llm,
      characters,
      voices,
      cacheDir: await tempDir('speech'),
      log: silent,
      options: { replyLanguage: 'French' },
      stt,
    });
    const memoryStore = new MemoryStore(db);
    const faces = new FaceStore(await tempDir('faces'));
    app = await buildApp({
      chat,
      characters,
      llm,
      memoryStore,
      faces,
      voices,
      voice: { stt, tts },
      characterService: new CharacterService(characters, chat, store, memoryStore, faces, undefined, voices),
      allowedHosts: [HOST],
      userName: 'Etienne',
    });
    return { voices };
  }

  const put = (samples: Float32Array, o: { consent?: string | null; query?: string } = {}) =>
    app.inject({
      method: 'PUT',
      url: `/api/characters/aria/voice/candidates?${o.query ?? `rate=${RATE}&source=recorded`}`,
      headers: {
        host: HOST,
        'content-type': 'application/octet-stream',
        ...(o.consent === null ? {} : { 'x-girllm-consent': o.consent ?? 'own-voice-or-consenting-adult' }),
      },
      payload: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    });

  it('needs the consent attestation, then returns a candidate with what was heard', async () => {
    const { voices } = await makeApp();
    expect((await put(speech(8), { consent: null })).statusCode).toBe(428);
    expect((await put(speech(8), { consent: 'yes' })).statusCode).toBe(428);
    const res = await put(speech(8));
    expect(res.statusCode).toBe(200);
    const { candidate, transcript } = res.json();
    expect(transcript).toBe('Bonjour à toi.');
    const preview = await app.inject({
      method: 'GET',
      url: `/api/characters/aria/voice/candidates/${candidate}`,
      headers: { host: HOST },
    });
    expect(preview.headers['content-type']).toBe('audio/wav');
    expect(preview.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
    await app.inject({
      method: 'POST',
      url: `/api/characters/aria/voice/candidates/${candidate}`,
      headers: { host: HOST },
    });
    const voice = await app.inject({ method: 'GET', url: '/api/characters/aria/voice', headers: { host: HOST } });
    expect(voice.headers['content-type']).toBe('audio/wav');
    expect((await voices.get('aria'))?.info.source).toBe('recorded');
  });

  it('explains what is wrong with an unusable clip, and validates the request', async () => {
    await makeApp();
    const short = await put(speech(1));
    expect(short.statusCode).toBe(422);
    expect(short.json().error).toMatch(/at least 4 seconds/);
    expect((await put(speech(8), { query: 'rate=24000&source=stolen' })).statusCode).toBe(400);
    expect(
      (await put(Float32Array.from([1, 2, 3]).subarray(0, 3), { query: 'rate=abc&source=recorded' })).statusCode,
    ).toBe(400);
    const odd = await app.inject({
      method: 'PUT',
      url: `/api/characters/aria/voice/candidates?rate=${RATE}&source=uploaded`,
      headers: {
        host: HOST,
        'content-type': 'application/octet-stream',
        'x-girllm-consent': 'own-voice-or-consenting-adult',
      },
      payload: Buffer.alloc(7),
    });
    expect(odd.statusCode).toBe(400);
  });

  it('gives the page a sentence to read', async () => {
    await makeApp();
    const status = (await app.inject({ method: 'GET', url: '/api/voice', headers: { host: HOST } })).json();
    expect(status.readAloud).toMatch(/^Bonjour/);
  });
});
