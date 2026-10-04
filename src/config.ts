/**
 * Application configuration.
 *
 * All settings come from environment variables (optionally loaded from a
 * `.env` file at startup) and are validated with zod so that the app fails
 * fast with a readable error instead of misbehaving at runtime.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { STT_MODEL_IDS, TTS_VOICE_IDS, type SttModelId, type TtsVoiceId } from './voice/catalog.js';

/** Accepts "" as "not set" so empty lines in .env don't break validation. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/** Treat "" (an empty line in .env) as "not set", so the default applies. */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** "true"/"false"/"1"/"0" (case-insensitive) -> boolean. */
const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected true or false' });
      return z.NEVER;
    });

const ConfigSchema = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3210),

    // "ollama" = native Ollama API (recommended: context size + min_p),
    // "openai" = any OpenAI-compatible server (llama.cpp, KoboldCpp, LM Studio).
    LLM_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
    LLM_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
    // Ollama duration ("30m", "2h") or -1 to keep the model loaded forever.
    LLM_KEEP_ALIVE: z
      .string()
      .regex(/^(-1|\d+(ms|s|m|h))$/, 'e.g. 30m, 2h or -1')
      .default('30m'),
    LLM_MODEL: z.string().min(1).default('mistral-nemo:12b-instruct-2407-q4_K_M'),
    LLM_API_KEY: optionalString,

    CONTEXT_TOKENS: z.coerce.number().int().min(1024).max(262_144).default(8192),
    MAX_REPLY_TOKENS: z.coerce.number().int().min(16).max(8192).default(400),
    TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
    TOP_P: z.coerce.number().gt(0).max(1).default(0.95),
    MIN_P: z.coerce.number().min(0).max(1).default(0.05),
    REPEAT_PENALTY: z.coerce.number().min(0.5).max(2).default(1.1),

    CHARACTERS_DIR: z.string().default('./characters'),
    USER_NAME: z.string().min(1).max(64).default('User'),
    // e.g. "French". Empty = no constraint (the model follows the card/user).
    REPLY_LANGUAGE: optionalString.pipe(
      z
        .string()
        .max(40)
        .regex(/^[\p{L} ()-]+$/u, 'letters only')
        .optional(),
    ),

    DATA_DIR: z.string().default('./data'),
    MEMORY_ENABLED: booleanFlag(true),
    // Empty = no embeddings (memories are then picked by recency only).
    EMBEDDING_MODEL: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? 'paraphrase-multilingual' : v.trim() || undefined)),
    EMBEDDING_BASE_URL: optionalString.pipe(z.string().url().optional()),
    MEMORY_TOP_K: z.coerce.number().int().min(1).max(30).default(8),
    MEMORY_EXTRACT_EVERY: z.coerce.number().int().min(2).max(50).default(4),

    VOICE_ENABLED: booleanFlag(true),
    MODELS_DIR: z.string().default('./models'),
    STT_MODEL: z.enum(STT_MODEL_IDS).default('whisper-base'),
    // ISO 639-1 code ("fr"); empty = Whisper detects the language itself.
    STT_LANGUAGE: z
      .string()
      .trim()
      .regex(/^([a-z]{2})?$/, 'two-letter code like fr, or empty')
      .default(''),
    TTS_VOICE: z.enum(TTS_VOICE_IDS).default('fr-siwis'),
    TTS_SPEED: z.coerce.number().min(0.5).max(2).default(1),
    VOICE_THREADS: z.coerce.number().int().min(1).max(16).default(4),

    IMAGES_ENABLED: booleanFlag(true),
    COMFYUI_URL: z.string().url().default('http://127.0.0.1:8188'),
    // Optional: ComfyUI install folder, so the launcher (start.bat) can start it.
    COMFYUI_DIR: optionalString,
    // File name of an SDXL checkpoint in ComfyUI/models/checkpoints. Empty = no images.
    IMAGE_CHECKPOINT: optionalString.pipe(
      z
        .string()
        .max(255)
        .regex(/^[\w .()/\\-]+$/, 'invalid file name')
        .optional(),
    ),
    IMAGE_WIDTH: z.coerce.number().int().min(512).max(2048).multipleOf(8).default(832),
    IMAGE_HEIGHT: z.coerce.number().int().min(512).max(2048).multipleOf(8).default(1216),
    IMAGE_STEPS: z.coerce.number().int().min(1).max(100).default(25),
    IMAGE_CFG: z.coerce.number().min(1).max(20).default(5.5),
    IMAGE_SAMPLER: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .default('dpmpp_2m'),
    IMAGE_SCHEDULER: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .default('karras'),
    // Tuned for realistic "sent from a phone" photos; see README for an anime variant.
    IMAGE_STYLE: z.preprocess(
      blankAsUnset,
      z
        .string()
        .max(500)
        .default(
          'candid smartphone photo, RAW photo, natural skin texture, realistic lighting, shallow depth of field, subtle film grain',
        ),
    ),
    IMAGE_NEGATIVE_PROMPT: z.preprocess(
      blankAsUnset,
      z
        .string()
        .max(1000)
        .default(
          'cgi, 3d render, illustration, painting, drawing, anime, plastic skin, airbrushed, oversaturated, lowres, blurry, ' +
            'jpeg artifacts, bad anatomy, bad hands, extra fingers, missing fingers, deformed face, asymmetric eyes, ' +
            'cross-eyed, watermark, text, logo, signature, multiple people',
        ),
    ),
    // Second refinement pass: 1 = off, 1.25 = +25% resolution with re-sampling (sharper, ~1.6x slower).
    IMAGE_HIRES_SCALE: z.coerce.number().min(1).max(2).default(1.25),
    IMAGE_HIRES_DENOISE: z.coerce.number().min(0.1).max(0.7).default(0.35),
    IMAGE_HIRES_STEPS: z.coerce.number().int().min(4).max(60).default(15),
    // Reference face strength (IP-Adapter, `npm run setup:images`): 0 = off, 0.6–0.8 recommended.
    IMAGE_FACE_WEIGHT: z.coerce.number().min(0).max(1).default(0.7),
    // She sends photos on her own: off | rare (≥ 12 of her messages apart) | often (≥ 5 apart).
    PHOTO_FREQUENCY: z.enum(['off', 'rare', 'often']).default('rare'),
    // She writes first after this many minutes of silence (0 = never).
    PROACTIVE_AFTER_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  })
  .refine((c) => c.MAX_REPLY_TOKENS < c.CONTEXT_TOKENS / 2, {
    message: 'MAX_REPLY_TOKENS must be less than half of CONTEXT_TOKENS',
    path: ['MAX_REPLY_TOKENS'],
  });

export const PHOTO_FREQUENCIES = ['off', 'rare', 'often'] as const;
export type PhotoFrequency = (typeof PHOTO_FREQUENCIES)[number];

export type AppConfig = Readonly<{
  host: string;
  port: number;
  llm: Readonly<{
    provider: 'ollama' | 'openai';
    baseUrl: string;
    model: string;
    apiKey: string | undefined;
    keepAlive: string;
  }>;
  generation: Readonly<{
    contextTokens: number;
    maxReplyTokens: number;
    temperature: number;
    topP: number;
    minP: number;
    repeatPenalty: number;
  }>;
  charactersDir: string;
  userName: string;
  /** Language every reply must be written in, or undefined for no constraint. */
  replyLanguage: string | undefined;
  /** SQLite database file path. */
  databasePath: string;
  /** DATA_DIR/faces: the characters' reference faces. */
  facesDir: string;
  memory: Readonly<{
    enabled: boolean;
    embeddingModel: string | undefined;
    embeddingBaseUrl: string;
    topK: number;
    extractEvery: number;
  }>;
  images: Readonly<{
    enabled: boolean;
    comfyUrl: string;
    /** ComfyUI install folder (used by the launcher only). */
    comfyDir: string | undefined;
    /** DATA_DIR/images */
    dir: string;
    checkpoint: string | undefined;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    style: string;
    negative: string;
    hires: Readonly<{ scale: number; denoise: number; steps: number }>;
    faceWeight: number;
    photoFrequency: PhotoFrequency;
  }>;
  /** Minutes of silence before she writes first (0 = never). */
  proactiveAfterMinutes: number;
  voice: Readonly<{
    enabled: boolean;
    modelsDir: string;
    sttModel: SttModelId;
    sttLanguage: string;
    ttsVoice: TtsVoiceId;
    ttsSpeed: number;
    threads: number;
  }>;
}>;

/**
 * Parse and validate configuration from a raw environment object.
 * Exported separately from `loadConfig` so it can be unit-tested.
 *
 * @throws Error with every invalid variable listed when validation fails.
 */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const c = result.data;
  return Object.freeze({
    host: c.HOST,
    port: c.PORT,
    // Strip trailing slashes so URL concatenation is predictable.
    llm: Object.freeze({
      provider: c.LLM_PROVIDER,
      baseUrl: c.LLM_BASE_URL.replace(/\/+$/, ''),
      model: c.LLM_MODEL,
      apiKey: c.LLM_API_KEY,
      keepAlive: c.LLM_KEEP_ALIVE,
    }),
    generation: Object.freeze({
      contextTokens: c.CONTEXT_TOKENS,
      maxReplyTokens: c.MAX_REPLY_TOKENS,
      temperature: c.TEMPERATURE,
      topP: c.TOP_P,
      minP: c.MIN_P,
      repeatPenalty: c.REPEAT_PENALTY,
    }),
    charactersDir: c.CHARACTERS_DIR,
    userName: c.USER_NAME,
    replyLanguage: c.REPLY_LANGUAGE,
    databasePath: join(c.DATA_DIR, 'girllm.db'),
    facesDir: join(c.DATA_DIR, 'faces'),
    memory: Object.freeze({
      enabled: c.MEMORY_ENABLED,
      embeddingModel: c.EMBEDDING_MODEL,
      embeddingBaseUrl: (c.EMBEDDING_BASE_URL ?? c.LLM_BASE_URL).replace(/\/+$/, ''),
      topK: c.MEMORY_TOP_K,
      extractEvery: c.MEMORY_EXTRACT_EVERY,
    }),
    images: Object.freeze({
      enabled: c.IMAGES_ENABLED,
      comfyUrl: c.COMFYUI_URL.replace(/\/+$/, ''),
      comfyDir: c.COMFYUI_DIR,
      dir: join(c.DATA_DIR, 'images'),
      checkpoint: c.IMAGE_CHECKPOINT,
      width: c.IMAGE_WIDTH,
      height: c.IMAGE_HEIGHT,
      steps: c.IMAGE_STEPS,
      cfg: c.IMAGE_CFG,
      sampler: c.IMAGE_SAMPLER,
      scheduler: c.IMAGE_SCHEDULER,
      style: c.IMAGE_STYLE.trim(),
      negative: c.IMAGE_NEGATIVE_PROMPT.trim(),
      hires: Object.freeze({ scale: c.IMAGE_HIRES_SCALE, denoise: c.IMAGE_HIRES_DENOISE, steps: c.IMAGE_HIRES_STEPS }),
      faceWeight: c.IMAGE_FACE_WEIGHT,
      photoFrequency: c.PHOTO_FREQUENCY,
    }),
    proactiveAfterMinutes: c.PROACTIVE_AFTER_MINUTES,
    voice: Object.freeze({
      enabled: c.VOICE_ENABLED,
      modelsDir: c.MODELS_DIR,
      sttModel: c.STT_MODEL,
      sttLanguage: c.STT_LANGUAGE,
      ttsVoice: c.TTS_VOICE,
      ttsSpeed: c.TTS_SPEED,
      threads: c.VOICE_THREADS,
    }),
  });
}

/** Load `.env` (if present) into process.env, then validate it. */
export function loadConfig(): AppConfig {
  try {
    // Native since Node 20.12 — no dotenv dependency needed.
    process.loadEnvFile();
  } catch (err) {
    // A missing .env file is fine (defaults + real env vars apply).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return parseConfig(process.env);
}

/** True when the host only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
