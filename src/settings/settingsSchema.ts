/**
 * Settings that can be changed from the app while it runs.
 *
 * `.env` provides the defaults; values saved from the settings panel
 * override them (stored in SQLite). Anything that needs a restart (port,
 * context size, folders, providers) stays in `.env` only.
 */
import { z } from 'zod';
import { CHAT_BACKGROUNDS, PHOTO_FREQUENCIES, type AppConfig } from '../config.js';
import { TTS_VOICE_IDS, type TtsVoiceId } from '../voice/catalog.js';

/** Safe identifiers for model / checkpoint / sampler names (no quotes, no shell chars). */
const modelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@-]+$/, 'letters, digits and . : / @ - _ only');
const fileName = z
  .string()
  .trim()
  .max(255)
  .regex(/^[\w .()/\\-]*$/, 'invalid file name');
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _ only');

export const SettingsSchema = z.object({
  // --- Conversation
  userName: z.string().trim().min(1).max(64),
  /** "" = not forced. */
  replyLanguage: z
    .string()
    .trim()
    .max(40)
    .regex(/^[\p{L} ()-]*$/u, 'letters only'),
  llmModel: modelName,
  temperature: z.number().min(0).max(2),
  topP: z.number().gt(0).max(1),
  minP: z.number().min(0).max(1),
  repeatPenalty: z.number().min(0.5).max(2),
  maxReplyTokens: z.number().int().min(16).max(2048),
  /** Minutes of silence before she writes first; 0 = never. */
  proactiveAfterMinutes: z.number().int().min(0).max(10_080),
  // --- Voice
  ttsVoice: z.enum(TTS_VOICE_IDS),
  ttsSpeed: z.number().min(0.5).max(2),
  /** "" = auto-detect. */
  sttLanguage: z.string().regex(/^([a-z]{2})?$/, 'two-letter code like fr, or empty'),
  // --- Photos
  /** "" = photos unavailable. */
  imageCheckpoint: fileName,
  imageStyle: z.string().trim().max(500),
  imageNegative: z.string().trim().max(1000),
  imageSteps: z.number().int().min(1).max(100),
  imageCfg: z.number().min(1).max(20),
  imageSampler: identifier,
  imageScheduler: identifier,
  imageHiresScale: z.number().min(1).max(2),
  imageHiresDenoise: z.number().min(0.1).max(0.7),
  imageHiresSteps: z.number().int().min(4).max(60),
  /** Reference face strength (IP-Adapter); 0 = off. */
  imageFaceWeight: z.number().min(0).max(1),
  /** Photos she sends on her own. */
  photoFrequency: z.enum(PHOTO_FREQUENCIES),
  // --- Anime characters (their own image model)
  /** "" = no anime photos. */
  animeCheckpoint: fileName,
  animeStyle: z.string().trim().max(500),
  animeNegative: z.string().trim().max(1000),
  animeSteps: z.number().int().min(1).max(100),
  animeCfg: z.number().min(1).max(20),
  animeSampler: identifier,
  animeScheduler: identifier,
  animeHiresScale: z.number().min(1).max(2),
  animeFaceWeight: z.number().min(0).max(1),
  // --- Interface
  /** Her picture behind the chat. */
  chatBackground: z.enum(CHAT_BACKGROUNDS),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as SettingKey[];

/** A partial update: unknown keys are rejected (typos must not be silently ignored). */
export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Defaults = the values from `.env` (or their built-in defaults). */
export function defaultsFromConfig(config: AppConfig): Settings {
  const g = config.generation;
  const i = config.images;
  return {
    userName: config.userName,
    replyLanguage: config.replyLanguage ?? '',
    llmModel: config.llm.model,
    temperature: g.temperature,
    topP: g.topP,
    minP: g.minP,
    repeatPenalty: g.repeatPenalty,
    maxReplyTokens: g.maxReplyTokens,
    proactiveAfterMinutes: config.proactiveAfterMinutes,
    ttsVoice: config.voice.ttsVoice satisfies TtsVoiceId,
    ttsSpeed: config.voice.ttsSpeed,
    sttLanguage: config.voice.sttLanguage,
    imageCheckpoint: i.checkpoint ?? '',
    imageStyle: i.style,
    imageNegative: i.negative,
    imageSteps: i.steps,
    imageCfg: i.cfg,
    imageSampler: i.sampler,
    imageScheduler: i.scheduler,
    imageHiresScale: i.hires.scale,
    imageHiresDenoise: i.hires.denoise,
    imageHiresSteps: i.hires.steps,
    imageFaceWeight: i.faceWeight,
    photoFrequency: i.photoFrequency,
    animeCheckpoint: i.anime.checkpoint ?? '',
    animeStyle: i.anime.style,
    animeNegative: i.anime.negative,
    animeSteps: i.anime.steps,
    animeCfg: i.anime.cfg,
    animeSampler: i.anime.sampler,
    animeScheduler: i.anime.scheduler,
    animeHiresScale: i.anime.hiresScale,
    animeFaceWeight: i.anime.faceWeight,
    chatBackground: config.chatBackground,
  };
}
