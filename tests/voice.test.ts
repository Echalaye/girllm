import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mutex } from '../src/util/mutex.js';
import { STT_MODELS } from '../src/voice/catalog.js';
import { SherpaSpeechToText } from '../src/voice/sherpaVoice.js';
import { cleanForSpeech, cleanTranscript } from '../src/voice/speechText.js';
import { VoiceUnavailableError } from '../src/voice/types.js';
import { decodeFloat32 } from '../src/voice/wav.js';

describe('cleanForSpeech', () => {
  it('drops actions, emojis, markdown and URLs', () => {
    expect(cleanForSpeech('*sourit* Coucou 😊 **toi** ! Regarde https://x.y/z ça _marche_')).toBe(
      'Coucou toi ! Regarde ça marche',
    );
    expect(cleanForSpeech('*se blottit contre toi*')).toBe('');
  });
});

describe('wav helpers', () => {
  it('decodes float32 payloads, sanitising bad values', () => {
    const buf = Buffer.from(Float32Array.from([0.5, Number.NaN, 3, -Infinity]).buffer);
    expect(Array.from(decodeFloat32(buf))).toEqual([0.5, 0, 1, 0]);
    expect(() => decodeFloat32(Buffer.alloc(3))).toThrow(/float32/);
  });
});

describe('Mutex', () => {
  it('runs tasks one at a time in order and propagates errors', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) =>
      m.run(async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        return name;
      });
    const failing = m.run(async () => {
      throw new Error('boom');
    });
    const results = await Promise.all([
      task('a', 20),
      failing.catch((e: unknown) => (e as Error).message),
      task('b', 1),
    ]);
    expect(results).toEqual(['a', 'boom', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});

describe('voice catalog', () => {
  it('pins every archive to the official releases with a SHA-256', () => {
    for (const m of Object.values(STT_MODELS)) {
      expect(m.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.url.endsWith(`${m.dir}.tar.bz2`)).toBe(true);
    }
  });
});

describe('speech-to-text without its model', () => {
  it('reports unavailable and refuses to run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girllm-models-'));
    const stt = new SherpaSpeechToText({ modelsDir: dir, model: 'whisper-base', language: 'fr', numThreads: 1 });
    expect(stt.status()).toMatchObject({ available: false, model: 'whisper-base' });
    expect(stt.status().reason).toMatch(/setup:voice/);
    await expect(stt.transcribe({ samples: new Float32Array(16000), sampleRate: 16000 })).rejects.toBeInstanceOf(
      VoiceUnavailableError,
    );
  });
});

describe('cleanTranscript', () => {
  it('keeps real speech, normalized', () => {
    expect(cleanTranscript('  Salut,   ça va ?  ')).toBe('Salut, ça va ?');
  });

  it('drops Whisper hallucinations on silence or noise', () => {
    for (const phantom of [
      "Sous-titres réalisés par la communauté d'Amara.org",
      "Merci d'avoir regardé cette vidéo !",
      'Thank you for watching.',
      '...',
      '♪ ♪',
      '',
    ]) {
      expect(cleanTranscript(phantom)).toBe('');
    }
  });
});
