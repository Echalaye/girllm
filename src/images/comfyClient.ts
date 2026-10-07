/**
 * Minimal client for the ComfyUI HTTP API:
 *   POST /prompt          queue a workflow (API format)
 *   GET  /history/{id}    poll until it is done
 *   GET  /view?...        download the resulting image (or audio: her voice, step 7)
 *   POST /free            unload models / free VRAM
 *   POST /interrupt       cancel the running job
 *   GET  /object_info/... list installed checkpoints and custom nodes (health check)
 *   POST /upload/image    put the reference face (or voice clip) in ComfyUI's input folder
 *
 * Polling /history (instead of the progress websocket) keeps this small and
 * dependency-free; at one request every 500 ms the overhead is negligible.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { QWEN_TTS_NODE_CLASSES } from '../voice/qwenTts.js';
import { CLIP_VISION_MODEL, FACE_IPADAPTER_MODEL } from './ipAdapter.js';
import type { ComfyWorkflow } from './workflow.js';

export interface ComfyClientOptions {
  /** e.g. http://127.0.0.1:8188 (no trailing slash) */
  baseUrl: string;
  /** Max time for one generation, including model loading. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  /** SaveImage outputs `images`, SaveAudio outputs `audio`. */
  outputs?: Record<string, { images?: OutputFile[]; audio?: OutputFile[] }>;
}

/** What a job produces, how it is recognised, and how big it may be. */
const OUTPUT_KINDS = {
  // An SDXL / FLUX PNG is ~1-3 MB.
  image: {
    key: 'images',
    signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    maxBytes: 30 << 20,
    label: 'a PNG image',
  },
  // FLAC, 24 kHz mono: ~0.1 MB per second of speech; 2.7 minutes max.
  audio: { key: 'audio', signature: Buffer.from('fLaC', 'ascii'), maxBytes: 50 << 20, label: 'a FLAC audio file' },
} as const;
type OutputKind = keyof typeof OUTPUT_KINDS;

/** Upload content types accepted by uploadFile. */
export type UploadType = 'image/png' | 'image/jpeg' | 'audio/flac' | 'audio/wav';

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

  /**
   * Can ComfyUI apply a reference face? (IP-Adapter nodes + both models)
   * The reason says what to install when it can't.
   */
  async faceSupport(): Promise<{ ready: boolean; reason?: string }> {
    const setup = 'run: npm run setup:images, then restart ComfyUI';
    const advanced = await this.nodeInputs('IPAdapterAdvanced');
    if (!advanced) return { ready: false, reason: `IP-Adapter nodes not installed (${setup})` };
    // Refuse a version of the nodes whose inputs differ from what the workflow sends.
    const expected = ['model', 'ipadapter', 'image', 'weight', 'weight_type', 'start_at', 'end_at', 'embeds_scaling'];
    const missing = expected.filter((k) => !(k in advanced));
    if (missing.length)
      return { ready: false, reason: `unexpected IP-Adapter nodes version (missing ${missing.join(', ')})` };
    const ipadapters = (await this.nodeInputs('IPAdapterModelLoader'))?.ipadapter_file?.[0];
    if (!Array.isArray(ipadapters) || !ipadapters.includes(FACE_IPADAPTER_MODEL.file)) {
      return { ready: false, reason: `${FACE_IPADAPTER_MODEL.file} not found (${setup})` };
    }
    const clips = (await this.nodeInputs('CLIPVisionLoader'))?.clip_name?.[0];
    if (!Array.isArray(clips) || !clips.includes(CLIP_VISION_MODEL.file)) {
      return { ready: false, reason: `${CLIP_VISION_MODEL.file} not found (${setup})` };
    }
    return { ready: true };
  }

  /**
   * Files a loader node can pick (e.g. `UNETLoader`, `unet_name`), or [] when
   * the node or ComfyUI is unavailable.
   */
  async modelFiles(nodeClass: string, input: string): Promise<string[]> {
    const list = (await this.nodeInputs(nodeClass))?.[input]?.[0];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  }

  /**
   * Can ComfyUI run FLUX.2 [klein]? Needs a recent ComfyUI (FLUX.2 nodes)
   * and the three model files. The reason says what is missing.
   */
  async flux2Support(files: {
    model: string;
    textEncoder: string;
    vae: string;
  }): Promise<{ ready: boolean; reason?: string }> {
    if (!(await this.nodeInputs('EmptyFlux2LatentImage')) || !(await this.nodeInputs('ReferenceLatent'))) {
      return { ready: false, reason: 'this ComfyUI is too old for FLUX.2 (update ComfyUI)' };
    }
    const checks: Array<[string, string, string]> = [
      ['UNETLoader', 'unet_name', files.model],
      ['CLIPLoader', 'clip_name', files.textEncoder],
      ['VAELoader', 'vae_name', files.vae],
    ];
    for (const [node, input, file] of checks) {
      if (!(await this.modelFiles(node, input)).includes(file)) {
        return { ready: false, reason: `${file} not found (run: npm run setup:images -- --flux2-klein)` };
      }
    }
    return { ready: true };
  }

  /**
   * Can ComfyUI speak with Qwen3-TTS? (the two nodes, in the version the
   * workflows were written for, plus core LoadAudio / SaveAudio). The model
   * files can't be listed over HTTP: a missing one shows up as a job error.
   */
  async qwenTtsSupport(): Promise<{ ready: boolean; reason?: string }> {
    const setup = 'run: npm run setup:voice, then restart ComfyUI';
    const expected: Record<string, string[]> = {
      [QWEN_TTS_NODE_CLASSES.clone]: [
        'target_text',
        'ref_audio',
        'ref_text',
        'language',
        'unload_model_after_generate',
      ],
      [QWEN_TTS_NODE_CLASSES.design]: ['text', 'instruct', 'language', 'unload_model_after_generate'],
    };
    for (const [node, inputs] of Object.entries(expected)) {
      const info = await this.nodeInputs(node);
      if (!info) return { ready: false, reason: `Qwen3-TTS nodes not installed (${setup})` };
      const missing = inputs.filter((k) => !(k in info));
      if (missing.length)
        return { ready: false, reason: `unexpected Qwen3-TTS nodes version (missing ${missing.join(', ')})` };
    }
    if (!(await this.nodeInputs('LoadAudio')) || !(await this.nodeInputs('SaveAudio'))) {
      return { ready: false, reason: 'this ComfyUI has no audio nodes (update ComfyUI)' };
    }
    return { ready: true };
  }

  /**
   * Upload an image into ComfyUI's input folder (overwriting a file with the
   * same name). @returns the name to give to a LoadImage node.
   */
  uploadImage(bytes: Buffer, fileName: string, type: 'image/png' | 'image/jpeg'): Promise<string> {
    return this.uploadFile(bytes, fileName, type);
  }

  /**
   * Upload a file into ComfyUI's input folder (overwriting a file with the
   * same name). ComfyUI's /upload/image endpoint takes audio too (its own
   * page uploads audio there). @returns the name for LoadImage / LoadAudio.
   */
  async uploadFile(bytes: Buffer, fileName: string, type: UploadType): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type }), fileName);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await this.fetchImpl(`${this.opts.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new ComfyError(
        `ComfyUI refused the uploaded ${type.startsWith('audio') ? 'voice clip' : 'reference face'} (${res.status})`,
      );
    const body = (await res.json().catch(() => ({}))) as { name?: string; subfolder?: string };
    if (!body.name) throw new ComfyError('ComfyUI did not return the uploaded file name');
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  /** Required + optional inputs of a node class, or undefined if the node isn't installed. */
  private async nodeInputs(nodeClass: string): Promise<Record<string, unknown[]> | undefined> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/object_info/${encodeURIComponent(nodeClass)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as Record<
        string,
        { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } } | undefined
      >;
      const info = body[nodeClass];
      return info ? { ...(info.input?.required ?? {}), ...(info.input?.optional ?? {}) } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Run a workflow and return the first output image as PNG bytes. */
  generate(workflow: ComfyWorkflow, signal?: AbortSignal): Promise<Buffer> {
    return this.run(workflow, 'image', signal);
  }

  /** Run a workflow and return the first output audio as FLAC bytes (SaveAudio). */
  generateAudio(workflow: ComfyWorkflow, signal?: AbortSignal): Promise<Buffer> {
    return this.run(workflow, 'audio', signal);
  }

  private async run(workflow: ComfyWorkflow, kind: OutputKind, signal?: AbortSignal): Promise<Buffer> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const { key } = OUTPUT_KINDS[kind];

    const promptId = await this.queue(workflow, abort);
    try {
      const entry = await this.waitForCompletion(promptId, abort);
      const file = Object.values(entry.outputs ?? {}).flatMap((o) => o[key] ?? [])[0];
      if (!file) throw new ComfyError(`ComfyUI finished without producing ${kind === 'image' ? 'an image' : 'audio'}`);
      return await this.download(file, kind, abort);
    } catch (err) {
      if (abort.aborted) await this.cancel(promptId);
      throw deadline.aborted ? new ComfyError(`${kind === 'image' ? 'Image' : 'Voice'} generation timed out`) : err;
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

  /** Download an output file and check it is what was expected (magic bytes, size). */
  private async download(file: OutputFile, kind: OutputKind, signal: AbortSignal): Promise<Buffer> {
    const { signature, maxBytes, label } = OUTPUT_KINDS[kind];
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await this.fetchImpl(`${this.opts.baseUrl}/view?${query.toString()}`, { signal });
    if (!res.ok) throw new ComfyError(`Cannot download the ${kind} (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes || !bytes.subarray(0, signature.length).equals(signature)) {
      throw new ComfyError(`ComfyUI returned something that is not ${label}`);
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
