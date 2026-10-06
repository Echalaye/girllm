/**
 * Shared steps of the setup scripts that install things into ComfyUI
 * (setup:images, setup:voice): custom node packs at a pinned git commit,
 * verified model files, and the Python packages those nodes import.
 *
 * Nothing already installed is modified: an existing node folder or model
 * file is left as it is, and only Python packages that are MISSING are
 * installed (exact versions), so ComfyUI's own environment is not changed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { download } from './downloadLib.js';

/** A custom node pack pinned to one git commit. */
export interface NodePack {
  repo: string;
  commit: string;
  /** Folder name in ComfyUI/custom_nodes. */
  folder: string;
}

/** A model file for ComfyUI/models (sha256 null = pinned by the commit in its URL). */
export interface ModelFile {
  folder: string;
  file: string;
  url: string;
  sha256: string | null;
  sizeMb: number;
}

/** Run git; returns its trimmed output, or throws with its error output. */
export function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(`git is required (https://git-scm.com/download): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Clone a node pack into ComfyUI/custom_nodes at its pinned commit. Cloned
 * into a staging folder first, then renamed: an interrupted install never
 * leaves a half-cloned node.
 */
export function installNodePack(root: string, pack: NodePack, label: string): void {
  const target = join(root, 'custom_nodes', pack.folder);
  if (existsSync(target)) {
    let head = '';
    try {
      head = git(['rev-parse', 'HEAD'], target);
    } catch {
      /* not a git checkout (e.g. installed from a zip): leave it alone */
    }
    const note =
      head && head !== pack.commit ? ` (at ${head.slice(0, 7)}, tested with ${pack.commit.slice(0, 7)})` : '';
    console.log(`✓ ${label} already installed${note}`);
    return;
  }
  console.log(`↓ ${label} (${pack.repo} @ ${pack.commit.slice(0, 7)})`);
  const staging = `${target}.girllm-staging`;
  rmSync(staging, { recursive: true, force: true });
  try {
    git(['clone', '--quiet', pack.repo, staging]);
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', pack.commit], staging);
    if (git(['rev-parse', 'HEAD'], staging) !== pack.commit) throw new Error('pinned commit not checked out');
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  renameSync(staging, target); // atomic on the same volume
  console.log(`✓ ${label} installed`);
}

/** Download model files into ComfyUI/models (verified, then moved into place). */
export async function installModels(root: string, models: readonly ModelFile[]): Promise<void> {
  for (const m of models) {
    const dir = join(root, 'models', m.folder);
    const dest = join(dir, m.file);
    const name = `${m.folder}/${m.file}`;
    if (existsSync(dest)) {
      console.log(`✓ ${name} already installed`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    console.log(`↓ ${name} (${m.sizeMb} MB)`);
    const part = `${dest}.part`;
    await download(m.url, part, m.sha256);
    await rename(part, dest);
    console.log(`✓ ${name} installed${m.sha256 ? ' (checksum verified)' : ' (pinned commit)'}`);
  }
}

/** Create a folder with a README in it (used to stop a node from downloading something). */
export function placeholderFolder(root: string, folder: string, note: string): void {
  const dir = join(root, 'models', folder);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README-girllm.txt'), `${note}\n`);
}

/**
 * The Python of a ComfyUI install folder: the embedded one of the Windows
 * portable build. Undefined for a manual install (its Python may be a venv
 * we can't guess: the setup prints the pip command instead of running it).
 */
export function comfyPython(installDir: string): string | undefined {
  const embedded = join(installDir, 'python_embeded', 'python.exe');
  return existsSync(embedded) ? embedded : undefined;
}

/** Can this Python import `module`? */
export function pythonHas(python: string, module: string): boolean {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(module)) throw new Error(`Invalid module name: ${module}`);
  return spawnSync(python, ['-s', '-c', `import ${module}`], { stdio: 'ignore' }).status === 0;
}

/** Version of an installed distribution, or undefined. */
export function pythonPackageVersion(python: string, distribution: string): string | undefined {
  if (!/^[a-z0-9_.-]+$/i.test(distribution)) throw new Error(`Invalid package name: ${distribution}`);
  const result = spawnSync(
    python,
    ['-s', '-c', `import importlib.metadata as m; print(m.version(${JSON.stringify(distribution)}))`],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Compare dotted versions numerically ("4.57.3" vs "4.9"); pre-release suffixes are ignored. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** pip install exact specs into this Python (no user site, no cache surprises). */
export function pipInstall(python: string, specs: readonly string[]): void {
  if (!specs.length) return;
  for (const spec of specs) {
    // Exact pins only: "name==1.2.3".
    if (!/^[a-z0-9_.-]+==[0-9][0-9a-z.]*$/i.test(spec)) throw new Error(`Refusing unpinned package spec: ${spec}`);
  }
  console.log(`↓ Python packages: ${specs.join(' ')}`);
  const result = spawnSync(python, ['-s', '-m', 'pip', 'install', '--no-warn-script-location', ...specs], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`pip install failed (${specs.join(' ')})`);
}
