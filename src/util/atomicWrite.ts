/**
 * Write a file atomically: write a temporary file next to it, then rename.
 * A crash mid-write never leaves a half-written card or setting behind.
 */
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
