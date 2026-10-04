/**
 * Local speech-to-text (Whisper) and text-to-speech (Piper/VITS voices)
 * using sherpa-onnx: native ONNX Runtime on the CPU, prebuilt for Windows,
 * no Python. Running on the CPU keeps the 8 GB of VRAM for the LLM.
 *
 * Models are loaded lazily on first use (~1 s each) and kept in memory.
 * Each engine processes one request at a time (Mutex): the native handles
 * are not documented as thread-safe, and parallel jobs would only fight
 * for the same CPU cores anyway.
 */
import { existsSync } from 'node:fs';
// Type-only imports: erased at compile time, so the native addon is still
// loaded lazily by loadSherpa() below.
import type sherpaModule from 'sherpa-onnx-node';
import type { OfflineRecognizer, OfflineTts } from 'sherpa-onnx-node';
import { join, resolve as resolvePath } from 'node:path';
import { resolve, type Live } from '../util/resolve.js';
import { Mutex } from '../util/mutex.js';
import { STT_MODELS, TTS_VOICES, type SttModelId, type TtsVoiceId } from './catalog.js';
import {
  VoiceUnavailableError,
  type AudioClip,
  type SpeechToText,
  type TextToSpeech,
  type VoiceComponentStatus,
} from './types.js';

type Sherpa = typeof sherpaModule;

/** Import the native addon only when voice is actually used. */
let sherpaPromise: Promise<Sherpa> | undefined;
function loadSherpa(): Promise<Sherpa> {
  sherpaPromise ??= import('sherpa-onnx-node').then((m) => m.default);
  return sherpaPromise;
}

/** Returns the first missing path, or undefined if all exist. */
function firstMissing(paths: string[]): string | undefined {
  return paths.find((p) => !existsSync(p));
}

// ----------------------------------------------------------------- STT

export interface SherpaSttOptions {
  modelsDir: string;
  model: SttModelId;
  /** ISO 639-1 code ("fr"), or "" for automatic language detection. */
  language: string;
  numThreads: number;
}

/** Model files of a Whisper model inside MODELS_DIR. */
function sttFiles(modelsDir: string, model: SttModelId) {
  const m = STT_MODELS[model];
  const dir = join(resolvePath(modelsDir), m.dir);
  return {
    encoder: join(dir, `${m.prefix}-encoder.int8.onnx`),
    decoder: join(dir, `${m.prefix}-decoder.int8.onnx`),
    tokens: join(dir, `${m.prefix}-tokens.txt`),
  };
}

export class SherpaSpeechToText implements SpeechToText {
  private readonly mutex = new Mutex();
  private recognizer?: Promise<OfflineRecognizer>;
  /** Options the loaded recognizer was built with (reload when they change). */
  private loadedKey = '';

  /** @param options fixed, or a function returning the current ones (live settings). */
  constructor(private readonly options: Live<SherpaSttOptions>) {}

  private get opts(): SherpaSttOptions {
    return resolve(this.options);
  }

  status(): VoiceComponentStatus {
    const { model, modelsDir } = this.opts;
    const missing = firstMissing(Object.values(sttFiles(modelsDir, model)));
    return missing
      ? { available: false, model, reason: 'model not downloaded (run: npm run setup:voice)' }
      : { available: true, model };
  }

  transcribe(audio: AudioClip): Promise<string> {
    return this.mutex.run(async () => {
      const recognizer = await this.load();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: audio.samples, sampleRate: audio.sampleRate });
      const result = await recognizer.decodeAsync(stream);
      return result.text.trim();
    });
  }

  private load() {
    const o = this.opts;
    const key = `${o.model}|${o.language}|${o.numThreads}`;
    if (this.recognizer && key === this.loadedKey) return this.recognizer;

    const { available, reason } = this.status();
    if (!available) throw new VoiceUnavailableError(`Speech-to-text unavailable: ${reason}`);
    const files = sttFiles(o.modelsDir, o.model);
    this.loadedKey = key;
    this.recognizer = loadSherpa().then((sherpa) =>
      sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder: files.encoder, decoder: files.decoder, language: o.language, task: 'transcribe' },
          tokens: files.tokens,
          numThreads: o.numThreads,
          provider: 'cpu',
        },
      }),
    );
    // A failed load must not be cached forever: allow a retry.
    this.recognizer.catch(() => (this.recognizer = undefined));
    return this.recognizer;
  }
}

// ----------------------------------------------------------------- TTS

export interface SherpaTtsOptions {
  modelsDir: string;
  voice: TtsVoiceId;
  /** 1 = normal; >1 faster. */
  speed: number;
  numThreads: number;
}

/** Model files of a Piper voice inside MODELS_DIR. */
function ttsFiles(modelsDir: string, voice: TtsVoiceId) {
  const v = TTS_VOICES[voice];
  const dir = join(resolvePath(modelsDir), v.dir);
  return { model: join(dir, `${v.file}.onnx`), tokens: join(dir, 'tokens.txt'), dataDir: join(dir, 'espeak-ng-data') };
}

/** Is this voice downloaded? (used to list choices in the settings) */
export function isTtsVoiceInstalled(modelsDir: string, voice: TtsVoiceId): boolean {
  return firstMissing(Object.values(ttsFiles(modelsDir, voice))) === undefined;
}

export class SherpaTextToSpeech implements TextToSpeech {
  private readonly mutex = new Mutex();
  private tts?: Promise<OfflineTts>;
  /** Voice the loaded engine was built with (reload when it changes). */
  private loadedVoice?: TtsVoiceId;

  /** @param options fixed, or a function returning the current ones (live settings). */
  constructor(private readonly options: Live<SherpaTtsOptions>) {}

  private get opts(): SherpaTtsOptions {
    return resolve(this.options);
  }

  status(): VoiceComponentStatus {
    const { voice, modelsDir } = this.opts;
    return isTtsVoiceInstalled(modelsDir, voice)
      ? { available: true, model: voice }
      : { available: false, model: voice, reason: 'voice not downloaded (run: npm run setup:voice)' };
  }

  synthesize(text: string): Promise<AudioClip> {
    return this.mutex.run(async () => {
      const o = this.opts; // read once: voice and speed of THIS request
      const tts = await this.load(o);
      const audio = await tts.generateAsync({ text, sid: TTS_VOICES[o.voice].speakerId, speed: o.speed });
      return { samples: audio.samples, sampleRate: audio.sampleRate };
    });
  }

  private load(o: SherpaTtsOptions) {
    if (this.tts && o.voice === this.loadedVoice) return this.tts;

    if (!isTtsVoiceInstalled(o.modelsDir, o.voice)) {
      throw new VoiceUnavailableError('Text-to-speech unavailable: voice not downloaded (run: npm run setup:voice)');
    }
    const files = ttsFiles(o.modelsDir, o.voice);
    this.loadedVoice = o.voice;
    this.tts = loadSherpa().then((sherpa) =>
      sherpa.OfflineTts.createAsync({
        model: {
          vits: { model: files.model, tokens: files.tokens, dataDir: files.dataDir },
          numThreads: o.numThreads,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      }),
    );
    this.tts.catch(() => (this.tts = undefined));
    return this.tts;
  }
}
