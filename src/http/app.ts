/**
 * HTTP layer (Fastify): JSON API + static front-end.
 *
 * Security notes — the API has no authentication by design (single local
 * user), so it relies on:
 *   - binding to 127.0.0.1 (see config);
 *   - a Host-header allow-list to defeat DNS-rebinding attacks;
 *   - an Origin check so a website open in your browser cannot drive the
 *     API with cross-site requests;
 *   - strict input validation (zod) and small body limits;
 *   - helmet security headers incl. a strict Content-Security-Policy.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z, ZodError } from 'zod';
import type { CharacterRepository } from '../characters/characterRepository.js';
import { toSummary } from '../characters/schema.js';
import {
  type ChatEvent,
  type ChatService,
  NotFoundError,
  SessionBusyError,
  type ReplyResult,
} from '../chat/chatService.js';
import type { Session } from '../chat/sessionStore.js';
import type { MemoryService } from '../memory/memoryService.js';
import { ComfyError } from '../images/comfyClient.js';
import { ImageUnavailableError, type ImageService } from '../images/imageService.js';
import { ImageRefusedError } from '../images/safety.js';
import { MEMORY_CATEGORIES, type Memory, type MemoryStore } from '../memory/memoryStore.js';
import { LlmHttpError, type LlmProvider } from '../llm/types.js';
import { PromptTooLargeError } from '../prompt/promptBuilder.js';
import { streamSse } from './sse.js';
import { registerSettingsRoutes } from './routes/settingsRoutes.js';
import { registerCharacterRoutes } from './routes/characterRoutes.js';
import { CharacterRejectedError } from '../characters/characterRepository.js';
import type { CharacterService } from '../characters/characterService.js';
import type { FaceStore } from '../characters/faceStore.js';
import { InvalidImageError } from '../images/imageSanitizer.js';
import { SettingsValidationError, type SettingsService } from '../settings/settingsService.js';
import { resolve, type Live } from '../util/resolve.js';
import { cleanTranscript } from '../voice/speechText.js';
import { MAX_SPEECH_CHARS } from '../voice/speechService.js';
import { VoiceUnavailableError, type VoiceServices, type VoiceStatus } from '../voice/types.js';
import { VoiceRefusedError } from '../voice/voiceSafety.js';
import { withClientAbort } from './clientAbort.js';
import type { VoiceStore } from '../voice/voiceStore.js';
import { decodeFloat32 } from '../voice/wav.js';

export interface AppDeps {
  chat: ChatService;
  characters: CharacterRepository;
  llm: LlmProvider;
  /** Undefined when MEMORY_ENABLED=false. */
  memory?: MemoryService | undefined;
  memoryStore: MemoryStore;
  /** Undefined when VOICE_ENABLED=false. */
  voice?: VoiceServices | undefined;
  /** Undefined when IMAGES_ENABLED=false. */
  images?: ImageService | undefined;
  /** Character editor (optional so tests can build a minimal app). */
  characterService?: CharacterService | undefined;
  /** Reference faces (data/faces). */
  faces?: FaceStore | undefined;
  /** Chat backgrounds (data/backgrounds). */
  backgrounds?: FaceStore | undefined;
  /** Live settings (optional so tests can build a minimal app). */
  settings?: SettingsService | undefined;
  /** Characters' reference voices (data/voices, step 7). */
  voices?: VoiceStore | undefined;
  /** Hosts allowed in the Host/Origin headers, e.g. ["127.0.0.1:3210"]. */
  allowedHosts: string[];
  /** Fixed name, or a function returning the current one (live settings). */
  userName: Live<string>;
  logger?: FastifyServerOptions['logger'];
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
/**
 * The UI typeface (Bricolage Grotesque, SIL OFL), served from the npm
 * package so no font binary lives in the repo and nothing is fetched from
 * a CDN (the app works offline and the CSP stays 'self'). Same relative
 * path from src/http and dist/http.
 */
const FONT_DIR = fileURLToPath(
  new URL('../../node_modules/@fontsource-variable/bricolage-grotesque/files/', import.meta.url),
);

// ---- Input schemas -------------------------------------------------------
const CharacterId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const SessionParams = z.object({ id: z.string().uuid() });
const CharacterParams = z.object({ id: CharacterId });
const MemoryParams = z.object({ id: z.string().uuid() });
const CreateSessionBody = z.object({ characterId: CharacterId });
const PhotoBody = z.object({ request: z.string().trim().max(300).default('') });
const ImageParams = z.object({ id: z.string().uuid() });
const RetakeParams = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });

const TtsBody = z.object({
  /** Longer than what is spoken: prepareSpeech cuts it at a sentence end (her replies can be long). */
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SPEECH_CHARS * 4),
  /** Whose voice: every character has her own (made automatically if needed). */
  characterId: CharacterId,
});

/** Audio uploads: 16 kHz mono float32 = 64 KB/s, so 4 MB ≈ 60 s. */
const STT_SAMPLE_RATE = 16000;
const MAX_STT_BYTES = 4 * 1024 * 1024;
const MIN_STT_SECONDS = 0.3;

const CreateMemoryBody = z.object({
  category: z.enum(MEMORY_CATEGORIES).default('user'),
  content: z.string().trim().min(3).max(300),
});
const SendMessageBody = z.object({ text: z.string().trim().min(1).max(8000) });
const InitiateBody = z.object({ reason: z.enum(['opening', 'nudge']) });

/** Client view of a session (internal fields stripped). */
function publicSession(s: Session) {
  return {
    id: s.id,
    characterId: s.characterId,
    title: s.title,
    createdAt: s.createdAt,
    summary: s.summary,
    mood: s.mood,
    messages: s.messages.map(({ id, role, content, imageId, kind, createdAt }) => ({
      id,
      role,
      content,
      imageId,
      kind,
      createdAt,
    })),
  };
}

function publicMemory(m: Memory) {
  return { id: m.id, category: m.category, content: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt };
}

/** Map domain errors to HTTP status codes + safe messages. */
function httpError(err: unknown): { status: number; message: string } {
  if (err instanceof ZodError)
    return { status: 400, message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (err instanceof NotFoundError) return { status: 404, message: err.message };
  if (err instanceof SessionBusyError) return { status: 409, message: err.message };
  if (err instanceof PromptTooLargeError) return { status: 413, message: err.message };
  if (err instanceof SettingsValidationError) return { status: 400, message: err.message };
  if (err instanceof CharacterRejectedError) return { status: 422, message: err.message };
  if (err instanceof InvalidImageError) return { status: 400, message: err.message };
  if (err instanceof VoiceUnavailableError) return { status: 503, message: err.message };
  if (err instanceof ImageUnavailableError) return { status: 503, message: err.message };
  if (err instanceof ImageRefusedError) return { status: 422, message: err.message };
  if (err instanceof VoiceRefusedError) return { status: 422, message: err.message };
  if (err instanceof ComfyError) return { status: 502, message: err.message };
  if (err instanceof LlmHttpError)
    return { status: 502, message: 'The LLM backend rejected the request (is the model pulled?)' };
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return { status: 502, message: 'Cannot reach the LLM backend. Is Ollama running?' };
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) return { status, message: (err as Error).message };
  return { status: 500, message: 'Internal error' }; // never leak internals
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 64 * 1024, // chat messages are small; refuse big payloads early
  });

  const allowedHosts = new Set(deps.allowedHosts.map((h) => h.toLowerCase()));

  // DNS-rebinding + cross-site protection, before any route runs.
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return reply.code(421).send({ error: 'Host not allowed' });
    }
    const origin = request.headers.origin;
    if (origin && origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        /* invalid Origin -> rejected below */
      }
      if (!allowedHosts.has(originHost)) {
        return reply.code(403).send({ error: 'Cross-origin request refused' });
      }
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        // Spoken replies are played from blob: URLs created by the page.
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  app.setErrorHandler((err, request, reply) => {
    const { status, message } = httpError(err);
    if (status >= 500) request.log.error({ err }, 'request failed');
    void reply.code(status).send({ error: message });
  });

  // Raw uploads: audio for /api/stt (4 MB, the default here), card files and
  // face images (their routes raise the limit with a route-level bodyLimit,
  // which takes precedence). JSON routes keep the 64 KB limit.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_STT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  if (existsSync(FONT_DIR)) {
    await app.register(fastifyStatic, {
      root: FONT_DIR,
      prefix: '/fonts/',
      decorateReply: false, // already decorated by the first registration
      allowedPath: (path) => path.endsWith('.woff2'),
      maxAge: '30d',
    });
  }

  // ---- Routes ------------------------------------------------------------

  app.get('/api/health', async () => {
    const llm = await deps.llm.ping();
    return { status: llm.ok ? 'ok' : 'degraded', llm };
  });

  app.get('/api/config', async () => ({
    userName: resolve(deps.userName),
    memoryEnabled: Boolean(deps.memory),
    // The page uses it to decide when to ask "may she write first?" (the server still decides).
    proactiveAfterMinutes: deps.settings?.get().proactiveAfterMinutes ?? 0,
    chatBackground: deps.settings?.get().chatBackground ?? 'subtle',
  }));

  if (deps.settings) {
    registerSettingsRoutes(app, {
      settings: deps.settings,
      llm: deps.llm,
      images: deps.images,
    });
  }

  app.get('/api/characters', async () =>
    deps.characters.list().map((c) => ({
      ...toSummary(c),
      style: c.style,
      artStyle: c.artStyle,
      gender: c.gender,
      background: c.backgroundMode,
      hasFace: deps.faces?.get(c.id) !== undefined,
      hasBackground: deps.backgrounds?.get(c.id) !== undefined,
    })),
  );

  if (deps.characterService && deps.faces) {
    registerCharacterRoutes(app, {
      characters: deps.characters,
      characterService: deps.characterService,
      faces: deps.faces,
      backgrounds: deps.backgrounds,
      images: deps.images,
      voices: deps.voices,
      tts: deps.voice?.tts,
    });
  }

  app.post('/api/sessions', async (request, reply) => {
    const { characterId } = CreateSessionBody.parse(request.body);
    const { session, character } = deps.chat.createSession(characterId);
    return reply.code(201).send({ session: publicSession(session), character: toSummary(character) });
  });

  app.get('/api/sessions/:id', async (request) => {
    const { id } = SessionParams.parse(request.params);
    const { session, character } = deps.chat.getSession(id);
    return { session: publicSession(session), character: toSummary(character) };
  });

  app.get('/api/characters/:id/sessions', async (request) => {
    const { id } = CharacterParams.parse(request.params);
    return deps.chat.listSessions(id);
  });

  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    deps.chat.deleteSession(id);
    return reply.code(204).send();
  });

  // ---- Long-term memories (per character) -----------------------------------

  /** Shared guard: 404 for unknown characters. */
  const requireCharacter = (id: string) => {
    if (!deps.characters.get(id)) throw new NotFoundError('Character');
  };

  app.get('/api/characters/:id/memories', async (request) => {
    const { id } = CharacterParams.parse(request.params);
    requireCharacter(id);
    return deps.memoryStore.list(id).map(publicMemory);
  });

  app.post('/api/characters/:id/memories', async (request, reply) => {
    const { id } = CharacterParams.parse(request.params);
    const { category, content } = CreateMemoryBody.parse(request.body);
    requireCharacter(id);
    // With the memory service: embedded + de-duplicated. Without: plain insert.
    const memory = deps.memory
      ? await deps.memory.remember(id, category, content)
      : deps.memoryStore.add({ characterId: id, category, content });
    if (!memory) return reply.code(409).send({ error: 'A very similar memory already exists' });
    return reply.code(201).send(publicMemory(memory));
  });

  app.delete('/api/memories/:id', async (request, reply) => {
    const { id } = MemoryParams.parse(request.params);
    if (!deps.memoryStore.delete(id)) throw new NotFoundError('Memory');
    return reply.code(204).send();
  });

  // ---- Photos (step 4) --------------------------------------------------------

  app.get('/api/images/status', async () =>
    deps.images ? deps.images.status() : { available: false, reason: 'disabled (IMAGES_ENABLED=false)' },
  );

  /**
   * She sends a photo. Long request (LLM + ComfyUI, typically 20-60 s);
   * aborted if the browser disconnects. Returns the new message.
   */
  app.post('/api/sessions/:id/photo', async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const { request: photoRequest } = PhotoBody.parse(request.body ?? {});
    if (!deps.images) throw new ImageUnavailableError('Image generation is disabled');

    // The response closing before we answered = the user cancelled.
    const message = await withClientAbort(reply, (signal) => deps.chat.sendPhoto(id, photoRequest, signal));
    const { id: messageId, role, content, imageId, createdAt } = message;
    return { message: { id: messageId, role, content, imageId, createdAt } };
  });

  /**
   * Retake one of her photos: same scene, new seed (step 6). Long request
   * like /photo; aborted if the browser disconnects. Returns the message with
   * its new image id.
   */
  app.post('/api/sessions/:id/images/:imageId/retake', async (request, reply) => {
    const { id, imageId } = RetakeParams.parse(request.params);
    if (!deps.images) throw new ImageUnavailableError('Image generation is disabled');
    const message = await withClientAbort(reply, (signal) => deps.chat.retakePhoto(id, imageId, signal));
    const { id: messageId, role, content, createdAt } = message;
    return { message: { id: messageId, role, content, imageId: message.imageId, createdAt } };
  });

  /** Serve a generated image. The path comes from the DB, never from the URL. */
  app.get('/api/images/:id', async (request, reply) => {
    const { id } = ImageParams.parse(request.params);
    const image = deps.images?.get(id);
    if (!image) throw new NotFoundError('Image');
    const data = await readFile(deps.images!.filePath(image)).catch(() => undefined);
    if (!data) throw new NotFoundError('Image file');
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'private, max-age=31536000, immutable') // ids are never reused
      .send(data);
  });

  // ---- Voice -----------------------------------------------------------------

  const voiceDisabled = { available: false, model: '', reason: 'disabled (VOICE_ENABLED=false)' };

  app.get('/api/voice', async (): Promise<VoiceStatus> => ({
    stt: deps.voice ? deps.voice.stt.status() : voiceDisabled,
    tts: deps.voice ? await deps.voice.tts.status() : voiceDisabled,
  }));

  /** Body: little-endian float32 mono PCM at 16 kHz. Returns { text }. */
  app.post('/api/stt', async (request) => {
    if (!deps.voice) throw new VoiceUnavailableError('Voice is disabled');
    if (!Buffer.isBuffer(request.body)) {
      throw Object.assign(new Error('Expected application/octet-stream audio'), { statusCode: 415 });
    }
    if (request.body.byteLength % 4 !== 0) {
      throw Object.assign(new Error('Audio must be float32 samples'), { statusCode: 400 });
    }
    const samples = decodeFloat32(request.body);
    if (samples.length < STT_SAMPLE_RATE * MIN_STT_SECONDS) return { text: '' }; // just a click
    const text = await deps.voice.stt.transcribe({ samples, sampleRate: STT_SAMPLE_RATE });
    return { text: cleanTranscript(text) };
  });

  /**
   * Body: { text, characterId }. Returns her voice saying it, as FLAC (or 204
   * if nothing is speakable). Long request: the GPU is swapped to Qwen3-TTS
   * (~10–30 s), or instant when this text was already spoken (cache). Closing
   * the page cancels it.
   */
  app.post('/api/tts', async (request, reply) => {
    if (!deps.voice) throw new VoiceUnavailableError('Voice is disabled');
    const body = TtsBody.parse(request.body);
    const flac = await withClientAbort(reply, (signal) => deps.voice!.tts.speak(body.characterId, body.text, signal));
    if (!flac) return reply.code(204).send();
    return reply.header('Content-Type', 'audio/flac').header('Cache-Control', 'no-store').send(flac);
  });

  /** Shared SSE handler for "send message", "regenerate" and "she writes first". */
  const streamReply = (
    request: Parameters<typeof streamSse>[0],
    reply: Parameters<typeof streamSse>[1],
    run: (onToken: (t: string) => void, signal: AbortSignal, onEvent: (e: ChatEvent) => void) => Promise<ReplyResult>,
  ) =>
    streamSse(
      request,
      reply,
      async (send, signal) => {
        await run(
          (text) => {
            send('token', { text });
          },
          signal,
          (e) => {
            // "done" comes as soon as the text is complete; a photo may follow.
            if (e.type === 'done') {
              send('done', {
                messageId: e.result.message?.id ?? null,
                aborted: e.result.aborted,
                estimatedPromptTokens: e.result.estimatedTokens,
                droppedMessages: e.result.droppedMessages,
              });
            } else if (e.type === 'photo') {
              send('photo', { messageId: e.messageId, imageId: e.imageId });
            } else if (e.type === 'photo_error') {
              send('photo_error', { message: httpError(e.error).message });
            } else {
              send('photo_start', {});
            }
          },
        );
      },
      (err) => httpError(err).message,
    );

  app.post('/api/sessions/:id/messages', async (request, reply) => {
    // Validate BEFORE switching to SSE so bad input gets a normal 400.
    const { id } = SessionParams.parse(request.params);
    const { text } = SendMessageBody.parse(request.body);
    deps.chat.getSession(id); // 404 early
    await streamReply(request, reply, (onToken, signal, onEvent) =>
      deps.chat.sendMessage(id, text, onToken, signal, onEvent),
    );
  });

  app.post('/api/sessions/:id/regenerate', async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    deps.chat.getSession(id);
    await streamReply(request, reply, (onToken, signal, onEvent) => deps.chat.regenerate(id, onToken, signal, onEvent));
  });

  /**
   * She writes first: the opening of a chat without a fixed greeting, or a
   * message after a silence. 204 when it isn't the moment (the server
   * decides, the page only asks).
   */
  app.post('/api/sessions/:id/initiate', async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const { reason } = InitiateBody.parse(request.body);
    if (!deps.chat.canInitiate(id, reason)) return reply.code(204).send();
    await streamReply(request, reply, (onToken, signal, onEvent) =>
      deps.chat.initiate(id, reason, onToken, signal, onEvent),
    );
  });

  return app;
}
