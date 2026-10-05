/**
 * Installs the image models girllm uses into ComfyUI:
 *   1. consistent faces (IP-Adapter Plus Face, step 4d): the
 *      ComfyUI_IPAdapter_plus custom nodes at a pinned commit, the CLIP-ViT-H
 *      vision model (~2.5 GB) and the SDXL face IP-Adapter (~850 MB);
 *   2. with --anime (step 5): Animagine XL 4.0 Opt (~6.9 GB), the model used
 *      for anime characters.
 * Every file is verified against a pinned SHA-256 before it is moved into
 * ComfyUI/models.
 *
 *   npm run setup:images                      -> uses COMFYUI_DIR from .env
 *   npm run setup:images -- --anime           -> also the anime model
 *   npm run setup:images -- "D:\ComfyUI_windows_portable" --anime
 *
 * Nothing already installed is modified. Restart ComfyUI afterwards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ANIME_MODEL } from '../src/images/artStyle.js';
import { IPADAPTER_MODELS, IPADAPTER_NODES, type ComfyModelFile } from '../src/images/ipAdapter.js';
import { download } from './downloadLib.js';
import { comfyRoot } from './launcherLib.js';

/** Run git; returns its trimmed output, or throws with its error output. */
function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(`git is required (https://git-scm.com/download): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

function installNodes(root: string): void {
  const target = join(root, 'custom_nodes', IPADAPTER_NODES.folder);
  if (existsSync(target)) {
    let head = '';
    try {
      head = git(['rev-parse', 'HEAD'], target);
    } catch {
      /* not a git checkout (e.g. installed from a zip): leave it alone */
    }
    const note =
      head && head !== IPADAPTER_NODES.commit
        ? ` (at ${head.slice(0, 7)}, tested with ${IPADAPTER_NODES.commit.slice(0, 7)})`
        : '';
    console.log(`✓ IP-Adapter nodes already installed${note}`);
    return;
  }
  console.log(`↓ IP-Adapter nodes (${IPADAPTER_NODES.repo} @ ${IPADAPTER_NODES.commit.slice(0, 7)})`);
  // Clone into a temporary folder, check out the pinned commit, then move
  // into place: an interrupted install never leaves a half-cloned node.
  const staging = `${target}.girllm-staging`;
  rmSync(staging, { recursive: true, force: true });
  try {
    git(['clone', '--quiet', IPADAPTER_NODES.repo, staging]);
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', IPADAPTER_NODES.commit], staging);
    if (git(['rev-parse', 'HEAD'], staging) !== IPADAPTER_NODES.commit)
      throw new Error('pinned commit not checked out');
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  renameSync(staging, target); // atomic on the same volume
  console.log('✓ IP-Adapter nodes installed');
}

async function installModels(root: string, models: readonly ComfyModelFile[]): Promise<void> {
  for (const m of models) {
    const dir = join(root, 'models', m.folder);
    const dest = join(dir, m.file);
    if (existsSync(dest)) {
      console.log(`✓ ${m.file} already installed`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    console.log(`↓ ${m.file} (${m.sizeMb} MB) → models/${m.folder}`);
    const part = `${dest}.part`;
    await download(m.url, part, m.sha256);
    await rename(part, dest);
    console.log(`✓ ${m.file} installed (checksum verified)`);
  }
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const dir = arg ?? loadConfig().images.comfyDir;
  if (!dir) {
    throw new Error(
      'Set COMFYUI_DIR in .env (your ComfyUI folder), or pass it: npm run setup:images -- "C:\\path\\to\\ComfyUI"',
    );
  }
  const root = comfyRoot(resolve(dir));
  if (!root) throw new Error(`"${dir}" doesn't look like a ComfyUI install (no main.py found).`);
  console.log(`ComfyUI: ${root}\n`);

  const anime = process.argv.includes('--anime');
  installNodes(root);
  await installModels(root, anime ? [...IPADAPTER_MODELS, ANIME_MODEL] : IPADAPTER_MODELS);
  console.log('\nDone. Restart ComfyUI (or start.bat) so it loads the IP-Adapter nodes.');
  console.log('Then give your characters a reference face in the editor: their photos will keep that face.');
  if (anime) console.log(`Anime characters use ${ANIME_MODEL.file} (Settings → Anime characters).`);
  else console.log('For anime characters, run: npm run setup:images -- --anime');
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
