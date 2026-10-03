/**
 * Text embeddings for semantic memory search.
 *
 * Vectors are L2-normalised at creation, so cosine similarity is a plain
 * dot product. They are stored as float32 BLOBs in SQLite and searched by
 * brute force in JS: for a personal companion (a few thousand memories at
 * most) that takes well under a millisecond and needs no native vector
 * extension. Switch to sqlite-vec only if you ever reach ~100k memories.
 */

export type EmbeddingKind = 'query' | 'document';

export interface EmbeddingProvider {
  /** Identifier stored with each vector: vectors from different models are never compared. */
  readonly model: string;
  embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]>;
}

/**
 * Some embedding models were trained with task prefixes and lose quality
 * without them. Returns the prefix to prepend for a given model + kind.
 */
export function taskPrefix(model: string, kind: EmbeddingKind): string {
  const m = model.toLowerCase();
  if (m.includes('nomic')) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  if (m.includes('e5')) return kind === 'query' ? 'query: ' : 'passage: ';
  return '';
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

/** Cosine similarity of two L2-normalised vectors (= dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1; // incompatible: never "similar"
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Serialise for SQLite (copy, so the BLOB doesn't alias a larger buffer). */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy into an aligned buffer: Float32Array requires 4-byte alignment.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export interface OpenAiCompatEmbeddingsOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Embeddings through the OpenAI-compatible `/v1/embeddings` endpoint (Ollama, llama.cpp…). */
export class OpenAiCompatEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiCompatEmbeddingsOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefix = taskPrefix(this.model, kind);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers,
      // Generous: the first call may load the embedding model.
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      body: JSON.stringify({ model: this.model, input: texts.map((t) => prefix + t) }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Embedding request failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) {
      throw new Error('Embedding response has an unexpected shape');
    }
    return data.map((d) => normalize(d.embedding!));
  }
}

export interface OllamaEmbeddingsOptions {
  baseUrl: string;
  model: string;
  keepAlive: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Embeddings through Ollama's native `/api/embed` endpoint. */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OllamaEmbeddingsOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefix = taskPrefix(this.model, kind);
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      body: JSON.stringify({
        model: this.model,
        input: texts.map((t) => prefix + t),
        truncate: true, // over-long inputs are cut instead of failing
        keep_alive: this.opts.keepAlive,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Embedding request failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new Error('Embedding response has an unexpected shape');
    }
    return body.embeddings.map((v) => normalize(v));
  }
}
