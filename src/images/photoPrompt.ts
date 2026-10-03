/**
 * Asks the chat model to imagine the "photo" the character sends: a caption
 * (what she says, in the chat language) and a scene description for the
 * image model (English tags, which SDXL understands best).
 */
import { z } from 'zod';
import type { Character } from '../characters/schema.js';
import type { StoredMessage } from '../chat/sessionStore.js';
import { complete } from '../llm/complete.js';
import type { LlmProvider } from '../llm/types.js';
import { formatTranscript } from '../memory/transcript.js';
import { formatNow } from '../prompt/timeContext.js';

export interface PhotoIdea {
  caption: string;
  scene: string;
}

export interface PhotoPromptInput {
  character: Character;
  userName: string;
  /** Recent messages, oldest first (gives the scene context). */
  recent: readonly StoredMessage[];
  summary: string;
  /** What the user asked for ("a selfie at the gym"), may be empty. */
  request: string;
  language?: string | undefined;
  /** Current moment, so light and setting match the time of day. */
  now?: Date | undefined;
  timeZone?: string | undefined;
}

const MAX_CAPTION_CHARS = 300;
const MAX_SCENE_CHARS = 600;
/** Messages of context given to the model. */
const CONTEXT_MESSAGES = 6;

const IdeaSchema = z.object({
  caption: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CAPTION_CHARS * 2),
  scene: z
    .string()
    .trim()
    .min(3)
    .max(MAX_SCENE_CHARS * 2),
});

export function buildPhotoPrompt(input: PhotoPromptInput) {
  const { character: c, userName: user } = input;
  const language = input.language ?? 'the language of the conversation';
  const looks = c.appearance
    ? 'Their face, hair and body are described separately: do NOT describe them.'
    : `Include their physical appearance (gender, hair, eyes, build) based on this description: ${c.description.slice(0, 1500)}`;
  return [
    {
      role: 'system' as const,
      content: [
        `${c.name} (an adult) is chatting with ${user} and is about to send a photo of themselves.`,
        'Return ONLY a JSON object: {"caption": "...", "scene": "..."}.',
        `"caption": the short message ${c.name} writes with the photo, in their own voice, written in ${language}. One or two sentences; it may start with an *action*.`,
        '"scene": the photo for an image generator, in ENGLISH, as 12-30 comma-separated tags, in this order:',
        '  shot type (close-up selfie, mirror selfie, waist-up photo taken by a friend…), camera angle,',
        '  pose and expression, outfit, location with two or three concrete details, light source, time of day.',
        looks,
        'The light and setting MUST match the current time of day. Only one person in the photo.',
        'Make it consistent with the conversation, her life and the request: a natural, everyday photo between partners,',
        'not a studio shoot.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        input.now ? `Current time: ${formatNow(input.now, 'en-GB', input.timeZone)}` : '',
        input.summary ? `Story so far:\n${input.summary}` : '',
        `Recent messages:\n${formatTranscript(input.recent.slice(-CONTEXT_MESSAGES), c.name, user) || '(none)'}`,
        `Photo request from ${user}: ${input.request || `(none — ${c.name} decides, based on the moment)`}`,
        'JSON:',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

/** Tolerant parsing (JSON inside prose or ``` fences). */
export function parsePhotoIdea(raw: string): PhotoIdea | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = IdeaSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    if (!parsed.success) return undefined;
    return {
      caption: parsed.data.caption.slice(0, MAX_CAPTION_CHARS),
      scene: parsed.data.scene.replace(/\s+/g, ' ').slice(0, MAX_SCENE_CHARS),
    };
  } catch {
    return undefined;
  }
}

export async function writePhotoIdea(llm: LlmProvider, input: PhotoPromptInput): Promise<PhotoIdea> {
  const raw = await complete(llm, buildPhotoPrompt(input), { maxTokens: 300, temperature: 0.8, topP: 0.95 });
  const idea = parsePhotoIdea(raw);
  if (idea) return idea;
  // Fallback: still produce a photo rather than failing the request.
  return { caption: '📷', scene: input.request || 'casual selfie, smiling, cozy room, soft natural light' };
}
