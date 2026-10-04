/**
 * Character editor API: create / edit / delete / import / export cards, and
 * the reference face (upload with consent, or generated portraits).
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { extractCardJsonFromPng, parseCardObject } from '../../characters/cardLoader.js';
import type { CharacterRepository } from '../../characters/characterRepository.js';
import type { CharacterService } from '../../characters/characterService.js';
import type { FaceStore } from '../../characters/faceStore.js';
import { CharacterInputSchema, toInput, type Character } from '../../characters/schema.js';
import { ImageUnavailableError, type ImageService } from '../../images/imageService.js';
import { detectImageType, sanitizeImage } from '../../images/imageSanitizer.js';

export interface CharacterRoutesDeps {
  characters: CharacterRepository;
  characterService: CharacterService;
  faces: FaceStore;
  images?: ImageService | undefined;
}

const CharacterId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const IdParams = z.object({ id: CharacterId });
const CandidateParams = z.object({ id: CharacterId, candidateId: z.string().uuid() });

/** Header the editor must send with a face upload: the user's explicit attestation. */
export const CONSENT_HEADER = 'x-girllm-consent';
export const CONSENT_VALUE = 'adult-and-consenting';

/** Card imports: same cap as the card loader. */
const MAX_CARD_BYTES = 20 * 1024 * 1024;
/** Face uploads: the sanitizer refuses anything above 10 MB anyway. */
const MAX_FACE_BYTES = 10 * 1024 * 1024;
/** Portrait candidates generated per request, and how long they are kept. */
const PORTRAIT_COUNT = 4;
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
    hasFace: faces.get(c.id) !== undefined,
  });

  // ---- Cards ---------------------------------------------------------------

  app.get('/api/characters/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const c = requireCharacter(id);
    return { ...summary(c), card: toInput(c) };
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

  // ---- Reference face ------------------------------------------------------

  app.get('/api/characters/:id/face', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    requireCharacter(id);
    const face = faces.get(id);
    if (!face) throw new NotFoundHttpError('No face for this character');
    return reply
      .header('Content-Type', MIME[face.type])
      .header('Cache-Control', 'no-cache')
      .send(await readFile(face.path));
  });

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

  app.delete('/api/characters/:id/face', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    requireCharacter(id);
    await faces.remove(id);
    return reply.code(204).send();
  });

  /** Generate portrait candidates from the (saved) appearance. Long request. */
  app.post('/api/characters/:id/face/candidates', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const c = requireCharacter(id);
    if (!deps.images) throw new ImageUnavailableError('Photos are disabled (IMAGES_ENABLED=false)');
    await faces.cleanupCandidates(CANDIDATE_TTL_MS);
    // Closing the editor (or the tab) cancels the generation.
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort(new Error('client disconnected'));
    };
    reply.raw.on('close', onClose);
    try {
      const pngs = await deps.images.generatePortraits(c.appearance, PORTRAIT_COUNT, controller.signal);
      const candidates = await Promise.all(pngs.map((png) => faces.addCandidate(png)));
      return { candidates };
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.get('/api/characters/:id/face/candidates/:candidateId', async (request, reply) => {
    const { candidateId } = CandidateParams.parse(request.params);
    const path = faces.candidatePath(candidateId);
    if (!path) throw new NotFoundHttpError('Candidate expired');
    return reply.header('Content-Type', 'image/png').send(await readFile(path));
  });

  /** Pick a generated candidate as the face (no consent needed: it's AI-generated). */
  app.post('/api/characters/:id/face/candidates/:candidateId', async (request, reply) => {
    const { id, candidateId } = CandidateParams.parse(request.params);
    requireCharacter(id);
    if (!(await faces.promote(id, candidateId))) throw new NotFoundHttpError('Candidate expired');
    return reply.code(204).send();
  });
}
