/**
 * Installs what girllm's voice needs:
 *   1. speech-to-text: the Whisper model selected in .env (STT_MODEL), on the
 *      CPU via sherpa-onnx, downloaded into MODELS_DIR;
 *   2. her voice (step 7): Qwen3-TTS 1.7B inside ComfyUI (COMFYUI_DIR): the
 *      ComfyUI-Qwen-TTS nodes at a pinned commit, the voice-clone and
 *      voice-design models (~9 GB), and the few Python packages the nodes
 *      import that ComfyUI lacks.
 *
 *   npm run setup:voice                     -> both (Qwen3-TTS needs COMFYUI_DIR)
 *   npm run setup:voice -- --list           -> speech-to-text models
 *   npm run setup:voice -- whisper-small    -> another speech-to-text model
 *   npm run setup:voice -- --stt-only       -> skip Qwen3-TTS
 *
 * Security: only pinned URLs are downloaded. Whisper archives and model
 * weights are checked against their SHA-256 BEFORE use; Qwen3-TTS config
 * files come from a fixed Hugging Face commit. Python packages: exact
 * versions, installed only when missing.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { STT_MODELS, type SttModelId } from '../src/voice/catalog.js';
import {
  QWEN_TTS_BASE_FILES,
  QWEN_TTS_DESIGN_FILES,
  QWEN_TTS_MIN_TRANSFORMERS,
  QWEN_TTS_NODES,
  QWEN_TTS_PYTHON_PACKAGES,
  QWEN_TTS_TOKENIZER_PLACEHOLDER,
} from '../src/voice/qwenTts.js';
import {
  comfyPython,
  installModels,
  installNodePack,
  pipInstall,
  placeholderFolder,
  pythonHas,
  pythonPackageVersion,
  versionAtLeast,
} from './comfySetupLib.js';
import { download } from './downloadLib.js';
import { comfyRoot } from './launcherLib.js';

function printList(): void {
  console.log('Speech-to-text (STT_MODEL):');
  for (const [id, m] of Object.entries(STT_MODELS))
    console.log(`  ${id.padEnd(15)} ${String(m.sizeMb).padStart(4)} MB  ${m.description}`);
  console.log('\nHer voice: Qwen3-TTS 1.7B in ComfyUI (installed by default, ~9 GB).');
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

async function installStt(id: string, modelsDir: string): Promise<void> {
  if (!(id in STT_MODELS)) throw new Error(`Unknown model "${id}". Use --list to see the available ones.`);
  const m = STT_MODELS[id as SttModelId];
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

/** Python packages for the nodes: only the missing ones, exact versions. */
function installPythonPackages(installDir: string): void {
  const python = comfyPython(installDir);
  const all = [...QWEN_TTS_PYTHON_PACKAGES.map((p) => p.spec), QWEN_TTS_MIN_TRANSFORMERS.spec];
  if (!python) {
    console.log(
      '\n! Manual ComfyUI install: with the Python that runs ComfyUI, install whichever of these it lacks:\n' +
        `  python -m pip install ${all.join(' ')}`,
    );
    return;
  }
  const missing = QWEN_TTS_PYTHON_PACKAGES.filter((p) => !pythonHas(python, p.module)).map((p) => p.spec);
  const transformers = pythonPackageVersion(python, 'transformers');
  if (!transformers || !versionAtLeast(transformers, QWEN_TTS_MIN_TRANSFORMERS.min)) {
    missing.push(QWEN_TTS_MIN_TRANSFORMERS.spec);
  }
  if (!missing.length) {
    console.log('✓ Python packages already there');
    return;
  }
  pipInstall(python, missing);
  console.log('✓ Python packages installed');
}

async function installQwenTts(comfyDir: string): Promise<void> {
  const root = comfyRoot(resolve(comfyDir));
  if (!root) throw new Error(`"${comfyDir}" doesn't look like a ComfyUI install (no main.py found).`);
  console.log(`\nHer voice — Qwen3-TTS in ComfyUI: ${root}`);
  installNodePack(root, QWEN_TTS_NODES, 'Qwen3-TTS nodes');
  installPythonPackages(resolve(comfyDir));
  await installModels(root, [...QWEN_TTS_BASE_FILES, ...QWEN_TTS_DESIGN_FILES]);
  placeholderFolder(
    root,
    QWEN_TTS_TOKENIZER_PLACEHOLDER,
    'Created by girllm: the speech tokenizer is in each model folder (speech_tokenizer/).\n' +
      'This folder only stops ComfyUI-Qwen-TTS from downloading an unpinned copy.',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    printList();
    return;
  }
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--stt-only');
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')} (known: --list, --stt-only)`);

  const config = loadConfig();
  const modelsDir = resolve(config.voice.modelsDir);
  mkdirSync(modelsDir, { recursive: true });

  const ids = args.filter((a) => !a.startsWith('--'));
  for (const id of ids.length ? ids : [config.voice.sttModel]) await installStt(id, modelsDir);

  if (!args.includes('--stt-only')) {
    const comfyDir = config.images.comfyDir;
    if (!comfyDir) {
      console.log(
        '\n! Her voice needs ComfyUI: set COMFYUI_DIR in .env (your ComfyUI folder) and run npm run setup:voice again.',
      );
    } else {
      await installQwenTts(comfyDir);
    }
  }
  console.log('\nDone. Restart ComfyUI (or start.bat) so it loads the Qwen3-TTS nodes.');
  console.log('Then give each character her voice in the editor ("Her voice" → describe it → Create).');
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
