/**
 * Write a file atomically: write a temporary file next to it, then rename.
 * A crash mid-write never leaves a half-written card or setting behind.
 */
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/** @param options.mode file permissions on POSIX (e.g. 0o600 for a private key; ignored on Windows) */
export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { flag: 'wx', mode: options.mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
