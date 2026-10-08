/**
 * Character editor API: create / edit / delete / import / export cards, and
 * the character's pictures:
 *   - face: reference portrait (generated candidates, or upload with consent);
 *   - background: the scene shown behind the chat (generated candidates);
 *   - voice: her reference voice clip (step 7), designed from a description
 *     (candidates the user listens to, then keeps).
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { extractCardJsonFromPng, parseCardObject } from '../../characters/cardLoader.js';
import type { CharacterRepository } from '../../characters/characterRepository.js';
import type { CharacterService } from '../../characters/characterService.js';
import type { FaceStore } from '../../characters/faceStore.js';
import { CharacterInputSchema, toInput, type Character } from '../../characters/schema.js';
import { ImageUnavailableError, type ImageService } from '../../images/imageService.js';
import { detectImageType, sanitizeImage } from '../../images/imageSanitizer.js';
import { MAX_VOICE_DESCRIPTION_CHARS } from '../../characters/schema.js';
import { VoiceUnavailableError, type TextToSpeech } from '../../voice/types.js';
import { audioContentType, type VoiceStore } from '../../voice/voiceStore.js';
import { decodeFloat32 } from '../../voice/wav.js';
import { withClientAbort } from '../clientAbort.js';

export interface CharacterRoutesDeps {
  characters: CharacterRepository;
  characterService: CharacterService;
  faces: FaceStore;
  /** Chat backgrounds (same store type as faces, another folder). */
  backgrounds?: FaceStore | undefined;
  images?: ImageService | undefined;
  /** Reference voices (step 7) and the engine that designs them; absent when voice is off. */
  voices?: VoiceStore | undefined;
  tts?: TextToSpeech | undefined;
}

const CharacterId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const IdParams = z.object({ id: CharacterId });
const CandidateParams = z.object({ id: CharacterId, candidateId: z.string().uuid() });
const VoiceDesignBody = z.object({ description: z.string().trim().min(1).max(MAX_VOICE_DESCRIPTION_CHARS) });
const VoiceClipQuery = z.object({
  rate: z.coerce.number().int(),
  source: z.enum(['recorded', 'uploaded']),
});

/**
 * Header the editor must send with a recorded or uploaded voice (step 7b):
 * the user's attestation that it is their own voice, or that of an adult who
 * agreed to it being used here.
 */
export const VOICE_CONSENT_VALUE = 'own-voice-or-consenting-adult';
/** Voice clips: float32 mono, up to 40 s at 48 kHz (~7.7 MB). */
const MAX_VOICE_CLIP_BYTES = 8 * 1024 * 1024;

/** Header the editor must send with a face upload: the user's explicit attestation. */
export const CONSENT_HEADER = 'x-girllm-consent';
export const CONSENT_VALUE = 'adult-and-consenting';

/** Card imports: same cap as the card loader. */
const MAX_CARD_BYTES = 20 * 1024 * 1024;
/** Face uploads: the sanitizer refuses anything above 10 MB anyway. */
const MAX_FACE_BYTES = 10 * 1024 * 1024;
/** Candidates generated per request (portraits are cheaper than wide scenes), and how long they are kept. */
const PORTRAIT_COUNT = 4;
const BACKGROUND_COUNT = 2;
const CANDIDATE_TTL_MS = 60 * 60 * 1000;

const MIME = { png: 'image/png', jpeg: 'image/jpeg' } as const;

export class NotFoundHttpError extends Error {
  readonly statusCode = 404;
}

function badRequest(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function registerCharacterRoutes(app: FastifyInstance, deps: CharacterRoutesDeps): void {
  const { characters, faces } = deps;

  const requireCharacter = (id: string): Character => {
    const c = characters.get(id);
    if (!c) throw new NotFoundHttpError('Character not found');
    return c;
  };
  const summary = (c: Character) => ({
    id: c.id,
    name: c.name,
    creatorNotes: c.creator_notes,
    tags: c.tags,
    style: c.style,
    artStyle: c.artStyle,
    gender: c.gender,
    background: c.backgroundMode,
    hasFace: faces.get(c.id) !== undefined,
    hasBackground: deps.backgrounds?.get(c.id) !== undefined,
  });

  // ---- Cards ---------------------------------------------------------------

  app.get('/api/characters/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const c = requireCharacter(id);
    const voice = await deps.voices?.get(id);
    return {
      ...summary(c),
      card: toInput(c),
      // Her current voice clip (the editor plays /api/characters/:id/voice), or null.
      voice: voice ? { description: voice.info.description, createdAt: voice.info.createdAt } : null,
    };
  });

  app.post('/api/characters', async (request, reply) => {
    const input = CharacterInputSchema.parse(request.body);
    const c = await characters.save(input);
    return reply.code(201).send(summary(c));
  });

  app.put('/api/characters/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    requireCharacter(id);
    const c = await characters.save(CharacterInputSchema.parse(request.body), id);
    return summary(c);
  });

  /** Deletes the card AND its chats, photos, memories and face. */
  app.delete('/api/characters/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const result = await deps.characterService.remove(id);
    if (!result) throw new NotFoundHttpError('Character not found');
    return { deleted: true, ...result };
  });

  /** Import a SillyTavern-style card: raw .json or .png bytes. */
  app.post('/api/characters/import', { bodyLimit: MAX_CARD_BYTES }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw badRequest('Send the card file as application/octet-stream', 415);
    if (request.body.length > MAX_CARD_BYTES) throw badRequest('Card file too large (max 20 MB)', 413);
    let json: string;
    if (detectImageType(request.body) === 'png') {
      try {
        json = extractCardJsonFromPng(request.body);
      } catch (err) {
        throw badRequest(`Not a character card: ${(err as Error).message}`);
      }
    } else {
      json = request.body.toString('utf8');
    }
    let fields;
    try {
      fields = parseCardObject(JSON.parse(json));
    } catch (err) {
      throw badRequest(`Invalid character card: ${(err as Error).message}`);
    }
    const c = await characters.import(fields);
    return reply.code(201).send(summary(c));
  });

  /** Download the card (Character Card V2 JSON, SillyTavern-compatible). */
  app.get('/api/characters/:id/export', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const card = characters.exportCard(id);
    if (!card) throw new NotFoundHttpError('Character not found');
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${id}.json"`)
      .send(JSON.stringify(card, null, 2));
  });

  // ---- Pictures: reference face and chat background -------------------------

  /**
   * GET / DELETE the picture, POST …/candidates to generate some (long
   * request, cancelled if the client goes away), GET a candidate's preview,
   * POST a candidate to make it the picture.
   */
  const registerPicture = (
    kind: 'face' | 'background',
    store: FaceStore,
    generate: (images: ImageService, c: Character, signal: AbortSignal) => Promise<Buffer[]>,
  ) => {
    const base = `/api/characters/:id/${kind}`;

    app.get(base, async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      const file = store.get(id);
      if (!file) throw new NotFoundHttpError(`No ${kind} for this character`);
      return reply
        .header('Content-Type', MIME[file.type])
        .header('Cache-Control', 'no-cache')
        .send(await readFile(file.path));
    });

    app.delete(base, async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      await store.remove(id);
      return reply.code(204).send();
    });

    app.post(`${base}/candidates`, async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      const c = requireCharacter(id);
      if (!deps.images) throw new ImageUnavailableError('Photos are disabled (IMAGES_ENABLED=false)');
      await store.cleanupCandidates(CANDIDATE_TTL_MS);
      // Closing the editor (or the tab) cancels the generation.
      const pngs = await withClientAbort(reply, (signal) => generate(deps.images!, c, signal));
      const candidates = await Promise.all(pngs.map((png) => store.addCandidate(png)));
      return { candidates };
    });

    app.get(`${base}/candidates/:candidateId`, async (request, reply) => {
      const { candidateId } = CandidateParams.parse(request.params);
      const path = store.candidatePath(candidateId);
      if (!path) throw new NotFoundHttpError('Candidate expired');
      return reply.header('Content-Type', 'image/png').send(await readFile(path));
    });

    /** Pick a generated candidate (no consent needed: it's AI-generated). */
    app.post(`${base}/candidates/:candidateId`, async (request, reply) => {
      const { id, candidateId } = CandidateParams.parse(request.params);
      requireCharacter(id);
      if (!(await store.promote(id, candidateId))) throw new NotFoundHttpError('Candidate expired');
      return reply.code(204).send();
    });
  };

  registerPicture('face', faces, (images, c, signal) =>
    images.generatePortraits(
      { appearance: c.appearance, artStyle: c.artStyle, gender: c.gender },
      PORTRAIT_COUNT,
      signal,
    ),
  );
  if (deps.backgrounds) {
    registerPicture('background', deps.backgrounds, (images, c, signal) =>
      images.generateBackgrounds(c.id, BACKGROUND_COUNT, signal),
    );
  }

  // ---- Voice (step 7) ------------------------------------------------------

  const { voices, tts } = deps;
  if (voices) {
    /** A stored clip (FLAC or WAV: the extension is set by the store, never by the client). */
    const sendClip = async (reply: FastifyReply, path: string) =>
      reply
        .header('Content-Type', audioContentType(path))
        .header('Cache-Control', 'no-cache')
        .send(await readFile(path));

    /** Her reference clip (what her voice sounds like). */
    app.get('/api/characters/:id/voice', async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      const voice = await voices.get(id);
      if (!voice) throw new NotFoundHttpError('No voice for this character yet');
      return sendClip(reply, voice.path);
    });

    /** Forget her voice: a new one is made from her description the next time she speaks. */
    app.delete('/api/characters/:id/voice', async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      await voices.remove(id);
      return reply.code(204).send();
    });

    /** Design a voice from a description (long request: GPU swap, ~10–30 s). */
    app.post('/api/characters/:id/voice/candidates', async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      const { description } = VoiceDesignBody.parse(request.body);
      if (!tts) throw new VoiceUnavailableError('Voice is disabled (VOICE_ENABLED=false)');
      await voices.cleanupCandidates(CANDIDATE_TTL_MS);
      const candidate = await withClientAbort(reply, (signal) => tts.designCandidate(id, description, signal));
      return { candidate };
    });

    app.get('/api/characters/:id/voice/candidates/:candidateId', async (request, reply) => {
      const { candidateId } = CandidateParams.parse(request.params);
      const path = voices.candidatePath(candidateId);
      if (!path) throw new NotFoundHttpError('Candidate expired');
      return sendClip(reply, path);
    });

    /**
     * A real voice for her (step 7b): float32 LE mono PCM recorded with the
     * mic or decoded from a file by the page, `?rate=24000&source=recorded`.
     * Requires the consent header. Returns the candidate and what Whisper
     * heard; the user listens, then keeps it like a designed voice.
     */
    app.put('/api/characters/:id/voice/candidates', { bodyLimit: MAX_VOICE_CLIP_BYTES }, async (request) => {
      const { id } = IdParams.parse(request.params);
      requireCharacter(id);
      if (request.headers[CONSENT_HEADER] !== VOICE_CONSENT_VALUE) {
        throw badRequest('Please confirm it is your own voice, or that of an adult who agreed to it', 428);
      }
      const { rate, source } = VoiceClipQuery.parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw badRequest('Send the audio as application/octet-stream', 415);
      if (request.body.byteLength % 4 !== 0) throw badRequest('Audio must be float32 samples');
      if (!tts) throw new VoiceUnavailableError('Voice is disabled (VOICE_ENABLED=false)');
      await voices.cleanupCandidates(CANDIDATE_TTL_MS);
      return tts.customCandidate(id, {
        samples: decodeFloat32(request.body),
        sampleRate: rate,
        source,
        consentAt: new Date().toISOString(),
      });
    });

    /** Keep a designed voice as hers. */
    app.post('/api/characters/:id/voice/candidates/:candidateId', async (request, reply) => {
      const { id, candidateId } = CandidateParams.parse(request.params);
      requireCharacter(id);
      if (!(await voices.promote(id, candidateId))) throw new NotFoundHttpError('Candidate expired');
      return reply.code(204).send();
    });
  }

  /**
   * Upload a face image. Requires the consent header: the user attests the
   * image is AI-generated, of themselves, or of a consenting ADULT.
   */
  app.put('/api/characters/:id/face', { bodyLimit: MAX_FACE_BYTES }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    requireCharacter(id);
    if (request.headers[CONSENT_HEADER] !== CONSENT_VALUE) {
      throw badRequest('Please confirm the image shows an adult who agreed to it (or is AI-generated)', 428);
    }
    if (!Buffer.isBuffer(request.body)) throw badRequest('Send the image as application/octet-stream', 415);
    let image;
    try {
      image = sanitizeImage(request.body);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    await faces.save(id, image);
    return reply.code(204).send();
  });
}
