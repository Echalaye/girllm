/** Shared test fixtures. */
import type { Character } from '../src/characters/schema.js';
import { SqliteSessionStore } from '../src/chat/sqliteSessionStore.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { normalize, type EmbeddingProvider } from '../src/memory/embeddings.js';
import type { ChatMessage, GenerationOptions, LlmProvider } from '../src/llm/types.js';

export function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'aria',
    sourceFile: 'aria.json',
    name: 'Aria',
    description: '{{char}} is an illustrator dating {{user}}.',
    personality: 'playful',
    scenario: '',
    first_mes: 'Hi {{user}}!',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    creator_notes: '',
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    appearance: '',
    style: 'roleplay',
    voice: undefined,
    ...overrides,
  };
}

/** Fake LLM yielding scripted chunks; records the last request. */
export class FakeLlm implements LlmProvider {
  lastMessages: ChatMessage[] = [];
  lastOptions: GenerationOptions | undefined;

  constructor(
    private readonly chunks: string[] = ['Hello', ' there'],
    private readonly delayMs = 0,
  ) {}

  async *streamChat(messages: ChatMessage[], options: GenerationOptions): AsyncGenerator<string> {
    this.lastMessages = messages;
    this.lastOptions = options;
    for (const c of this.chunks) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield c;
    }
  }

  async ping() {
    return { ok: true, models: ['fake'] };
  }
}

/** Fresh in-memory SQLite database + session store. */
export function makeStore(): { db: Db; store: SqliteSessionStore } {
  const db = openDatabase(':memory:');
  return { db, store: new SqliteSessionStore(db) };
}

/**
 * Fake LLM that answers according to the kind of request, recognised from
 * the system prompt: summaries, fact extraction, or normal chat.
 */
export class ScriptedLlm implements LlmProvider {
  calls: ChatMessage[][] = [];
  constructor(public script: { chat?: string; summary?: string; extraction?: string; photo?: string } = {}) {}

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
    this.calls.push(messages);
    const system = messages[0]?.content ?? '';
    if (system.includes('about to send a photo')) {
      yield this.script.photo ??
        '{"caption": "*sourit* Voilà !", "scene": "selfie, smiling, cozy living room, warm lamp light"}';
      return;
    }
    if (system.includes('running summary')) yield this.script.summary ?? 'They talked.';
    else if (system.includes('extract long-term memories')) yield this.script.extraction ?? '{"facts": [], "mood": ""}';
    else yield this.script.chat ?? 'ok';
  }

  async ping() {
    return { ok: true };
  }

  unloads = 0;
  async unload() {
    this.unloads++;
  }

  callsOfKind(kind: 'summary' | 'extraction' | 'chat'): ChatMessage[][] {
    return this.calls.filter((c) => {
      const s = c[0]?.content ?? '';
      if (kind === 'summary') return s.includes('running summary');
      if (kind === 'extraction') return s.includes('extract long-term memories');
      return !s.includes('running summary') && !s.includes('extract long-term memories');
    });
  }
}

/**
 * Deterministic bag-of-words embeddings: texts sharing words get similar
 * vectors, which is enough to test search and de-duplication.
 */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly model = 'fake-embed';
  calls = 0;
  fail = false;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.fail) throw new Error('embedding backend down');
    return texts.map((t) => {
      const v = new Array<number>(64).fill(0);
      for (const word of t.toLowerCase().match(/[a-z\u00e0-\u00ff]+/g) ?? []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 64]! += 1;
      }
      return normalize(v);
    });
  }
}

/** Smallest valid PNG header + IEND, enough for signature checks. */
export const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
);

/** In-memory fake of the ComfyUI HTTP API, as a fetch implementation. */
export class FakeComfy {
  queued: Array<{ prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }> = [];
  freed = 0;
  cancelled: string[] = [];
  /** Number of /history polls before the job is reported done. */
  pollsBeforeDone = 1;
  failWith: 'node_error' | 'execution' | 'not_png' | null = null;
  checkpoints = ['sdxl.safetensors'];
  /** IP-Adapter install state (step 4d). */
  ipAdapter = {
    nodes: true,
    ipadapterFiles: ['ip-adapter-plus-face_sdxl_vit-h.safetensors'],
    clipFiles: ['CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'],
  };
  uploads: Array<{ name: string; size: number }> = [];
  private polls = 0;

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname === '/object_info/CheckpointLoaderSimple') {
      return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [this.checkpoints] } } } });
    }
    if (url.pathname === '/object_info/IPAdapterAdvanced') {
      if (!this.ipAdapter.nodes) return json({});
      const required = Object.fromEntries(
        [
          'model',
          'ipadapter',
          'image',
          'weight',
          'weight_type',
          'combine_embeds',
          'start_at',
          'end_at',
          'embeds_scaling',
        ].map((k) => [k, ['X']]),
      );
      return json({ IPAdapterAdvanced: { input: { required, optional: { clip_vision: ['CLIP_VISION'] } } } });
    }
    if (url.pathname === '/object_info/IPAdapterModelLoader') {
      return json(
        this.ipAdapter.nodes
          ? { IPAdapterModelLoader: { input: { required: { ipadapter_file: [this.ipAdapter.ipadapterFiles] } } } }
          : {},
      );
    }
    if (url.pathname === '/object_info/CLIPVisionLoader') {
      return json({ CLIPVisionLoader: { input: { required: { clip_name: [this.ipAdapter.clipFiles] } } } });
    }
    if (url.pathname === '/upload/image') {
      const form = init?.body as FormData;
      const file = form.get('image') as File;
      this.uploads.push({ name: file.name, size: file.size });
      return json({ name: file.name, subfolder: '', type: 'input' });
    }
    if (url.pathname === '/prompt') {
      if (this.failWith === 'node_error') {
        return json(
          {
            error: { message: 'Prompt outputs failed validation' },
            node_errors: { '1': { errors: [{ message: 'Value not in list', details: 'ckpt_name: nope' }] } },
          },
          400,
        );
      }
      this.queued.push(JSON.parse(init?.body as string));
      return json({ prompt_id: 'p1', number: 1 });
    }
    if (url.pathname === '/history/p1') {
      init?.signal?.throwIfAborted();
      if (this.polls++ < this.pollsBeforeDone) return json({});
      if (this.failWith === 'execution') return json({ p1: { status: { status_str: 'error', completed: false } } });
      return json({
        p1: {
          status: { status_str: 'success', completed: true },
          outputs: { '7': { images: [{ filename: 'girllm_0001.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (url.pathname === '/view') {
      return new Response(this.failWith === 'not_png' ? Buffer.from('<html>') : TINY_PNG);
    }
    if (url.pathname === '/free') {
      this.freed++;
      return json({});
    }
    if (url.pathname === '/queue' || url.pathname === '/interrupt') {
      this.cancelled.push(url.pathname);
      return json({});
    }
    return json({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;
}
