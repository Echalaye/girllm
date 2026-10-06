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
 * Realistic characters are drawn by FLUX.2 [klein] 4B when it is installed
 * (step 6: natural bodies and hands, her face as a reference picture),
 * otherwise by the SDXL checkpoint. When her face is small in the picture,
 * a face pass redraws it from her reference face (both engines). A photo
 * can be retaken: same scene, new
 * seed, replacing the picture in its message.
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
import { assertSafe, assertSafeStrict, cardStatesMinorAge, ImageRefusedError } from './safety.js';
import { buildNegativePrompt, buildPositivePrompt, frameForScene, type ArtStyle, type Gender } from './artStyle.js';
import { buildTxt2ImgWorkflow, type HiresParams } from './workflow.js';
import type { FaceDetector } from './faceDetector.js';
import { renderPicture, type RenderJob } from './renderPipeline.js';
import type { RealisticEngine } from '../config.js';
import type { CropBox } from './detailWorkflow.js';
import {
  buildFlux2FacePrompt,
  buildFlux2Prompt,
  buildFlux2Workflow,
  FLUX2_APP_SETTINGS,
  FLUX2_FACE_PASS,
  FLUX2_KLEIN_MODEL,
  FLUX2_KLEIN_TEXT_ENCODER,
  FLUX2_VAE,
  referenceCrop,
} from './flux2Workflow.js';
import { pngSize } from './renderPipeline.js';

/** Framing of the reference portraits generated in the character editor. */
export const PORTRAIT_SCENE = {
  realistic:
    'head and shoulders portrait, looking at the camera, relaxed slight smile, plain light background, soft diffused light, sharp focus on the face',
  anime: 'portrait, upper body, looking at viewer, light smile, simple background, white background',
} as const satisfies Record<ArtStyle, string>;

/** What the LLM is asked to imagine for a chat background (step 5). */
export const BACKGROUND_REQUEST =
  'A wide landscape picture of me in the place where my scenario happens, or else a place of my everyday life ' +
  'from my description (where I work, live or spend my free time; not a generic beach or landscape): the setting ' +
  'is clearly visible around me, relaxed natural pose, looking at the camera. Not a selfie.';

/** Chat backgrounds are landscape (SDXL-friendly size). */
const BACKGROUND_SIZE = { width: 1216, height: 832 } as const;

/** Marks a user message that is a photo request (shown in the chat as "📷 …"). */
export const PHOTO_REQUEST_PREFIX = '📷 ';

export interface ImageSettings {
  /**
   * Realistic profile only: which model draws (default 'sdxl'). 'flux2-klein'
   * falls back to the checkpoint while FLUX.2 [klein] is not installed.
   */
  engine?: RealisticEngine | undefined;
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
  /** Face detail pass: how much a small face is redrawn (0 or undefined = off). */
  detailStrength?: number | undefined;
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
  /** Model drawing this style right now. */
  engine?: RealisticEngine;
  /** Why the chosen engine isn't the one in the settings (FLUX.2 not installed…). */
  note?: string;
}

/** What draws a picture: FLUX.2 [klein], or SDXL with its profile. */
type Engine = { kind: 'flux2-klein' } | { kind: 'sdxl'; p: ImageSettings & { checkpoint: string } };

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
    /** Finds the face for the detail pass (optional: no detail pass without it). */
    private readonly detector?: FaceDetector,
  ) {
    this.imagesDir = resolvePath(this.opts.imagesDir);
  }

  /** IP-Adapter readiness, cached: asking ComfyUI on every photo is wasteful. */
  private faceSupportCache: { at: number; value: { ready: boolean; reason?: string } } | undefined;
  /** Reference faces already uploaded to ComfyUI: our name → name to use in LoadImage. */
  private readonly uploadedFaces = new Map<string, string>();
  /** FLUX.2 [klein] readiness, cached like faceSupport. */
  private fluxSupportCache: { at: number; value: { ready: boolean; reason?: string } } | undefined;
  /** Face crop of each uploaded reference (FLUX.2 copies the whole picture otherwise). */
  private readonly faceCrops = new Map<string, CropBox | undefined>();

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
   * Upload the character's reference face to ComfyUI (once per content:
   * the name contains a hash of the file) and return its LoadImage name.
   * @returns undefined when she has no face
   */
  private async uploadFace(characterId: string): Promise<{ image: string; bytes: Buffer; png: boolean } | undefined> {
    const face = this.faces?.get(characterId);
    if (!face) return undefined;
    const bytes = await readFile(face.path);
    // Content-addressed name: a new face gets a new name, an unchanged one
    // is uploaded once per run.
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const png = face.type === 'png';
    const name = `girllm_face_${characterId}_${hash}.${png ? 'png' : 'jpg'}`;
    let image = this.uploadedFaces.get(name);
    if (!image) {
      image = await this.comfy.uploadImage(bytes, name, png ? 'image/png' : 'image/jpeg');
      this.uploadedFaces.set(name, image);
    }
    return { image, bytes, png };
  }

  /**
   * The character's face as IP-Adapter input (SDXL), or undefined when it
   * can't or shouldn't be used (no face, weight 0, nodes/models missing).
   * Never fails the picture: problems are logged and it is made without it.
   */
  private async faceReference(characterId: string, weight: number): Promise<FaceParams | undefined> {
    if (weight <= 0 || !this.faces?.get(characterId)) return undefined;
    try {
      const support = await this.faceSupport();
      if (!support.ready) {
        this.log.info({ reason: support.reason }, 'reference face not applied');
        return undefined;
      }
      const face = await this.uploadFace(characterId);
      return face ? { image: face.image, weight } : undefined;
    } catch (err) {
      this.log.warn({ err }, 'could not use the reference face; picture made without it');
      return undefined;
    }
  }

  /**
   * The character's face as FLUX.2 reference picture ("image 1"), cropped to
   * the face when the detector finds it (PNG faces). FLUX.2 needs no extra
   * nodes for this. Never fails the picture.
   */
  private async fluxFaceReference(characterId: string): Promise<{ image: string; crop?: CropBox } | undefined> {
    try {
      const face = await this.uploadFace(characterId);
      if (!face) return undefined;
      if (!this.faceCrops.has(face.image)) {
        let crop: CropBox | undefined;
        if (face.png && this.detector?.available()) {
          const box = await this.detector.detect(face.bytes).catch(() => undefined);
          if (box) {
            const { width, height } = pngSize(face.bytes);
            crop = referenceCrop(box, width, height);
          }
        }
        this.faceCrops.set(face.image, crop);
      }
      const crop = this.faceCrops.get(face.image);
      return crop ? { image: face.image, crop } : { image: face.image };
    } catch (err) {
      this.log.warn({ err }, 'could not use the reference face; picture made without it');
      return undefined;
    }
  }

  /** Are the FLUX.2 [klein] nodes and files there? (cached for a minute) */
  async fluxSupport(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.fluxSupportCache && now - this.fluxSupportCache.at < 60_000) return this.fluxSupportCache.value;
    const value = await this.comfy.flux2Support({
      model: FLUX2_KLEIN_MODEL.file,
      textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file,
      vae: FLUX2_VAE.file,
    });
    this.fluxSupportCache = { at: now, value };
    return value;
  }

  /**
   * Which model draws this style now: FLUX.2 [klein] for realistic
   * characters when chosen and installed, else the SDXL profile.
   * @throws ImageUnavailableError with what to install
   */
  private async engineFor(style: ArtStyle): Promise<Engine> {
    if (style === 'realistic' && this.opts.settings.engine === 'flux2-klein') {
      const support = await this.fluxSupport();
      if (support.ready) return { kind: 'flux2-klein' };
      if (!this.opts.settings.checkpoint) {
        throw new ImageUnavailableError(
          `FLUX.2 [klein] unavailable: ${support.reason ?? 'not installed'}. ` +
            'Install it (npm run setup:images -- --flux2-klein, recent ComfyUI) or choose SDXL in the settings',
        );
      }
      this.log.info({ reason: support.reason }, 'FLUX.2 [klein] unavailable; using the SDXL checkpoint');
    }
    return { kind: 'sdxl', p: this.profile(style) };
  }

  /**
   * Build the ComfyUI job of one picture (both engines). Runs the safety
   * check on the final prompt: the strict one for FLUX.2, which has no
   * negative prompt to push youth terms away.
   */
  private async pictureJob(
    engine: Engine,
    o: {
      style: ArtStyle;
      gender: Gender;
      appearance: string;
      scene: string;
      seed: number;
      width: number;
      height: number;
      /** Character whose reference face is used (none for editor previews). */
      faceOf?: string | undefined;
      /** Extras: second hires pass (SDXL), face detail pass (both engines; not for close-up portraits). */
      hires: boolean;
      detail: boolean;
    },
  ): Promise<{ job: RenderJob; prompt: string }> {
    if (engine.kind === 'flux2-klein') {
      const face = o.faceOf ? await this.fluxFaceReference(o.faceOf) : undefined;
      const prompt = buildFlux2Prompt({
        style: o.style,
        gender: o.gender,
        appearance: o.appearance,
        scene: o.scene,
        reference: face !== undefined,
      });
      assertSafeStrict(o.scene, prompt);
      const workflow = buildFlux2Workflow({
        positive: prompt,
        seed: o.seed,
        width: o.width,
        height: o.height,
        ...FLUX2_APP_SETTINGS,
        referenceImage: face?.image,
        referenceCrop: face?.crop,
      });
      // Face pass (step 6c): in a wide or full-body shot her face is too
      // small for the reference to carry her features; redraw it at 1024 px
      // from her face. Needs her face; IMAGE_DETAIL_STRENGTH=0 turns it off.
      const detail: RenderJob['detail'] =
        o.detail && face && (this.opts.settings.detailStrength ?? 0) > 0
          ? {
              kind: 'flux2',
              positive: this.fluxFacePrompt(o),
              seed: o.seed,
              face,
              ...FLUX2_FACE_PASS,
            }
          : undefined;
      return { job: { workflow, detail }, prompt };
    }
    const { p } = engine;
    const positive = buildPositivePrompt({
      style: o.style,
      gender: o.gender,
      styleTags: p.style,
      appearance: o.appearance,
      scene: o.scene,
    });
    assertSafe(o.scene, positive);
    const negative = buildNegativePrompt(o.style, p.negative);
    const face = o.faceOf ? await this.faceReference(o.faceOf, p.faceWeight ?? 0) : undefined;
    const workflow = buildTxt2ImgWorkflow({
      checkpoint: p.checkpoint,
      positive,
      negative,
      seed: o.seed,
      width: o.width,
      height: o.height,
      steps: p.steps,
      cfg: p.cfg,
      sampler: p.sampler,
      scheduler: p.scheduler,
      hires: o.hires ? p.hires : undefined,
      face,
    });
    return {
      job: { workflow, detail: o.detail ? detailSettings(p, positive, negative, o.seed, face) : undefined },
      prompt: positive,
    };
  }

  /** Prompt of the FLUX.2 face pass, safety-checked like the picture's. */
  private fluxFacePrompt(o: { style: ArtStyle; gender: Gender; appearance: string }): string {
    const prompt = buildFlux2FacePrompt(o);
    assertSafeStrict(prompt);
    return prompt;
  }

  /** Can pictures be generated right now? Realistic at the top level, anime under `anime`. */
  async status(): Promise<StyleStatus & { anime: StyleStatus }> {
    const comfy = await this.comfy.status();
    const check = async (style: ArtStyle): Promise<StyleStatus> => {
      const p = this.profileSettings(style);
      let note: string | undefined;
      if (style === 'realistic' && p?.engine === 'flux2-klein') {
        if (!comfy.ok) return { available: false, reason: `ComfyUI not reachable (${comfy.error})` };
        const flux = await this.fluxSupport();
        // FLUX.2 takes her face as a reference picture: nothing else to install.
        if (flux.ready) return { available: true, engine: 'flux2-klein', face: { ready: true } };
        note = `FLUX.2 [klein] unavailable (${flux.reason}): using the SDXL checkpoint`;
        if (!p.checkpoint) return { available: false, reason: `FLUX.2 [klein] unavailable: ${flux.reason}` };
      }
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
      return { available: true, checkpoint, engine: 'sdxl', face, ...(note ? { note } : {}) };
    };
    return { ...(await check('realistic')), anime: await check('anime') };
  }

  /** Is an image model configured for this style? (cheap check, no network) */
  configured(style: ArtStyle = 'realistic'): boolean {
    const p = this.profileSettings(style);
    return Boolean(p?.checkpoint) || (style === 'realistic' && p?.engine === 'flux2-klein');
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
    // Fail fast (before the LLM call) when no model can draw her.
    const engine = await this.engineFor(character.artStyle);

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
      engine: engine.kind,
    });
    signal?.throwIfAborted();

    // 3–4. Draw it, store it.
    const stored = await this.drawAndStore(sessionId, character, engine, idea.scene, signal);
    return { ...stored, caption: idea.caption };
  }

  /**
   * Exclusive GPU phase for one photo of a scene, then store the file and
   * its metadata row (never an orphan file). Shared by new photos and retakes.
   */
  private async drawAndStore(
    sessionId: string,
    character: Character,
    engine: Engine,
    scene: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; path: string }> {
    const seed = randomInt(0, 2 ** 47);
    const base = this.profileSettings(character.artStyle) ?? this.opts.settings;
    const { job, prompt } = await this.pictureJob(engine, {
      style: character.artStyle,
      gender: character.gender,
      appearance: character.appearance,
      scene,
      seed,
      // Taller frame for full-body scenes (natural proportions).
      ...frameForScene(scene, base.width, base.height),
      faceOf: character.id,
      hires: true,
      detail: true,
    });
    const [png] = await this.runOnGpu([job], signal);

    const id = randomUUID();
    const fileName = `${id}.png`;
    await mkdir(this.imagesDir, { recursive: true });
    const path = join(this.imagesDir, fileName);
    await writeFile(path, png!, { flag: 'wx' }); // 'wx': never overwrite
    try {
      this.images.add({ id, sessionId, fileName, scene, prompt, seed });
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { id, path };
  }

  /**
   * Retake a photo: same scene, new seed, current model. The new picture
   * replaces the old one in its message; the old file and row are deleted.
   * The caller must hold the session lock and has checked that the message
   * belongs to the session and shows this image.
   * @returns the new image id
   */
  async retakePhoto(sessionId: string, messageId: string, imageId: string, signal?: AbortSignal): Promise<string> {
    const old = this.images.get(imageId);
    if (!old || old.sessionId !== sessionId) throw new Error(`Image ${imageId} not in session ${sessionId}`);
    const session = this.sessions.get(sessionId);
    const character = session ? this.characters.get(session.characterId) : undefined;
    if (!character) throw new Error(`Character of session ${sessionId} not found`);
    const engine = await this.engineFor(character.artStyle);
    // The card may have changed since: check again, with the stored scene.
    this.assertCharacterSafe(character, old.scene);

    const { id, path } = await this.drawAndStore(sessionId, character, engine, old.scene, signal);
    try {
      this.sessions.setMessageImage(messageId, id);
    } catch (err) {
      this.images.delete(id);
      await rm(path, { force: true });
      throw err;
    }
    // The old picture is no longer shown anywhere: remove it (file best effort).
    this.images.delete(old.id);
    await this.deleteFiles([this.filePath(old)]);
    return id;
  }

  /**
   * The exclusive GPU phase: unload the LLM, render the pictures one after
   * the other (each with its face detail pass), then always give the VRAM back.
   */
  private runOnGpu(jobs: RenderJob[], signal?: AbortSignal): Promise<Buffer[]> {
    return this.gate.runExclusive(async () => {
      await this.llm.unload?.().catch((err: unknown) => {
        this.log.warn({ err }, 'could not unload the LLM');
      });
      try {
        const images: Buffer[] = [];
        for (const job of jobs) {
          const result = await renderPicture(this.comfy, this.detector, job, this.log, signal);
          if (result.detail === 'done') this.log.info({}, 'face detail pass applied');
          images.push(result.png);
        }
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
    const engine = await this.engineFor(subject.artStyle);
    if (!subject.appearance.trim()) throw new ImageUnavailableError('Describe the appearance first');
    assertSafe(subject.appearance);
    // Close-ups (no detail pass), no reference face: this is how she gets one.
    const jobs: RenderJob[] = [];
    for (let i = 0; i < count; i++) {
      const { job } = await this.pictureJob(engine, {
        style: subject.artStyle,
        gender: subject.gender,
        appearance: subject.appearance,
        scene: PORTRAIT_SCENE[subject.artStyle],
        seed: randomInt(0, 2 ** 47),
        width: 1024,
        height: 1024,
        hires: false,
        detail: false,
      });
      jobs.push(job);
    }
    return this.runOnGpu(jobs, signal);
  }

  /**
   * Chat background candidates (step 5): a wide picture of her in her usual
   * place, imagined by the LLM from her card, with her reference face.
   */
  async generateBackgrounds(characterId: string, count: number, signal?: AbortSignal): Promise<Buffer[]> {
    const character = this.characters.get(characterId);
    if (!character) throw new Error(`Character ${characterId} not found`);
    const engine = await this.engineFor(character.artStyle);
    this.assertCharacterSafe(character);

    // The user's own words when given (editor), else imagined by the LLM from her card.
    const scene = character.backgroundScene
      ? backgroundSceneFromUser(character.backgroundScene)
      : (
          await writePhotoIdea(this.llm, {
            character,
            userName: this.opts.userName,
            recent: [],
            summary: '',
            request: BACKGROUND_REQUEST,
            language: this.opts.replyLanguage,
            now: (this.opts.now ?? (() => new Date()))(),
            engine: engine.kind,
          })
        ).scene;
    signal?.throwIfAborted();
    const jobs: RenderJob[] = [];
    for (let i = 0; i < count; i++) {
      const { job } = await this.pictureJob(engine, {
        style: character.artStyle,
        gender: character.gender,
        appearance: character.appearance,
        scene,
        seed: randomInt(0, 2 ** 47),
        ...BACKGROUND_SIZE,
        faceOf: character.id,
        hires: false,
        // Her face is small in a wide scene: redraw it (SDXL).
        detail: true,
      });
      jobs.push(job);
    }
    return this.runOnGpu(jobs, signal);
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

/**
 * The user's background scene as given to the image model: their words, plus
 * the framing the chat background needs (wide shot, setting visible) unless
 * they already chose one. The safety checks run on it like on any scene.
 */
export function backgroundSceneFromUser(text: string): string {
  const scene = text.trim().replace(/\s+/g, ' ');
  return /\b(wide|full[\s-]?body|landscape)\b/i.test(scene)
    ? scene
    : `${scene.replace(/[.\s]+$/, '')}. Wide shot, the setting clearly visible around them.`;
}

/** Face detail pass settings for a picture, or undefined when it is turned off. */
function detailSettings(
  p: ImageSettings & { checkpoint: string },
  positive: string,
  negative: string,
  seed: number,
  face: FaceParams | undefined,
): RenderJob['detail'] {
  const denoise = p.detailStrength ?? 0;
  if (denoise <= 0) return undefined;
  return {
    checkpoint: p.checkpoint,
    positive,
    negative,
    seed,
    steps: p.steps,
    cfg: p.cfg,
    sampler: p.sampler,
    scheduler: p.scheduler,
    denoise,
    face,
  };
}

export class ImageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUnavailableError';
  }
}
