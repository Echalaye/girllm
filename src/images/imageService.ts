/**
 * "She sends you a photo": orchestrates the whole image pipeline.
 *
 *  1. safety checks on the card and the request (no minors, ever);
 *  2. the chat model imagines the photo (caption + scene) — normal GPU use;
 *  3. EXCLUSIVE GPU phase: unload the LLM, run ComfyUI, free ComfyUI's VRAM;
 *  4. store the PNG + metadata, add the photo message to the chat.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { resolve, type Live } from '../util/resolve.js';
import type { CharacterRepository } from '../characters/characterRepository.js';
import type { FaceStore } from '../characters/faceStore.js';
import type { FaceParams } from './ipAdapter.js';
import type { SessionStore, StoredMessage } from '../chat/sessionStore.js';
import type { LlmProvider } from '../llm/types.js';
import type { GpuGate } from '../util/gpuGate.js';
import type { ComfyClient } from './comfyClient.js';
import type { ImageStore, StoredImage } from './imageStore.js';
import { writePhotoIdea } from './photoPrompt.js';
import {
  ADULT_POSITIVE_TERMS,
  assertSafe,
  cardStatesMinorAge,
  ImageRefusedError,
  MINOR_NEGATIVE_TERMS,
} from './safety.js';
import { buildTxt2ImgWorkflow, type HiresParams } from './workflow.js';

/** Framing of the reference portraits generated in the character editor. */
export const PORTRAIT_SCENE =
  'head and shoulders portrait, looking at the camera, relaxed slight smile, plain light background, soft diffused light, sharp focus on the face';

/** Marks a user message that is a photo request (shown in the chat as "📷 …"). */
export const PHOTO_REQUEST_PREFIX = '📷 ';

export interface ImageSettings {
  /** Checkpoint file name as listed by ComfyUI; undefined = images unavailable. */
  checkpoint: string | undefined;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** Style tags prepended to every prompt ("photo, realistic…"). */
  style: string;
  negative: string;
  /** Optional second refinement pass (scale <= 1 = off). */
  hires?: HiresParams | undefined;
  /** 0–1: strength of the reference face (IP-Adapter); 0 or undefined = off. */
  faceWeight?: number | undefined;
}

export interface ImageServiceOptions {
  userName: string;
  replyLanguage?: string | undefined;
  imagesDir: string;
  settings: ImageSettings;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

export interface ImageLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export class ImageService {
  private readonly imagesDir: string;

  constructor(
    private readonly sessions: SessionStore,
    private readonly characters: CharacterRepository,
    private readonly images: ImageStore,
    /** Gated provider: waits while an image is being generated. */
    private readonly llm: LlmProvider,
    private readonly comfy: ComfyClient,
    private readonly gate: GpuGate,
    private readonly log: ImageLogger,
    /** Fixed options, or a function returning the current ones (live settings). */
    private readonly options: Live<ImageServiceOptions>,
    /** Reference faces (optional: without it photos use the text prompt only). */
    private readonly faces?: FaceStore,
  ) {
    this.imagesDir = resolvePath(this.opts.imagesDir);
  }

  /** IP-Adapter readiness, cached: asking ComfyUI on every photo is wasteful. */
  private faceSupportCache: { at: number; value: { ready: boolean; reason?: string } } | undefined;
  /** Reference faces already uploaded to ComfyUI: our name → name to use in LoadImage. */
  private readonly uploadedFaces = new Map<string, string>();

  /** Can the reference face be applied right now? (cached for a minute) */
  async faceSupport(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.faceSupportCache && now - this.faceSupportCache.at < 60_000) return this.faceSupportCache.value;
    const value = await this.comfy.faceSupport();
    this.faceSupportCache = { at: now, value };
    return value;
  }

  /**
   * The character's face as IP-Adapter input, or undefined when it can't or
   * shouldn't be used (no face, weight 0, nodes/models missing). Never
   * fails the photo: problems are logged and the photo is made without it.
   */
  private async faceReference(characterId: string): Promise<FaceParams | undefined> {
    const weight = this.opts.settings.faceWeight ?? 0;
    const face = weight > 0 ? this.faces?.get(characterId) : undefined;
    if (!face) return undefined;
    try {
      const support = await this.faceSupport();
      if (!support.ready) {
        this.log.info({ reason: support.reason }, 'reference face not applied');
        return undefined;
      }
      const bytes = await readFile(face.path);
      // Content-addressed name: a new face gets a new name, an unchanged one
      // is uploaded once per run.
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const name = `girllm_face_${characterId}_${hash}.${face.type === 'png' ? 'png' : 'jpg'}`;
      let image = this.uploadedFaces.get(name);
      if (!image) {
        image = await this.comfy.uploadImage(bytes, name, face.type === 'png' ? 'image/png' : 'image/jpeg');
        this.uploadedFaces.set(name, image);
      }
      return { image, weight };
    } catch (err) {
      this.log.warn({ err }, 'could not use the reference face; photo made without it');
      return undefined;
    }
  }

  /** Current options (re-read on every use). */
  private get opts(): ImageServiceOptions {
    return resolve(this.options);
  }

  /** Can photos be generated right now? (config + ComfyUI + checkpoint) */
  async status(): Promise<{
    available: boolean;
    checkpoint?: string;
    reason?: string;
    /** Reference faces: applied to photos, or why not. */
    face?: { ready: boolean; reason?: string };
  }> {
    const { checkpoint } = this.opts.settings;
    if (!checkpoint) return { available: false, reason: 'IMAGE_CHECKPOINT is not set in .env' };
    const comfy = await this.comfy.status();
    if (!comfy.ok) return { available: false, checkpoint, reason: `ComfyUI not reachable (${comfy.error})` };
    if (comfy.checkpoints && !comfy.checkpoints.includes(checkpoint)) {
      return {
        available: false,
        checkpoint,
        reason: `checkpoint "${checkpoint}" not found in ComfyUI (found: ${comfy.checkpoints.join(', ') || 'none'})`,
      };
    }
    const face =
      (this.opts.settings.faceWeight ?? 0) > 0
        ? await this.faceSupport()
        : { ready: false, reason: 'turned off in the settings (face strength 0)' };
    return { available: true, checkpoint, face };
  }

  /** Is an image model configured? (cheap check, no network: ComfyUI may still be down) */
  configured(): boolean {
    return Boolean(this.opts.settings.checkpoint);
  }

  /**
   * Generate a photo from the character and add it to the chat.
   * The caller must hold the session lock (ChatService does).
   */
  async createPhoto(sessionId: string, request: string, signal?: AbortSignal): Promise<StoredMessage> {
    const { id, path, caption } = await this.render(sessionId, request, signal);
    try {
      // The request is saved only now: a refused or failed photo leaves no trace in the chat.
      if (request) this.sessions.appendMessage(sessionId, 'user', `${PHOTO_REQUEST_PREFIX}${request}`);
      return this.sessions.appendMessage(sessionId, 'assistant', caption, { imageId: id });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
  }

  /**
   * She decided to send a photo with a message she just wrote ("[photo: …]"
   * in her reply): generate it and attach it to that message.
   * The caller must hold the session lock.
   * @returns the image id
   */
  async attachPhoto(sessionId: string, messageId: string, description: string, signal?: AbortSignal): Promise<string> {
    const { id, path } = await this.render(sessionId, description, signal);
    try {
      this.sessions.setMessageImage(messageId, id);
      return id;
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
  }

  /**
   * Safety checks, photo idea, exclusive GPU phase, then store the file and
   * its metadata row. Messages are the caller's business.
   */
  private async render(
    sessionId: string,
    request: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; path: string; caption: string }> {
    const { checkpoint, ...s } = this.opts.settings;
    if (!checkpoint) throw new ImageUnavailableError('IMAGE_CHECKPOINT is not set in .env');

    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const character = this.characters.get(session.characterId);
    if (!character) throw new Error(`Character ${session.characterId} not found`);

    // 1. Safety: the card must not describe a minor; the request must not ask for one.
    const card = [character.description, character.personality, character.scenario, character.appearance].join('\n');
    if (cardStatesMinorAge(card)) throw new ImageRefusedError();
    assertSafe(request, character.appearance);

    // 2. Imagine the photo (normal, shared GPU use).
    const idea = await writePhotoIdea(this.llm, {
      character,
      userName: this.opts.userName,
      recent: session.messages.filter((m) => m.seq > session.summarizedUntil),
      summary: session.summary,
      request,
      language: this.opts.replyLanguage,
      now: (this.opts.now ?? (() => new Date()))(),
    });
    signal?.throwIfAborted();

    // Order matters for CLIP: the most important tokens come first.
    const positive = [ADULT_POSITIVE_TERMS, 'solo', s.style, character.appearance, idea.scene]
      .filter(Boolean)
      .join(', ');
    assertSafe(idea.scene, positive);
    const negative = [s.negative, MINOR_NEGATIVE_TERMS].filter(Boolean).join(', ');
    const seed = randomInt(0, 2 ** 47);
    const face = await this.faceReference(character.id);

    // 3. Exclusive GPU phase.
    const png = await this.gate.runExclusive(async () => {
      await this.llm.unload?.().catch((err: unknown) => {
        this.log.warn({ err }, 'could not unload the LLM');
      });
      try {
        return await this.comfy.generate(
          buildTxt2ImgWorkflow({
            checkpoint,
            positive,
            negative,
            seed,
            width: s.width,
            height: s.height,
            steps: s.steps,
            cfg: s.cfg,
            sampler: s.sampler,
            scheduler: s.scheduler,
            hires: s.hires,
            face,
          }),
          signal,
        );
      } finally {
        // Give the VRAM back to the LLM even if generation failed.
        await this.comfy.free().catch((err: unknown) => {
          this.log.warn({ err }, 'could not free ComfyUI memory');
        });
      }
    });

    // 4. Store file then metadata; never leave an orphan file behind.
    const id = randomUUID();
    const fileName = `${id}.png`;
    await mkdir(this.imagesDir, { recursive: true });
    const path = join(this.imagesDir, fileName);
    await writeFile(path, png, { flag: 'wx' }); // 'wx': never overwrite
    try {
      this.images.add({ id, sessionId, fileName, scene: idea.scene, prompt: positive, seed });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { id, path, caption: idea.caption };
  }

  /**
   * Generate `count` reference-portrait candidates from an appearance
   * description (character editor). Hires is skipped: these are previews.
   */
  async generatePortraits(appearance: string, count: number, signal?: AbortSignal): Promise<Buffer[]> {
    const { checkpoint, ...s } = this.opts.settings;
    if (!checkpoint) throw new ImageUnavailableError('IMAGE_CHECKPOINT is not set (settings or .env)');
    if (!appearance.trim()) throw new ImageUnavailableError('Describe the appearance first');
    assertSafe(appearance);

    const positive = [ADULT_POSITIVE_TERMS, 'solo', s.style, appearance, PORTRAIT_SCENE].filter(Boolean).join(', ');
    assertSafe(positive);
    const negative = [s.negative, MINOR_NEGATIVE_TERMS].filter(Boolean).join(', ');

    return this.gate.runExclusive(async () => {
      await this.llm.unload?.().catch((err: unknown) => {
        this.log.warn({ err }, 'could not unload the LLM');
      });
      try {
        const images: Buffer[] = [];
        for (let i = 0; i < count; i++) {
          images.push(
            await this.comfy.generate(
              buildTxt2ImgWorkflow({
                checkpoint,
                positive,
                negative,
                seed: randomInt(0, 2 ** 47),
                width: 1024,
                height: 1024,
                steps: s.steps,
                cfg: s.cfg,
                sampler: s.sampler,
                scheduler: s.scheduler,
              }),
              signal,
            ),
          );
        }
        return images;
      } finally {
        await this.comfy.free().catch((err: unknown) => {
          this.log.warn({ err }, 'could not free ComfyUI memory');
        });
      }
    });
  }

  /** Checkpoints installed in ComfyUI (undefined if ComfyUI is unreachable). */
  async listCheckpoints(): Promise<string[] | undefined> {
    const status = await this.comfy.status();
    return status.ok ? status.checkpoints : undefined;
  }

  get(imageId: string): StoredImage | undefined {
    return this.images.get(imageId);
  }

  /** Absolute path of an image file (name comes from the DB, never from the client). */
  filePath(image: StoredImage): string {
    return join(this.imagesDir, image.fileName);
  }

  /**
   * Paths of a session's image files. Collect them BEFORE deleting the
   * session (its image rows disappear through ON DELETE CASCADE), then
   * pass them to `deleteFiles`.
   */
  collectFiles(sessionId: string): string[] {
    return this.images.listBySession(sessionId).map((i) => this.filePath(i));
  }

  async deleteFiles(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map((p) =>
        rm(p, { force: true }).catch((err: unknown) => {
          this.log.warn({ err, p }, 'could not delete image');
        }),
      ),
    );
  }
}

export class ImageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUnavailableError';
  }
}
