/**
 * Settings that can be changed from the app while it runs.
 *
 * `.env` provides the defaults; values saved from the settings panel
 * override them (stored in SQLite). Anything that needs a restart (port,
 * context size, folders, providers) stays in `.env` only.
 */
import { z } from 'zod';
import type { AppConfig } from '../config.js';
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
  };
}
