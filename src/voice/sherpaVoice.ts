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
import { join, resolve } from 'node:path';
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

export class SherpaSpeechToText implements SpeechToText {
  private readonly mutex = new Mutex();
  private recognizer?: Promise<OfflineRecognizer>;
  private readonly files: { encoder: string; decoder: string; tokens: string };

  constructor(private readonly opts: SherpaSttOptions) {
    const m = STT_MODELS[opts.model];
    const dir = join(resolve(opts.modelsDir), m.dir);
    this.files = {
      encoder: join(dir, `${m.prefix}-encoder.int8.onnx`),
      decoder: join(dir, `${m.prefix}-decoder.int8.onnx`),
      tokens: join(dir, `${m.prefix}-tokens.txt`),
    };
  }

  status(): VoiceComponentStatus {
    const missing = firstMissing(Object.values(this.files));
    return missing
      ? { available: false, model: this.opts.model, reason: 'model not downloaded (run: npm run setup:voice)' }
      : { available: true, model: this.opts.model };
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
    if (!this.recognizer) {
      const { available, reason } = this.status();
      if (!available) throw new VoiceUnavailableError(`Speech-to-text unavailable: ${reason}`);
      this.recognizer = loadSherpa().then((sherpa) =>
        sherpa.OfflineRecognizer.createAsync({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            whisper: {
              encoder: this.files.encoder,
              decoder: this.files.decoder,
              language: this.opts.language,
              task: 'transcribe',
            },
            tokens: this.files.tokens,
            numThreads: this.opts.numThreads,
            provider: 'cpu',
          },
        }),
      );
      // A failed load must not be cached forever: allow a retry.
      this.recognizer.catch(() => (this.recognizer = undefined));
    }
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

export class SherpaTextToSpeech implements TextToSpeech {
  private readonly mutex = new Mutex();
  private tts?: Promise<OfflineTts>;
  private readonly files: { model: string; tokens: string; dataDir: string };

  constructor(private readonly opts: SherpaTtsOptions) {
    const v = TTS_VOICES[opts.voice];
    const dir = join(resolve(opts.modelsDir), v.dir);
    this.files = {
      model: join(dir, `${v.file}.onnx`),
      tokens: join(dir, 'tokens.txt'),
      dataDir: join(dir, 'espeak-ng-data'),
    };
  }

  status(): VoiceComponentStatus {
    const missing = firstMissing(Object.values(this.files));
    return missing
      ? { available: false, model: this.opts.voice, reason: 'voice not downloaded (run: npm run setup:voice)' }
      : { available: true, model: this.opts.voice };
  }

  synthesize(text: string): Promise<AudioClip> {
    return this.mutex.run(async () => {
      const tts = await this.load();
      const audio = await tts.generateAsync({
        text,
        sid: TTS_VOICES[this.opts.voice].speakerId,
        speed: this.opts.speed,
      });
      return { samples: audio.samples, sampleRate: audio.sampleRate };
    });
  }

  private load() {
    if (!this.tts) {
      const { available, reason } = this.status();
      if (!available) throw new VoiceUnavailableError(`Text-to-speech unavailable: ${reason}`);
      this.tts = loadSherpa().then((sherpa) =>
        sherpa.OfflineTts.createAsync({
          model: {
            vits: { model: this.files.model, tokens: this.files.tokens, dataDir: this.files.dataDir },
            numThreads: this.opts.numThreads,
            provider: 'cpu',
          },
          maxNumSentences: 1,
        }),
      );
      this.tts.catch(() => (this.tts = undefined));
    }
    return this.tts;
  }
}
