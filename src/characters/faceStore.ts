/**
 * Reference face of each character (data/faces/<id>.png|jpg), plus the
 * temporary portrait candidates generated in the editor.
 *
 * Every path is built from a validated id (character slug or UUID), never
 * from client input, so nothing can escape the faces folder.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../util/atomicWrite.js';
import type { ImageType, SanitizedImage } from '../images/imageSanitizer.js';

const CHARACTER_ID = /^[a-z0-9-]{1,80}$/;
const CANDIDATE_ID = /^[0-9a-f-]{36}$/;
const EXTENSIONS: Record<ImageType, string> = { png: 'png', jpeg: 'jpg' };

export interface FaceFile {
  path: string;
  type: ImageType;
}

export class FaceStore {
  private readonly dir: string;
  private readonly candidatesDir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.candidatesDir = join(this.dir, 'candidates');
  }

  /** The character's face file, if any. */
  get(characterId: string): FaceFile | undefined {
    this.check(characterId, CHARACTER_ID);
    for (const type of ['png', 'jpeg'] as const) {
      const path = join(this.dir, `${characterId}.${EXTENSIONS[type]}`);
      if (existsSync(path)) return { path, type };
    }
    return undefined;
  }

  /** Store an already-sanitized image as the character's face (replaces any previous one). */
  async save(characterId: string, image: SanitizedImage): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    await mkdir(this.dir, { recursive: true });
    await this.remove(characterId);
    await writeFileAtomic(join(this.dir, `${characterId}.${EXTENSIONS[image.type]}`), image.bytes);
  }

  async remove(characterId: string): Promise<void> {
    this.check(characterId, CHARACTER_ID);
    await Promise.all(
      Object.values(EXTENSIONS).map((ext) => rm(join(this.dir, `${characterId}.${ext}`), { force: true })),
    );
  }

  /** Keep a generated portrait until the user picks one. @returns its id. */
  async addCandidate(png: Buffer): Promise<string> {
    await mkdir(this.candidatesDir, { recursive: true });
    const id = randomUUID();
    await writeFileAtomic(join(this.candidatesDir, `${id}.png`), png);
    return id;
  }

  candidatePath(candidateId: string): string | undefined {
    this.check(candidateId, CANDIDATE_ID);
    const path = join(this.candidatesDir, `${candidateId}.png`);
    return existsSync(path) ? path : undefined;
  }

  /** Make a candidate the character's face. @returns false if the candidate expired. */
  async promote(characterId: string, candidateId: string): Promise<boolean> {
    const source = this.candidatePath(candidateId);
    if (!source) return false;
    await this.remove(characterId);
    await copyFile(source, join(this.dir, `${characterId}.png`));
    await rm(source, { force: true });
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

  private check(id: string, pattern: RegExp): void {
    if (!pattern.test(id)) throw new Error(`Invalid id: ${id}`);
  }
}
