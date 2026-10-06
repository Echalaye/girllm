/**
 * Her voice (step 7): Qwen3-TTS in ComfyUI, used like the photos:
 *
 *   text ─► cleaned (no *actions*, emojis, URLs) ─► cache? ─► play
 *        └► EXCLUSIVE GPU PHASE (other LLM calls wait): unload the chat
 *           model ─► upload her reference clip ─► ComfyUI voice clone
 *           ─► FLAC ─► ComfyUI /free ─► cached on disk ─► play
 *
 * Each character speaks with her own reference clip (VoiceStore), made by
 * the VoiceDesign model from a description: in the editor (candidates the
 * user listens to and keeps), or automatically the first time she speaks
 * (from her card's voice description, or a default one for her gender).
 *
 * Spoken messages are cached by (voice, language, text): replaying a
 * message, or the same reply in a call, costs nothing. Identical requests
 * running at the same time share one generation.
 */
import { createHash, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CharacterRepository } from '../characters/characterRepository.js';
import { MAX_VOICE_DESCRIPTION_CHARS, type Character } from '../characters/schema.js';
import type { ComfyClient } from '../images/comfyClient.js';
import type { LlmProvider } from '../llm/types.js';
import { writeFileAtomic } from '../util/atomicWrite.js';
import type { GpuGate } from '../util/gpuGate.js';
import { resolve as resolveLive, type Live } from '../util/resolve.js';
import {
  buildVoiceCloneWorkflow,
  buildVoiceDesignWorkflow,
  qwenLanguage,
  voiceSampleText,
  type QwenLanguage,
} from './qwenTts.js';
import { cleanForSpeech } from './speechText.js';
import { VoiceUnavailableError, type VoiceComponentStatus } from './types.js';
import { adultVoicePrefix, assertCardVoiceSafe, assertVoiceSafe } from './voiceSafety.js';
import type { StoredVoice, VoiceInfo, VoiceStore } from './voiceStore.js';

/** Longest text spoken at once (~1.5 minutes of speech); longer replies are cut at a sentence end. */
export const MAX_SPEECH_CHARS = 1500;
/** Spoken messages kept on disk (oldest removed first). ~0.1 MB per second of speech. */
export const MAX_CACHED_CLIPS = 300;
/**
 * Status checks hit ComfyUI: cache them. A failure is cached briefly only,
 * since ComfyUI is often still starting when girllm starts (start.bat).
 */
const STATUS_TTL_MS = { ready: 60_000, unavailable: 5_000 } as const;

/** Voice of a character whose card says nothing about it. */
export const DEFAULT_VOICE_DESCRIPTION = {
  female:
    'Natural, warm voice of a woman in her late twenties, medium pitch, friendly and relaxed, speaking at a calm conversational pace.',
  male: 'Natural, warm voice of a man in his late twenties, medium-low pitch, friendly and relaxed, speaking at a calm conversational pace.',
} as const;

export interface SpeechOptions {
  /** Reply-language setting (free text), mapped to a model language. */
  replyLanguage?: string | undefined;
}

export interface SpeechLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * Text as it will be spoken: cleaned, and cut at the last sentence end
 * before MAX_SPEECH_CHARS. '' when nothing is speakable. Pure (tests).
 */
export function prepareSpeech(text: string): string {
  const speech = cleanForSpeech(text);
  if (speech.length <= MAX_SPEECH_CHARS) return speech;
  const head = speech.slice(0, MAX_SPEECH_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('… '));
  return end > MAX_SPEECH_CHARS / 2 ? head.slice(0, end + 1) : head;
}

export class SpeechService {
  private statusCache: { at: number; value: VoiceComponentStatus } | undefined;
  /** Generations in progress, by cache key (same text twice = one job). */
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  /** Voices being made automatically, by character (never two at once). */
  private readonly autoVoices = new Map<string, Promise<StoredVoice>>();
  private readonly cacheDir: string;

  constructor(
    private readonly deps: {
      comfy: ComfyClient;
      gate: GpuGate;
      llm: Pick<LlmProvider, 'unload'>;
      characters: Pick<CharacterRepository, 'get'>;
      voices: VoiceStore;
      cacheDir: string;
      log: SpeechLogger;
      options: Live<SpeechOptions>;
    },
  ) {
    this.cacheDir = resolve(deps.cacheDir);
  }

  /** Can she speak right now? (ComfyUI up, Qwen3-TTS nodes installed; cached a minute) */
  async status(): Promise<VoiceComponentStatus> {
    const now = Date.now();
    const cached = this.statusCache;
    if (cached && now - cached.at < STATUS_TTL_MS[cached.value.available ? 'ready' : 'unavailable']) {
      return cached.value;
    }
    const comfy = await this.deps.comfy.status();
    let value: VoiceComponentStatus;
    if (!comfy.ok) value = { available: false, model: 'Qwen3-TTS', reason: `ComfyUI unreachable (${comfy.error})` };
    else {
      const support = await this.deps.comfy.qwenTtsSupport();
      value = support.ready
        ? { available: true, model: 'Qwen3-TTS 1.7B' }
        : { available: false, model: 'Qwen3-TTS', reason: support.reason ?? 'not installed' };
    }
    this.statusCache = { at: now, value };
    return value;
  }

  /**
   * Say `text` with the character's voice.
   * @returns FLAC bytes, or undefined when there is nothing to say (only *actions*).
   * @throws VoiceUnavailableError, VoiceRefusedError, Error('Character not found')
   */
  async speak(characterId: string, text: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const speech = prepareSpeech(text);
    if (!speech) return undefined;
    const character = this.requireCharacter(characterId);
    const language = this.language();

    const voice = (await this.deps.voices.get(characterId)) ?? (await this.autoVoice(character, language, signal));
    const key = createHash('sha256').update(`${voice.hash}\n${language}\n${speech}`).digest('hex');
    const cached = await this.readCache(key);
    if (cached) return cached;

    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.clone(characterId, voice, speech, language, key, signal).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, job);
    return job;
  }

  /**
   * Design a voice from a description, kept as a candidate for the editor.
   * @returns the candidate id (listen with VoiceStore.candidatePath).
   */
  async designCandidate(characterId: string, description: string, signal?: AbortSignal): Promise<string> {
    const character = this.requireCharacter(characterId);
    const language = this.language();
    const designed = await this.design(character, description, language, signal);
    return this.deps.voices.addCandidate(designed.flac, designed.info);
  }

  // ---------------------------------------------------------------------------

  private requireCharacter(characterId: string): Character {
    const character = this.deps.characters.get(characterId);
    if (!character) throw Object.assign(new Error('Character not found'), { statusCode: 404 });
    // Same rule as photos: a card stating an under-18 age gets no voice.
    assertCardVoiceSafe(
      [character.description, character.personality, character.scenario, character.appearance].join('\n'),
    );
    return character;
  }

  private language(): QwenLanguage {
    return qwenLanguage(resolveLive(this.deps.options).replyLanguage);
  }

  /** First time she speaks without a voice: design one from her card (or the default) and keep it. */
  private autoVoice(character: Character, language: QwenLanguage, signal?: AbortSignal): Promise<StoredVoice> {
    const running = this.autoVoices.get(character.id);
    if (running) return running;
    const job = (async () => {
      const description = character.voiceDescription || DEFAULT_VOICE_DESCRIPTION[character.gender];
      const designed = await this.design(character, description, language, signal);
      await this.deps.voices.save(character.id, designed.flac, designed.info);
      this.deps.log.info({ character: character.id }, 'voice created automatically');
      const stored = await this.deps.voices.get(character.id);
      if (!stored) throw new Error('The new voice could not be stored');
      return stored;
    })().finally(() => {
      this.autoVoices.delete(character.id);
    });
    this.autoVoices.set(character.id, job);
    return job;
  }

  /** VoiceDesign: she says the sample sentence in the described voice. */
  private async design(
    character: Character,
    description: string,
    language: QwenLanguage,
    signal?: AbortSignal,
  ): Promise<{ flac: Buffer; info: VoiceInfo }> {
    const wanted = description.trim().slice(0, MAX_VOICE_DESCRIPTION_CHARS);
    if (!wanted) throw Object.assign(new Error('Describe her voice first'), { statusCode: 400 });
    assertVoiceSafe(wanted);
    const text = voiceSampleText(language);
    const workflow = buildVoiceDesignWorkflow({
      description: `${adultVoicePrefix(character.gender)} ${wanted}`,
      text,
      language,
      seed: randomInt(2 ** 47),
    });
    const flac = await this.onGpu(() => this.deps.comfy.generateAudio(workflow, signal), signal);
    return { flac, info: { text, description: wanted, language, createdAt: new Date().toISOString() } };
  }

  /** Voice clone: `speech` said with her reference clip, then cached. */
  private async clone(
    characterId: string,
    voice: StoredVoice,
    speech: string,
    language: QwenLanguage,
    key: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const flac = await this.onGpu(async () => {
      // Named after the clip's content: a changed voice is a new file, and
      // the same voice is uploaded under the same name (overwritten).
      const name = `girllm_voice_${characterId}_${voice.hash.slice(0, 16)}.flac`;
      const reference = await this.deps.comfy.uploadFile(await readFile(voice.path), name, 'audio/flac');
      const workflow = buildVoiceCloneWorkflow({
        referenceAudio: reference,
        referenceText: voice.info.text,
        text: speech,
        language,
        seed: randomInt(2 ** 47),
      });
      return this.deps.comfy.generateAudio(workflow, signal);
    }, signal);
    await this.writeCache(key, flac).catch((err: unknown) => {
      this.deps.log.warn({ err }, 'could not cache the spoken message');
    });
    return flac;
  }

  /**
   * The exclusive GPU phase: unload the chat model, run the job, then always
   * give the VRAM back. Fails fast (without unloading anything) when ComfyUI
   * can't speak, or when the request was cancelled while waiting for the GPU.
   */
  private async onGpu<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const status = await this.status();
    if (!status.available) throw new VoiceUnavailableError(`Her voice is unavailable: ${status.reason}`);
    return this.deps.gate.runExclusive(async () => {
      signal?.throwIfAborted(); // the user left while a photo or another voice had the GPU
      await this.deps.llm.unload?.().catch((err: unknown) => {
        this.deps.log.warn({ err }, 'could not unload the LLM');
      });
      try {
        return await job();
      } finally {
        await this.deps.comfy.free().catch((err: unknown) => {
          this.deps.log.warn({ err }, 'could not free ComfyUI memory');
        });
      }
    });
  }

  // ---- cache -------------------------------------------------------------------

  private cachePath(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid cache key');
    return join(this.cacheDir, `${key}.flac`);
  }

  private async readCache(key: string): Promise<Buffer | undefined> {
    const path = this.cachePath(key);
    return existsSync(path) ? readFile(path).catch(() => undefined) : undefined;
  }

  private async writeCache(key: string, flac: Buffer): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFileAtomic(this.cachePath(key), flac);
    await this.pruneCache();
  }

  /** Keep the newest MAX_CACHED_CLIPS clips. */
  private async pruneCache(): Promise<void> {
    const names = (await readdir(this.cacheDir)).filter((n) => n.endsWith('.flac'));
    if (names.length <= MAX_CACHED_CLIPS) return;
    const files = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: (await stat(join(this.cacheDir, name))).mtimeMs })),
    );
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files.slice(0, files.length - MAX_CACHED_CLIPS)) {
      await rm(join(this.cacheDir, f.name), { force: true });
    }
  }
}
