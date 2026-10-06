/**
 * Installs the image models girllm uses into ComfyUI:
 *   1. consistent faces (IP-Adapter Plus Face, step 4d): the
 *      ComfyUI_IPAdapter_plus custom nodes at a pinned commit, the CLIP-ViT-H
 *      vision model (~2.5 GB) and the SDXL face IP-Adapter (~850 MB);
 *   2. the face detector of the face detail pass (step 6, 1.6 MB, into
 *      MODELS_DIR: it runs in girllm, not in ComfyUI);
 *   3. optional checkpoints:
 *        --anime       Animagine XL 4.0 Opt (~6.9 GB), for anime characters;
 *        --juggernaut  Juggernaut XI (~7.1 GB), realistic, best for full bodies;
 *        --flux2-klein FLUX.2 [klein] 4B: model fp8 + Qwen3 4B text encoder + VAE
 *                      (~12.5 GB), for the image test bench (needs a recent ComfyUI);
 *        --flux2-klein-base  its undistilled model (+4.1 GB; same encoder and VAE):
 *                      slower, but with a real negative prompt.
 * Every file is verified against a pinned SHA-256 before it is moved into
 * place.
 *
 *   npm run setup:images                      -> uses COMFYUI_DIR from .env
 *   npm run setup:images -- --anime --juggernaut
 *   npm run setup:images -- "D:\ComfyUI_windows_portable" --anime
 *
 * Nothing already installed is modified. Restart ComfyUI afterwards.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ANIME_MODEL } from '../src/images/artStyle.js';
import { FACE_DETECTOR_MODEL, faceDetectorPath } from '../src/images/faceDetector.js';
import { FLUX2_KLEIN_BASE_MODEL, FLUX2_KLEIN_MODEL } from '../src/images/flux2Workflow.js';
import { JUGGERNAUT_MODEL, OPTIONAL_MODELS } from '../src/images/presets.js';
import { IPADAPTER_MODELS, IPADAPTER_NODES } from '../src/images/ipAdapter.js';
import { installModels, installNodePack } from './comfySetupLib.js';
import { download } from './downloadLib.js';
import { comfyRoot } from './launcherLib.js';

/** The face detail pass detector runs in girllm itself: it goes to MODELS_DIR. */
async function installFaceDetector(modelsDir: string): Promise<void> {
  const dest = faceDetectorPath(modelsDir);
  if (existsSync(dest)) {
    console.log(`✓ face detector already installed`);
    return;
  }
  mkdirSync(join(modelsDir, FACE_DETECTOR_MODEL.dir), { recursive: true });
  console.log(`↓ face detector (${FACE_DETECTOR_MODEL.sizeMb} MB) → ${dest}`);
  const part = `${dest}.part`;
  await download(FACE_DETECTOR_MODEL.url, part, FACE_DETECTOR_MODEL.sha256);
  await rename(part, dest);
  console.log('✓ face detector installed (checksum verified)');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith('--') && !(a in OPTIONAL_MODELS));
  if (unknown.length)
    throw new Error(`Unknown option ${unknown.join(', ')} (known: ${Object.keys(OPTIONAL_MODELS).join(', ')})`);
  const config = loadConfig();
  const arg = args.find((a) => !a.startsWith('--'));
  const dir = arg ?? config.images.comfyDir;
  if (!dir) {
    throw new Error(
      'Set COMFYUI_DIR in .env (your ComfyUI folder), or pass it: npm run setup:images -- "C:\\path\\to\\ComfyUI"',
    );
  }
  const root = comfyRoot(resolve(dir));
  if (!root) throw new Error(`"${dir}" doesn't look like a ComfyUI install (no main.py found).`);
  console.log(`ComfyUI: ${root}\n`);

  const optional = args.filter((a) => a in OPTIONAL_MODELS).flatMap((a) => OPTIONAL_MODELS[a]!);
  installNodePack(root, IPADAPTER_NODES, 'IP-Adapter nodes');
  await installModels(root, [...IPADAPTER_MODELS, ...optional]);
  await installFaceDetector(resolve(config.voice.modelsDir));

  console.log('\nDone. Restart ComfyUI (or start.bat) so it loads the IP-Adapter nodes.');
  console.log('Then give your characters a reference face in the editor: their photos will keep that face.');
  if (optional.includes(ANIME_MODEL))
    console.log(`Anime characters use ${ANIME_MODEL.file} (Settings → Anime characters).`);
  else console.log('For anime characters: npm run setup:images -- --anime');
  const flux = optional.includes(FLUX2_KLEIN_MODEL) || optional.includes(FLUX2_KLEIN_BASE_MODEL);
  if (optional.includes(JUGGERNAUT_MODEL) || flux) {
    console.log('Compare the new model(s) with your current one: npm run compare:images');
  }
  if (flux) {
    console.log('FLUX.2 [klein] needs a recent ComfyUI: update it if the bench says it is too old.');
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
