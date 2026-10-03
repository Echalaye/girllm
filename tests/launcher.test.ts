import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { comfyCommand, isLocalUrl, isStale, waitUntilUp } from '../scripts/launcherLib.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'girllm-launch-'));

describe('comfyCommand', () => {
  it('detects the Windows portable layout', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'python_embeded'));
    mkdirSync(join(dir, 'ComfyUI'));
    writeFileSync(join(dir, 'python_embeded', 'python.exe'), '');
    writeFileSync(join(dir, 'ComfyUI', 'main.py'), '');
    const cmd = comfyCommand(dir, 8188, 'win32')!;
    expect(cmd.command).toBe(join(dir, 'python_embeded', 'python.exe'));
    expect(cmd.args).toEqual(
      expect.arrayContaining(['--windows-standalone-build', '--disable-auto-launch', '--listen', '127.0.0.1']),
    );
    expect(cmd.cwd).toBe(dir);
  });

  it('detects a manual install and rejects other folders', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'main.py'), '');
    expect(comfyCommand(dir, 9000, 'linux')).toMatchObject({
      command: 'python3',
      args: ['main.py', '--listen', '127.0.0.1', '--port', '9000', '--disable-auto-launch'],
    });
    expect(comfyCommand(dir, 9000, 'win32')!.command).toBe('python');
    expect(comfyCommand(tmp(), 8188)).toBeUndefined();
  });
});

describe('isStale', () => {
  it('compares the newest source file with the build output', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
    const src = join(dir, 'src', 'sub', 'a.ts');
    const out = join(dir, 'index.js');
    writeFileSync(src, '');
    expect(isStale(join(dir, 'src'), out)).toBe(true); // no build yet
    writeFileSync(out, '');
    utimesSync(src, new Date(1000), new Date(1000));
    utimesSync(out, new Date(2000), new Date(2000));
    expect(isStale(join(dir, 'src'), out)).toBe(false);
    utimesSync(src, new Date(3000), new Date(3000));
    expect(isStale(join(dir, 'src'), out)).toBe(true);
  });
});

describe('waitUntilUp / isLocalUrl', () => {
  it('polls until the service answers', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await waitUntilUp('http://x', 1000, { intervalMs: 1, fetchImpl })).toBe(true);
    expect(calls).toBe(3);
  });

  it('stops early when the process died, or times out', async () => {
    const down = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await waitUntilUp('http://x', 5000, { intervalMs: 1, fetchImpl: down, stillRunning: () => false })).toBe(
      false,
    );
    expect(await waitUntilUp('http://x', 20, { intervalMs: 5, fetchImpl: down })).toBe(false);
  });

  it('only treats loopback URLs as local', () => {
    expect(isLocalUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalUrl('http://localhost:8188')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:11434')).toBe(false);
  });
});
