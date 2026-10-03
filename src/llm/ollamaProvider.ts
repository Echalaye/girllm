/**
 * LlmProvider using Ollama's NATIVE API (/api/chat) instead of its
 * OpenAI-compatible endpoint. Why it matters:
 *
 *  - `num_ctx` is sent with every request, so the context window always
 *    matches CONTEXT_TOKENS. The OpenAI endpoint can't set it: Ollama then
 *    uses its default and silently cuts the START of the prompt — i.e. the
 *    character card — which makes the character incoherent.
 *  - Sampling options the OpenAI endpoint ignores: `min_p`, `repeat_penalty`.
 *  - `keep_alive`: how long the model stays in VRAM, and explicit unloading
 *    (needed later to free VRAM for image generation).
 */
import { parseNdjson } from './ndjson.js';
import { LlmHttpError, type ChatMessage, type GenerationOptions, type LlmProvider } from './types.js';

export interface OllamaProviderOptions {
  /** e.g. http://127.0.0.1:11434 (no trailing slash) */
  baseUrl: string;
  model: string;
  /**
   * Context window. Must be IDENTICAL for every request: Ollama reloads the
   * model whenever num_ctx changes, so it is fixed per provider instance.
   */
  numCtx: number;
  /** Ollama duration, e.g. "30m", or "-1" to keep loaded forever. */
  keepAlive: string;
  connectTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: OllamaProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // 2 min: the first request may load the model into VRAM.
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 120_000;
  }

  async *streamChat(messages: ChatMessage[], options: GenerationOptions): AsyncGenerator<string> {
    // Only the wait for response headers is time-limited, never the generation.
    const connectTimeout = new AbortController();
    const timer = setTimeout(() => connectTimeout.abort(new Error('LLM backend connect timeout')), this.connectTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, connectTimeout.signal]) : connectTimeout.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          stream: true,
          keep_alive: this.opts.keepAlive,
          options: {
            num_ctx: this.opts.numCtx,
            num_predict: options.maxTokens,
            temperature: options.temperature,
            top_p: options.topP,
            ...(options.minP !== undefined ? { min_p: options.minP } : {}),
            ...(options.repeatPenalty !== undefined ? { repeat_penalty: options.repeatPenalty } : {}),
            ...(options.stop?.length ? { stop: options.stop } : {}),
          },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok || !response.body) {
      const text = (await response.text().catch(() => '')).slice(0, 500);
      throw new LlmHttpError(response.status, `Ollama returned ${response.status}: ${text}`);
    }

    for await (const raw of parseNdjson(response.body)) {
      const chunk = raw as ChatChunk;
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      const delta = chunk.message?.content;
      if (delta) yield delta;
      if (chunk.done) return;
    }
  }

  async ping(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Free the model's VRAM now (e.g. before running an image model). */
  async unload(): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: this.opts.model, keep_alive: 0 }),
    });
    if (!res.ok) throw new LlmHttpError(res.status, `Ollama unload failed (${res.status})`);
  }
}
