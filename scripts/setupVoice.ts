/**
 * Downloads the voice models selected in .env (STT_MODEL, TTS_VOICE) into
 * MODELS_DIR.
 *
 *   npm run setup:voice              -> models selected in .env
 *   npm run setup:voice -- --list    -> show every available model/voice
 *   npm run setup:voice -- fr-tom whisper-small   -> specific ones
 *
 * Security: only the pinned URLs of src/voice/catalog.ts are downloaded,
 * and each archive's SHA-256 is verified BEFORE it is extracted.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { STT_MODELS, TTS_VOICES, type ModelArchive } from '../src/voice/catalog.js';

const CATALOG: Record<string, ModelArchive & { description: string }> = { ...STT_MODELS, ...TTS_VOICES };

function printList(): void {
  console.log('Speech-to-text (STT_MODEL):');
  for (const [id, m] of Object.entries(STT_MODELS)) console.log(`  ${id.padEnd(15)} ${String(m.sizeMb).padStart(4)} MB  ${m.description}`);
  console.log('Voices (TTS_VOICE):');
  for (const [id, v] of Object.entries(TTS_VOICES)) console.log(`  ${id.padEnd(15)} ${String(v.sizeMb).padStart(4)} MB  ${v.description}`);
}

/** Download `url` to `dest`, hashing on the fly, with a progress line. */
async function download(url: string, dest: string, expectedSha256: string): Promise<void> {
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
      const now = Date.now();
      if (now - lastPrint > 500) {
        lastPrint = now;
        const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : '';
        process.stdout.write(`\r    ${(received / 1e6).toFixed(0)} MB${pct}   `);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(dest));
  process.stdout.write('\n');

  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    await rm(dest, { force: true });
    throw new Error(`Checksum mismatch for ${url}\n  expected ${expectedSha256}\n  got      ${actual}\nNothing was extracted.`);
  }
}

/** Extract a .tar.bz2 with the system tar (built into Windows 10+, macOS, Linux). */
function extract(archive: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xjf', archive], { cwd, stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`Cannot run tar: ${err.message}`)));
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with code ${code}`))));
  });
}

async function install(id: string, modelsDir: string): Promise<void> {
  const m = CATALOG[id];
  if (!m) throw new Error(`Unknown model "${id}". Use --list to see the available ones.`);
  const target = join(modelsDir, m.dir);
  if (existsSync(target)) {
    console.log(`✓ ${id} already installed (${target})`);
    return;
  }
  console.log(`↓ ${id} (${m.sizeMb} MB) — ${m.description}`);
  const archive = join(modelsDir, `${m.dir}.tar.bz2.part`);
  await download(m.url, archive, m.sha256);
  // Extract into a temp dir then rename: an interrupted extraction never
  // leaves a half-installed model that would look "installed".
  const staging = join(modelsDir, `.staging-${m.dir}`);
  await rm(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await extract(archive, staging);
    await rename(join(staging, m.dir), target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
  console.log(`✓ ${id} installed`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) return printList();

  const config = loadConfig();
  const modelsDir = resolve(config.voice.modelsDir);
  mkdirSync(modelsDir, { recursive: true });

  const ids = args.length ? args : [config.voice.sttModel, config.voice.ttsVoice];
  // Voices sharing an archive (fr-jessica / fr-pierre) are handled by the "already installed" check.
  for (const id of ids) await install(id, modelsDir);
  console.log(`\nDone. Models are in ${modelsDir}`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
