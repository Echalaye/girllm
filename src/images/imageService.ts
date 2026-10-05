/**
 * "She sends you a photo": orchestrates the whole image pipeline.
 *
 *  1. safety checks on the card and the request (no minors, ever);
 *  2. the chat model imagines the photo (caption + scene) — normal GPU use;
 *  3. EXCLUSIVE GPU phase: unload the LLM, run ComfyUI, free ComfyUI's VRAM;
 *  4. store the PNG + metadata, add the photo message to the chat.
 *
 * Each character is drawn in her art style (step 5): realistic photos or
 * anime, each with its own image profile (checkpoint, sampler, tags…).
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { resolve, type Live } from '../util/resolve.js';
import type { CharacterRepository } from '../characters/characterRepository.js';
import type { FaceStore } from '../characters/faceStore.js';
import type { Character } from '../characters/schema.js';
import type { FaceParams } from './ipAdapter.js';
import type { SessionStore, StoredMessage } from '../chat/sessionStore.js';
import type { LlmProvider } from '../llm/types.js';
import type { GpuGate } from '../util/gpuGate.js';
import type { ComfyClient } from './comfyClient.js';
import type { ImageStore, StoredImage } from './imageStore.js';
import { writePhotoIdea } from './photoPrompt.js';
import { assertSafe, cardStatesMinorAge, ImageRefusedError } from './safety.js';
import { buildNegativePrompt, buildPositivePrompt, type ArtStyle, type Gender } from './artStyle.js';
import { buildTxt2ImgWorkflow, type ComfyWorkflow, type HiresParams } from './workflow.js';

/** Framing of the reference portraits generated in the character editor. */
export const PORTRAIT_SCENE = {
  realistic:
    'head and shoulders portrait, looking at the camera, relaxed slight smile, plain light background, soft diffused light, sharp focus on the face',
  anime: 'portrait, upper body, looking at viewer, light smile, simple background, white background',
} as const satisfies Record<ArtStyle, string>;

/** What the LLM is asked to imagine for a chat background (step 5). */
export const BACKGROUND_REQUEST =
  'A wide landscape picture of me in the place where my scenario happens (or my usual place): the setting is ' +
  'clearly visible around me, relaxed pose, looking at the camera. Not a selfie.';

/** Chat backgrounds are landscape (SDXL-friendly size). */
const BACKGROUND_SIZE = { width: 1216, height: 832 } as const;

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
  /** Style tags ("photo, realistic…" / anime quality tags). */
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
  /** Realistic characters (the default style). */
  settings: ImageSettings;
  /** Anime characters; undefined = no anime pictures. */
  anime?: ImageSettings | undefined;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

export interface ImageLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** Availability of one art style. */
export interface StyleStatus {
  available: boolean;
  checkpoint?: string;
  reason?: string;
  /** Reference faces: applied to pictures, or why not. */
  face?: { ready: boolean; reason?: string };
}

/** Who to draw, when there is no character yet (editor previews). */
export interface Subject {
  appearance: string;
  artStyle: ArtStyle;
  gender: Gender;
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
    /** Reference faces (optional: without it pictures use the text prompt only). */
    private readonly faces?: FaceStore,
  ) {
    this.imagesDir = resolvePath(this.opts.imagesDir);
  }

  /** IP-Adapter readiness, cached: asking ComfyUI on every photo is wasteful. */
  private faceSupportCache: { at: number; value: { ready: boolean; reason?: string } } | undefined;
  /** Reference faces already uploaded to ComfyUI: our name → name to use in LoadImage. */
  private readonly uploadedFaces = new Map<string, string>();

  /** Current options (re-read on every use). */
  private get opts(): ImageServiceOptions {
    return resolve(this.options);
  }

  /** Image profile of an art style (may have no checkpoint: see `profile`). */
  private profileSettings(style: ArtStyle): ImageSettings | undefined {
    return style === 'anime' ? this.opts.anime : this.opts.settings;
  }

  /** Image profile with a checkpoint, or a clear "how to fix it" error. */
  private profile(style: ArtStyle): ImageSettings & { checkpoint: string } {
    const p = this.profileSettings(style);
    if (!p?.checkpoint) {
      throw new ImageUnavailableError(
        style === 'anime'
          ? 'No anime image model: run npm run setup:images -- --anime, then pick it in the settings'
          : 'IMAGE_CHECKPOINT is not set (settings or .env)',
      );
    }
    return { ...p, checkpoint: p.checkpoint };
  }

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
   * fails the picture: problems are logged and it is made without it.
   */
  private async faceReference(characterId: string, weight: number): Promise<FaceParams | undefined> {
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
      this.log.warn({ err }, 'could not use the reference face; picture made without it');
      return undefined;
    }
  }

  /** Can pictures be generated right now? Realistic at the top level, anime under `anime`. */
  async status(): Promise<StyleStatus & { anime: StyleStatus }> {
    const comfy = await this.comfy.status();
    const check = async (style: ArtStyle): Promise<StyleStatus> => {
      const p = this.profileSettings(style);
      const checkpoint = p?.checkpoint;
      if (!checkpoint) {
        return {
          available: false,
          reason: style === 'anime' ? 'no anime image model set' : 'IMAGE_CHECKPOINT is not set in .env',
        };
      }
      if (!comfy.ok) return { available: false, checkpoint, reason: `ComfyUI not reachable (${comfy.error})` };
      if (comfy.checkpoints && !comfy.checkpoints.includes(checkpoint)) {
        const hint = style === 'anime' ? ' (run: npm run setup:images -- --anime)' : '';
        return {
          available: false,
          checkpoint,
          reason: `checkpoint "${checkpoint}" not found in ComfyUI${hint} (found: ${comfy.checkpoints.join(', ') || 'none'})`,
        };
      }
      const face =
        (p.faceWeight ?? 0) > 0
          ? await this.faceSupport()
          : { ready: false, reason: 'turned off in the settings (face strength 0)' };
      return { available: true, checkpoint, face };
    };
    return { ...(await check('realistic')), anime: await check('anime') };
  }

  /** Is an image model configured for this style? (cheap check, no network) */
  configured(style: ArtStyle = 'realistic'): boolean {
    return Boolean(this.profileSettings(style)?.checkpoint);
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

  /** @throws ImageRefusedError if the card states an under-18 age or the texts mention a minor. */
  private assertCharacterSafe(character: Character, ...texts: string[]): void {
    const card = [character.description, character.personality, character.scenario, character.appearance].join('\n');
    if (cardStatesMinorAge(card)) throw new ImageRefusedError();
    assertSafe(character.appearance, ...texts);
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
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const character = this.characters.get(session.characterId);
    if (!character) throw new Error(`Character ${session.characterId} not found`);
    const p = this.profile(character.artStyle);

    // 1. Safety: the card must not describe a minor; the request must not ask for one.
    this.assertCharacterSafe(character, request);

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

    const positive = buildPositivePrompt({
      style: character.artStyle,
      gender: character.gender,
      styleTags: p.style,
      appearance: character.appearance,
      scene: idea.scene,
    });
    assertSafe(idea.scene, positive);
    const seed = randomInt(0, 2 ** 47);
    const face = await this.faceReference(character.id, p.faceWeight ?? 0);

    // 3. Exclusive GPU phase.
    const [png] = await this.runOnGpu(
      [
        buildTxt2ImgWorkflow({
          checkpoint: p.checkpoint,
          positive,
          negative: buildNegativePrompt(character.artStyle, p.negative),
          seed,
          width: p.width,
          height: p.height,
          steps: p.steps,
          cfg: p.cfg,
          sampler: p.sampler,
          scheduler: p.scheduler,
          hires: p.hires,
          face,
        }),
      ],
      signal,
    );

    // 4. Store file then metadata; never leave an orphan file behind.
    const id = randomUUID();
    const fileName = `${id}.png`;
    await mkdir(this.imagesDir, { recursive: true });
    const path = join(this.imagesDir, fileName);
    await writeFile(path, png!, { flag: 'wx' }); // 'wx': never overwrite
    try {
      this.images.add({ id, sessionId, fileName, scene: idea.scene, prompt: positive, seed });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { id, path, caption: idea.caption };
  }

  /**
   * The exclusive GPU phase: unload the LLM, run the workflows one after the
   * other, then always give the VRAM back.
   */
  private runOnGpu(workflows: ComfyWorkflow[], signal?: AbortSignal): Promise<Buffer[]> {
    return this.gate.runExclusive(async () => {
      await this.llm.unload?.().catch((err: unknown) => {
        this.log.warn({ err }, 'could not unload the LLM');
      });
      try {
        const images: Buffer[] = [];
        for (const workflow of workflows) images.push(await this.comfy.generate(workflow, signal));
        return images;
      } finally {
        // Give the VRAM back to the LLM even if generation failed.
        await this.comfy.free().catch((err: unknown) => {
          this.log.warn({ err }, 'could not free ComfyUI memory');
        });
      }
    });
  }

  /**
   * Generate `count` reference-portrait candidates from an appearance
   * description (character editor), in the character's art style.
   * The detail pass is skipped: these are previews.
   */
  async generatePortraits(subject: Subject, count: number, signal?: AbortSignal): Promise<Buffer[]> {
    const p = this.profile(subject.artStyle);
    if (!subject.appearance.trim()) throw new ImageUnavailableError('Describe the appearance first');
    assertSafe(subject.appearance);

    const positive = buildPositivePrompt({
      style: subject.artStyle,
      gender: subject.gender,
      styleTags: p.style,
      appearance: subject.appearance,
      scene: PORTRAIT_SCENE[subject.artStyle],
    });
    assertSafe(positive);
    const negative = buildNegativePrompt(subject.artStyle, p.negative);
    const workflows = Array.from({ length: count }, () =>
      buildTxt2ImgWorkflow({
        checkpoint: p.checkpoint,
        positive,
        negative,
        seed: randomInt(0, 2 ** 47),
        width: 1024,
        height: 1024,
        steps: p.steps,
        cfg: p.cfg,
        sampler: p.sampler,
        scheduler: p.scheduler,
      }),
    );
    return this.runOnGpu(workflows, signal);
  }

  /**
   * Chat background candidates (step 5): a wide picture of her in her usual
   * place, imagined by the LLM from her card, with her reference face.
   */
  async generateBackgrounds(characterId: string, count: number, signal?: AbortSignal): Promise<Buffer[]> {
    const character = this.characters.get(characterId);
    if (!character) throw new Error(`Character ${characterId} not found`);
    const p = this.profile(character.artStyle);
    this.assertCharacterSafe(character);

    const idea = await writePhotoIdea(this.llm, {
      character,
      userName: this.opts.userName,
      recent: [],
      summary: '',
      request: BACKGROUND_REQUEST,
      language: this.opts.replyLanguage,
      now: (this.opts.now ?? (() => new Date()))(),
    });
    signal?.throwIfAborted();
    const positive = buildPositivePrompt({
      style: character.artStyle,
      gender: character.gender,
      styleTags: p.style,
      appearance: character.appearance,
      scene: idea.scene,
    });
    assertSafe(idea.scene, positive);
    const negative = buildNegativePrompt(character.artStyle, p.negative);
    const face = await this.faceReference(character.id, p.faceWeight ?? 0);
    const workflows = Array.from({ length: count }, () =>
      buildTxt2ImgWorkflow({
        checkpoint: p.checkpoint,
        positive,
        negative,
        seed: randomInt(0, 2 ** 47),
        ...BACKGROUND_SIZE,
        steps: p.steps,
        cfg: p.cfg,
        sampler: p.sampler,
        scheduler: p.scheduler,
        face,
      }),
    );
    return this.runOnGpu(workflows, signal);
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
