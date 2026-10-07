/**
 * Each character's reference voice (step 7): a short clip and what it says
 * (the voice-clone model needs the transcript). FLAC when Qwen3-TTS designed
 * it, WAV when the user recorded or brought it (step 7b). Plus the candidates
 * shown in the editor, kept until the user picks one (or for an hour).
 *
 *   data/voices/<characterId>.flac|.wav + <characterId>.json
 *   data/voices/candidates/<uuid>.flac|.wav + <uuid>.json
 *
 * Every path is built from a validated id (character slug or UUID), never
 * from client input, so nothing can escape the voices folder. Writes are
 * atomic: a crash never leaves half a clip.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicWrite.js';

const CHARACTER_ID = /^[a-z0-9-]{1,80}$/;
const CANDIDATE_ID = /^[0-9a-f-]{36}$/;

/** Clip formats, recognised by their first bytes (never by a name the client chose). */
const AUDIO_TYPES = {
  flac: { magic: Buffer.from('fLaC', 'ascii'), contentType: 'audio/flac' },
  wav: { magic: Buffer.from('RIFF', 'ascii'), contentType: 'audio/wav' },
} as const;
export type AudioType = keyof typeof AUDIO_TYPES;
const EXTENSIONS = Object.keys(AUDIO_TYPES) as AudioType[];

/** @throws Error when the bytes are neither FLAC nor WAV. */
export function audioType(bytes: Buffer): AudioType {
  const type = EXTENSIONS.find((t) => bytes.subarray(0, 4).equals(AUDIO_TYPES[t].magic));
  if (!type) throw new Error('Unsupported audio clip (FLAC or WAV only)');
  return type;
}

/** MIME type of a stored clip, from its extension (set by this store). */
export function audioContentType(path: string): string {
  return path.endsWith('.wav') ? AUDIO_TYPES.wav.contentType : AUDIO_TYPES.flac.contentType;
}

/** What is stored next to a clip. */
const VoiceInfoSchema = z.object({
  /** Exact words of the clip (given to the clone model as ref_text). */
  text: z.string().min(1).max(1000),
  /** The description it was designed from, or what the user said it is (shown in the editor). */
  description: z.string().max(1000),
  /** Model language the clip was made in. */
  language: z.string().max(20),
  createdAt: z.string(),
  /** Where it comes from: recorded with the mic or a file (step 7b); absent = designed by Qwen3-TTS. */
  source: z.enum(['recorded', 'uploaded']).optional(),
  /**
   * For a real person's voice: when the user confirmed it is their own voice,
   * or that of an adult who agreed to it.
   */
  consentAt: z.string().optional(),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

export interface StoredVoice {
  /** Absolute path of the clip (.flac or .wav). */
  path: string;
  type: AudioType;
  info: VoiceInfo;
  /** SHA-256 of the clip: changes whenever the voice changes (cache keys, upload names). */
  hash: string;
}

export class VoiceStore {
  private readonly dir: string;
  private readonly candidatesDir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.candidatesDir = join(this.dir, 'candidates');
  }

  /** The character's voice, or undefined when she has none (or its files are unreadable). */
  async get(characterId: string): Promise<StoredVoice | undefined> {
    this.check(characterId, CHARACTER_ID);
    return this.read(join(this.dir, characterId));
  }

  /** Store a clip (FLAC or WAV) as the character's voice (replaces the previous one). */
  async save(characterId: string, audio: Buffer, info: VoiceInfo): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    const type = audioType(audio);
    await mkdir(this.dir, { recursive: true });
    // Old clip and description out first, then clip, then description: get()
    // needs both, so a crash in between leaves "no voice" (made again on
    // demand), never a clip with another clip's words.
    await this.remove(characterId);
    await writeFileAtomic(join(this.dir, `${characterId}.${type}`), audio);
    await writeFileAtomic(join(this.dir, `${characterId}.json`), JSON.stringify(VoiceInfoSchema.parse(info)));
  }

  async remove(characterId: string): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    await rm(join(this.dir, `${characterId}.json`), { force: true });
    for (const ext of EXTENSIONS) await rm(join(this.dir, `${characterId}.${ext}`), { force: true });
  }

  /** Keep a clip (FLAC or WAV) until the user picks one. @returns its id. */
  async addCandidate(audio: Buffer, info: VoiceInfo): Promise<string> {
    const type = audioType(audio);
    await mkdir(this.candidatesDir, { recursive: true });
    const id = randomUUID();
    await writeFileAtomic(join(this.candidatesDir, `${id}.${type}`), audio);
    await writeFileAtomic(join(this.candidatesDir, `${id}.json`), JSON.stringify(VoiceInfoSchema.parse(info)));
    return id;
  }

  /** A candidate's clip path, or undefined once it expired. */
  candidatePath(candidateId: string): string | undefined {
    this.check(candidateId, CANDIDATE_ID);
    return EXTENSIONS.map((ext) => join(this.candidatesDir, `${candidateId}.${ext}`)).find((p) => existsSync(p));
  }

  /** Make a candidate the character's voice. @returns false if the candidate expired. */
  async promote(characterId: string, candidateId: string): Promise<boolean> {
    this.check(candidateId, CANDIDATE_ID);
    const candidate = await this.read(join(this.candidatesDir, candidateId));
    if (!candidate) return false;
    this.check(characterId, CHARACTER_ID);
    await mkdir(this.dir, { recursive: true });
    await this.remove(characterId);
    await copyFile(candidate.path, join(this.dir, `${characterId}.${candidate.type}`));
    await writeFileAtomic(join(this.dir, `${characterId}.json`), JSON.stringify(candidate.info));
    await rm(candidate.path, { force: true });
    await rm(join(this.candidatesDir, `${candidateId}.json`), { force: true });
    return true;
  }

  /** Delete candidates older than `maxAgeMs` (called before generating new ones). */
  async cleanupCandidates(maxAgeMs: number, now = Date.now()): Promise<void> {
    if (!existsSync(this.candidatesDir)) return;
    for (const name of await readdir(this.candidatesDir)) {
      const path = join(this.candidatesDir, name);
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs > maxAgeMs) await rm(path, { force: true });
    }
  }

  /** `<base>.flac|.wav` + `<base>.json`, both valid, or undefined. */
  private async read(base: string): Promise<StoredVoice | undefined> {
    const type = EXTENSIONS.find((ext) => existsSync(`${base}.${ext}`));
    if (!type) return undefined;
    const path = `${base}.${type}`;
    try {
      const [audio, json] = await Promise.all([readFile(path), readFile(`${base}.json`, 'utf8')]);
      const info = VoiceInfoSchema.parse(JSON.parse(json));
      return { path, type, info, hash: createHash('sha256').update(audio).digest('hex') };
    } catch {
      return undefined;
    }
  }

  private check(id: string, pattern: RegExp): void {
    if (!pattern.test(id)) throw new Error(`Invalid id: ${id}`);
  }
}
