/**
 * Minimal client for the ComfyUI HTTP API:
 *   POST /prompt          queue a workflow (API format)
 *   GET  /history/{id}    poll until it is done
 *   GET  /view?...        download the resulting image
 *   POST /free            unload models / free VRAM
 *   POST /interrupt       cancel the running job
 *   GET  /object_info/... list installed checkpoints (health check)
 *
 * Polling /history (instead of the progress websocket) keeps this small and
 * dependency-free; at one request every 500 ms the overhead is negligible.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { ComfyWorkflow } from './workflow.js';

export interface ComfyClientOptions {
  /** e.g. http://127.0.0.1:8188 (no trailing slash) */
  baseUrl: string;
  /** Max time for one generation, including model loading. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Upper bound for a downloaded image (an SDXL PNG is ~1-3 MB). */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export class ComfyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComfyError';
  }
}

export class ComfyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: ComfyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
  }

  /** Is ComfyUI reachable, and which checkpoints does it have? */
  async status(): Promise<{ ok: boolean; checkpoints?: string[]; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/object_info/CheckpointLoaderSimple`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as {
        CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } };
      };
      const list = body.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      return { ok: true, checkpoints: Array.isArray(list) ? list : [] };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Run a workflow and return the first output image as PNG bytes. */
  async generate(workflow: ComfyWorkflow, signal?: AbortSignal): Promise<Buffer> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

    const promptId = await this.queue(workflow, abort);
    try {
      const entry = await this.waitForCompletion(promptId, abort);
      const image = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
      if (!image) throw new ComfyError('ComfyUI finished without producing an image');
      return await this.download(image, abort);
    } catch (err) {
      if (abort.aborted) await this.cancel(promptId);
      throw deadline.aborted ? new ComfyError('Image generation timed out') : err;
    }
  }

  /** Unload models and free VRAM so the LLM can be reloaded. */
  async free(): Promise<void> {
    await this.fetchImpl(`${this.opts.baseUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async queue(workflow: ComfyWorkflow, signal: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'girllm' }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      prompt_id?: string;
      error?: { message?: string; details?: string };
      node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }> }>;
    };
    if (!res.ok || !body.prompt_id) {
      // Surface ComfyUI's validation errors (e.g. unknown checkpoint name).
      const nodeErrors = Object.values(body.node_errors ?? {})
        .flatMap((n) => n.errors ?? [])
        .map((e) => [e.message, e.details].filter(Boolean).join(': '));
      const detail = [body.error?.message, ...nodeErrors].filter(Boolean).join(' | ');
      throw new ComfyError(`ComfyUI rejected the workflow (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return body.prompt_id;
  }

  private async waitForCompletion(promptId: string, signal: AbortSignal): Promise<HistoryEntry> {
    for (;;) {
      signal.throwIfAborted();
      const res = await this.fetchImpl(`${this.opts.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      if (res.ok) {
        const history = (await res.json()) as Record<string, HistoryEntry>;
        const entry = history[promptId];
        if (entry?.status?.status_str === 'error') {
          throw new ComfyError('ComfyUI reported an error while generating (see the ComfyUI console)');
        }
        if (entry?.status?.completed || (entry?.outputs && Object.keys(entry.outputs).length > 0)) return entry;
      }
      await sleep(this.pollIntervalMs, undefined, { signal });
    }
  }

  private async download(
    image: { filename: string; subfolder: string; type: string },
    signal: AbortSignal,
  ): Promise<Buffer> {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
    const res = await this.fetchImpl(`${this.opts.baseUrl}/view?${query.toString()}`, { signal });
    if (!res.ok) throw new ComfyError(`Cannot download the image (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new ComfyError('ComfyUI returned something that is not a PNG image');
    }
    return bytes;
  }

  /** Best effort: stop the job and remove it from the queue. */
  private async cancel(promptId: string): Promise<void> {
    const post = (path: string, body: unknown) =>
      this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    await post('/queue', { delete: [promptId] });
    await post('/interrupt', {});
  }
}
