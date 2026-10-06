/**
 * Verified downloads for the setup scripts (voice models, image models).
 *
 * The file is streamed to disk while its SHA-256 is computed; a mismatch
 * deletes it and throws, so a corrupted or tampered download is never used.
 * `null` is only for small config files whose URL is already pinned to an
 * immutable commit (Hugging Face `resolve/<commit>/…`).
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Unhashed (commit-pinned) files are small configs: anything bigger is refused. */
export const MAX_UNHASHED_BYTES = 10 * 1024 * 1024;

/** Download `url` to `dest`, hashing on the fly, with a progress line. */
export async function download(url: string, dest: string, expectedSha256: string | null): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  let received = 0;
  let lastPrint = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      if (expectedSha256 === null && received > MAX_UNHASHED_BYTES) {
        cb(new Error(`${url} is larger than expected for a config file (> 10 MB): refused`));
        return;
      }
      const now = Date.now();
      if (now - lastPrint > 500) {
        lastPrint = now;
        const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : '';
        process.stdout.write(`\r    ${(received / 1e6).toFixed(0)} MB${pct}   `);
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest));
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  }
  process.stdout.write('\n');

  const actual = hash.digest('hex');
  if (expectedSha256 !== null && actual !== expectedSha256) {
    await rm(dest, { force: true });
    throw new Error(
      `Checksum mismatch for ${url}\n  expected ${expectedSha256}\n  got      ${actual}\nThe file was deleted.`,
    );
  }
}
