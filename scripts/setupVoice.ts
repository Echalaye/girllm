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
import { existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { download } from './downloadLib.js';
import { loadConfig } from '../src/config.js';
import { STT_MODELS, TTS_VOICES, type ModelArchive } from '../src/voice/catalog.js';

const CATALOG: Record<string, ModelArchive & { description: string }> = { ...STT_MODELS, ...TTS_VOICES };

function printList(): void {
  console.log('Speech-to-text (STT_MODEL):');
  for (const [id, m] of Object.entries(STT_MODELS))
    console.log(`  ${id.padEnd(15)} ${String(m.sizeMb).padStart(4)} MB  ${m.description}`);
  console.log('Voices (TTS_VOICE):');
  for (const [id, v] of Object.entries(TTS_VOICES))
    console.log(`  ${id.padEnd(15)} ${String(v.sizeMb).padStart(4)} MB  ${v.description}`);
}

/** Extract a .tar.bz2 with the system tar (built into Windows 10+, macOS, Linux). */
function extract(archive: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xjf', archive], { cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      reject(new Error(`Cannot run tar: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`tar exited with code ${String(code)}`));
    });
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
  if (args.includes('--list')) {
    printList();
    return;
  }

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
