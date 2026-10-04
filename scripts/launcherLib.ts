/**
 * Pure / easily testable helpers for the one-click launcher (scripts/launch.ts).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Command {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * How to start ComfyUI from its install folder.
 *  - Windows portable: <dir>/python_embeded/python.exe + <dir>/ComfyUI/main.py
 *  - Manual (git) install: <dir>/main.py with the system Python
 * @returns undefined if the folder doesn't look like a ComfyUI install.
 */
export function comfyCommand(
  dir: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): Command | undefined {
  const flags = ['--listen', '127.0.0.1', '--port', String(port), '--disable-auto-launch'];
  const embedded = join(dir, 'python_embeded', 'python.exe');
  if (existsSync(embedded) && existsSync(join(dir, 'ComfyUI', 'main.py'))) {
    return {
      command: embedded,
      args: ['-s', join('ComfyUI', 'main.py'), '--windows-standalone-build', ...flags],
      cwd: dir,
    };
  }
  if (existsSync(join(dir, 'main.py'))) {
    return { command: platform === 'win32' ? 'python' : 'python3', args: ['main.py', ...flags], cwd: dir };
  }
  return undefined;
}

/**
 * The ComfyUI application folder (the one with main.py, custom_nodes/ and
 * models/) inside an install folder: <dir>/ComfyUI for the Windows portable
 * build, <dir> itself for a manual install.
 * @returns undefined if the folder doesn't look like a ComfyUI install.
 */
export function comfyRoot(dir: string): string | undefined {
  if (existsSync(join(dir, 'ComfyUI', 'main.py'))) return join(dir, 'ComfyUI');
  if (existsSync(join(dir, 'main.py'))) return dir;
  return undefined;
}

/** Newest modification time (ms) of the files under `dir` (recursive). */
export function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** True if `output` is missing or older than any source file. */
export function isStale(sourceDir: string, output: string): boolean {
  if (!existsSync(output)) return true;
  return newestMtime(sourceDir) > statSync(output).mtimeMs;
}

/** Is `url` answering (any HTTP status < 500) within 2 s? */
export async function isUp(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Poll `url` until it answers or `timeoutMs` elapses.
 * @param stillRunning optional check: stop early if the process died.
 */
export async function waitUntilUp(
  url: string,
  timeoutMs: number,
  {
    stillRunning = () => true,
    intervalMs = 500,
    fetchImpl = fetch,
  }: { stillRunning?: () => boolean; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url, fetchImpl)) return true;
    if (!stillRunning()) return false;
    await sleep(intervalMs);
  }
  return false;
}

/** Is this URL served by the local machine? (we only start local services) */
export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}
