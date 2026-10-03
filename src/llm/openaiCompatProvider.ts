/**
 * LlmProvider for any server exposing the OpenAI Chat Completions API:
 * Ollama (/v1), llama.cpp server, KoboldCpp, LM Studio, vLLM…
 */
import { parseSseData } from './sse.js';
import { LlmHttpError, type ChatMessage, type GenerationOptions, type LlmProvider } from './types.js';

export interface OpenAiCompatOptions {
  /** Base URL without the `/v1` suffix, e.g. http://127.0.0.1:11434 */
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Max time to wait for response headers (model loading can be slow). */
  connectTimeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Shape of one streamed chunk; only the fields we read are typed. */
interface CompletionChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string } | string;
}

export class OpenAiCompatProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // 2 min: the first request after start may load a ~7 GB model into VRAM.
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 120_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async *streamChat(messages: ChatMessage[], options: GenerationOptions): AsyncGenerator<string> {
    // The connect timeout must only cover "waiting for headers", not the
    // whole (potentially long) generation, hence a separate controller.
    const connectTimeout = new AbortController();
    const timer = setTimeout(() => connectTimeout.abort(new Error('LLM backend connect timeout')), this.connectTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, connectTimeout.signal])
      : connectTimeout.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          stream: true,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          top_p: options.topP,
          // Non-standard but understood by llama.cpp server and KoboldCpp.
          ...(options.minP !== undefined ? { min_p: options.minP } : {}),
          ...(options.repeatPenalty !== undefined ? { repeat_penalty: options.repeatPenalty } : {}),
          ...(options.stop?.length ? { stop: options.stop } : {}),
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok || !response.body) {
      // Never forward the full backend body: it may be huge; keep it short.
      const text = (await response.text().catch(() => '')).slice(0, 500);
      throw new LlmHttpError(response.status, `LLM backend returned ${response.status}: ${text}`);
    }

    for await (const data of parseSseData(response.body)) {
      if (data === '[DONE]') return;

      let chunk: CompletionChunk;
      try {
        chunk = JSON.parse(data) as CompletionChunk;
      } catch {
        continue; // Ignore malformed keep-alive / non-JSON lines.
      }
      if (chunk.error) {
        const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'unknown');
        throw new Error(`LLM backend error: ${msg}`);
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async ping(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
