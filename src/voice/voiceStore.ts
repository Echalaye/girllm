/**
 * Each character's reference voice (step 7): a short FLAC clip made by
 * Qwen3-TTS VoiceDesign, and what it says (the voice-clone model needs the
 * transcript). Plus the candidates generated in the editor, kept until the
 * user picks one (or for an hour).
 *
 *   data/voices/<characterId>.flac + <characterId>.json
 *   data/voices/candidates/<uuid>.flac + <uuid>.json
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

/** What is stored next to a clip. */
const VoiceInfoSchema = z.object({
  /** Exact words of the clip (given to the clone model as ref_text). */
  text: z.string().min(1).max(1000),
  /** The description it was designed from (shown in the editor). */
  description: z.string().max(1000),
  /** Model language the clip was made in. */
  language: z.string().max(20),
  createdAt: z.string(),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

export interface StoredVoice {
  /** Absolute path of the FLAC clip. */
  path: string;
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

  /** Store a clip as the character's voice (replaces the previous one). */
  async save(characterId: string, flac: Buffer, info: VoiceInfo): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    await mkdir(this.dir, { recursive: true });
    // Clip first, description second: get() needs both, so a crash in
    // between leaves "no voice" (made again on demand), never a mismatch.
    await rm(join(this.dir, `${characterId}.json`), { force: true });
    await writeFileAtomic(join(this.dir, `${characterId}.flac`), flac);
    await writeFileAtomic(join(this.dir, `${characterId}.json`), JSON.stringify(VoiceInfoSchema.parse(info)));
  }

  async remove(characterId: string): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    await rm(join(this.dir, `${characterId}.json`), { force: true });
    await rm(join(this.dir, `${characterId}.flac`), { force: true });
  }

  /** Keep a generated voice until the user picks one. @returns its id. */
  async addCandidate(flac: Buffer, info: VoiceInfo): Promise<string> {
    await mkdir(this.candidatesDir, { recursive: true });
    const id = randomUUID();
    await writeFileAtomic(join(this.candidatesDir, `${id}.flac`), flac);
    await writeFileAtomic(join(this.candidatesDir, `${id}.json`), JSON.stringify(VoiceInfoSchema.parse(info)));
    return id;
  }

  /** A candidate's clip path, or undefined once it expired. */
  candidatePath(candidateId: string): string | undefined {
    this.check(candidateId, CANDIDATE_ID);
    const path = join(this.candidatesDir, `${candidateId}.flac`);
    return existsSync(path) ? path : undefined;
  }

  /** Make a candidate the character's voice. @returns false if the candidate expired. */
  async promote(characterId: string, candidateId: string): Promise<boolean> {
    this.check(candidateId, CANDIDATE_ID);
    const candidate = await this.read(join(this.candidatesDir, candidateId));
    if (!candidate) return false;
    this.check(characterId, CHARACTER_ID);
    await mkdir(this.dir, { recursive: true });
    await rm(join(this.dir, `${characterId}.json`), { force: true });
    await copyFile(candidate.path, join(this.dir, `${characterId}.flac`));
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

  /** `<base>.flac` + `<base>.json`, both valid, or undefined. */
  private async read(base: string): Promise<StoredVoice | undefined> {
    const path = `${base}.flac`;
    try {
      const [flac, json] = await Promise.all([readFile(path), readFile(`${base}.json`, 'utf8')]);
      const info = VoiceInfoSchema.parse(JSON.parse(json));
      return { path, info, hash: createHash('sha256').update(flac).digest('hex') };
    } catch {
      return undefined;
    }
  }

  private check(id: string, pattern: RegExp): void {
    if (!pattern.test(id)) throw new Error(`Invalid id: ${id}`);
  }
}
