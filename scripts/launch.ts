/**
 * One-click launcher (used by start.bat):
 *
 *   1. Ollama   — started with `ollama serve` if it isn't running yet
 *   2. ComfyUI  — started from COMFYUI_DIR if photos are configured
 *   3. girllm   — rebuilt if the sources changed, then started
 *   4. browser  — opened on the app once it answers (skip with --no-browser)
 *
 * Ctrl+C (or closing girllm) stops what THIS launcher started; services
 * that were already running are left alone.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { comfyCommand, isLocalUrl, isStale, isUp, waitUntilUp } from './launcherLib.js';

const ROOT = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const started: Array<{ name: string; child: ChildProcess }> = [];

const log = (msg: string) => {
  console.log(`[launcher] ${msg}`);
};

/** Kill a process and its children (ComfyUI spawns Python workers). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function stopAll(): void {
  for (const { name, child } of started.reverse()) {
    // Skip processes that never started (spawn error) or already exited.
    if (child.pid === undefined || child.exitCode !== null) continue;
    log(`stopping ${name}`);
    killTree(child);
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = isWindows
    ? ['cmd', ['/c', 'start', '', url]] // '' = empty window title (Node quotes it as "")
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

async function ensureOllama(baseUrl: string): Promise<void> {
  if (await isUp(`${baseUrl}/api/tags`)) {
    log('Ollama is already running');
    return;
  }
  if (!isLocalUrl(baseUrl)) {
    log(`Ollama at ${baseUrl} is not reachable (remote: not started by the launcher)`);
    return;
  }

  log('starting Ollama…');
  const child = spawn('ollama', ['serve'], { stdio: 'ignore', windowsHide: true });
  let failed = false;
  child.on('error', () => (failed = true)); // e.g. "ollama" not installed / not in PATH
  started.push({ name: 'Ollama', child });
  if (!(await waitUntilUp(`${baseUrl}/api/tags`, 30_000, { stillRunning: () => !failed && child.exitCode === null }))) {
    throw new Error('Ollama did not start. Is it installed? (https://ollama.com/download)');
  }
  log('Ollama is ready');
}

async function ensureComfy(url: string, dir: string | undefined, logsDir: string): Promise<void> {
  if (await isUp(`${url}/system_stats`)) {
    log('ComfyUI is already running');
    return;
  }
  if (!dir) {
    log('ComfyUI is not running (set COMFYUI_DIR in .env to start it automatically)');
    return;
  }
  if (!isLocalUrl(url)) {
    log(`ComfyUI at ${url} is not reachable (remote: not started by the launcher)`);
    return;
  }

  const cmd = comfyCommand(resolve(dir), Number(new URL(url).port || 8188));
  if (!cmd) {
    log(`COMFYUI_DIR="${dir}" doesn't look like a ComfyUI install: photos stay off`);
    return;
  }

  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, 'comfyui.log');
  log(`starting ComfyUI (log: ${logFile})…`);
  const out = createWriteStream(logFile, { flags: 'w' });
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, windowsHide: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  started.push({ name: 'ComfyUI', child });
  // First start can take a while (Python imports, custom nodes).
  if (await waitUntilUp(`${url}/system_stats`, 180_000, { stillRunning: () => child.exitCode === null })) {
    log('ComfyUI is ready');
  } else {
    log(`ComfyUI did not start: photos stay off for now (see ${logFile})`);
  }
}

function buildIfNeeded(): void {
  if (!isStale(join(ROOT, 'src'), join(ROOT, 'dist', 'index.js'))) return;
  log('building girllm…');
  const npm = isWindows ? 'npm.cmd' : 'npm';
  // shell is required to run .cmd files on Windows (Node >= 20 security change).
  const result = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) throw new Error('Build failed (see the errors above)');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const openBrowserAtEnd = !process.argv.includes('--no-browser');

  if (config.llm.provider === 'ollama') await ensureOllama(config.llm.baseUrl);
  if (config.images.enabled && config.images.checkpoint) {
    await ensureComfy(config.images.comfyUrl, config.images.comfyDir, join(resolve(config.databasePath, '..'), 'logs'));
  }

  buildIfNeeded();
  const appUrl = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  if (await isUp(`${appUrl}/api/health`))
    throw new Error(`Something is already running on ${appUrl} (girllm already open?)`);

  log('starting girllm…');
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'dist', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  started.push({ name: 'girllm', child: app });

  app.on('exit', (code) => {
    // girllm stopped (Ctrl+C or crash): stop the rest and exit with its code.
    started.splice(
      started.findIndex((s) => s.child === app),
      1,
    );
    stopAll();
    process.exit(code ?? 0);
  });

  if (await waitUntilUp(`${appUrl}/api/health`, 60_000, { stillRunning: () => app.exitCode === null })) {
    log(`girllm is ready: ${appUrl}  (Ctrl+C to stop everything)`);
    if (openBrowserAtEnd) openBrowser(appUrl);
  }
}

// Ctrl+C reaches every process of the console; girllm shuts down gracefully
// and its 'exit' handler above stops the other services.
process.on('SIGINT', () => {
  log('stopping…');
});

main().catch((err: unknown) => {
  console.error(`[launcher] ✗ ${err instanceof Error ? err.message : String(err)}`);
  stopAll();
  process.exit(1);
});

export {};
