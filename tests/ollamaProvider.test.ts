import { describe, expect, it } from 'vitest';
import { parseNdjson } from '../src/llm/ndjson.js';
import { OllamaProvider } from '../src/llm/ollamaProvider.js';
import { LlmHttpError } from '../src/llm/types.js';
import { OllamaEmbeddings } from '../src/memory/embeddings.js';

/** fetch stub recording requests and replying with a streamed body. */
function fakeFetch(respond: (url: string, body: any) => { status?: number; chunks?: string[]; json?: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const r = respond(String(url), body);
    if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const ch of r.chunks ?? []) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(stream, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseNdjson', () => {
  it('parses objects split across chunks and a final line without newline', async () => {
    async function* src() {
      const e = new TextEncoder();
      yield e.encode('{"a":1}\n{"b"');
      yield e.encode(':2}\n\n{"c":3}');
    }
    expect(await collect(parseNdjson(src()))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe('OllamaProvider', () => {
  const opts = { baseUrl: 'http://ollama', model: 'nemo', numCtx: 8192, keepAlive: '30m' };

  it('streams /api/chat and always sends num_ctx + sampling options', async () => {
    const { impl, calls } = fakeFetch(() => ({
      chunks: ['{"message":{"content":"Bon"},"done":false}\n{"message":{"content":"jour"},"done":false}\n', '{"done":true}\n'],
    }));
    const p = new OllamaProvider({ ...opts, fetchImpl: impl });
    const out = await collect(
      p.streamChat([{ role: 'user', content: 'hi' }], { maxTokens: 100, temperature: 0.7, topP: 0.9, minP: 0.05, repeatPenalty: 1.1, stop: ['\nU:'] }),
    );
    expect(out.join('')).toBe('Bonjour');
    expect(calls[0]!.url).toBe('http://ollama/api/chat');
    expect(calls[0]!.body).toMatchObject({
      model: 'nemo',
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: 8192, num_predict: 100, temperature: 0.7, top_p: 0.9, min_p: 0.05, repeat_penalty: 1.1, stop: ['\nU:'] },
    });
  });

  it('omits optional sampling options when not provided', async () => {
    const { impl, calls } = fakeFetch(() => ({ chunks: ['{"done":true}\n'] }));
    await collect(new OllamaProvider({ ...opts, fetchImpl: impl }).streamChat([], { maxTokens: 10, temperature: 0.2, topP: 0.9 }));
    expect(calls[0]!.body.options).not.toHaveProperty('min_p');
    expect(calls[0]!.body.options.num_ctx).toBe(8192);
  });

  it('surfaces HTTP and streamed errors', async () => {
    const http = fakeFetch(() => ({ status: 404, chunks: ['{"error":"model not found"}'] }));
    await expect(collect(new OllamaProvider({ ...opts, fetchImpl: http.impl }).streamChat([], { maxTokens: 1, temperature: 0, topP: 1 }))).rejects.toBeInstanceOf(LlmHttpError);
    const streamed = fakeFetch(() => ({ chunks: ['{"error":"out of memory"}\n'] }));
    await expect(collect(new OllamaProvider({ ...opts, fetchImpl: streamed.impl }).streamChat([], { maxTokens: 1, temperature: 0, topP: 1 }))).rejects.toThrow(/out of memory/);
  });

  it('lists models with ping and unloads with keep_alive 0', async () => {
    const { impl, calls } = fakeFetch((url) => (url.endsWith('/api/tags') ? { json: { models: [{ name: 'nemo:latest' }] } } : { json: {} }));
    const p = new OllamaProvider({ ...opts, fetchImpl: impl });
    expect(await p.ping()).toEqual({ ok: true, models: ['nemo:latest'] });
    await p.unload();
    expect(calls[1]).toEqual({ url: 'http://ollama/api/generate', body: { model: 'nemo', keep_alive: 0 } });
  });
});

describe('OllamaEmbeddings', () => {
  it('calls /api/embed, applies task prefixes and normalises', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { embeddings: [[3, 4]] } }));
    const e = new OllamaEmbeddings({ baseUrl: 'http://ollama', model: 'nomic-embed-text', keepAlive: '30m', fetchImpl: impl });
    const [v] = await e.embed(['chat'], 'query');
    expect(Array.from(v!)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(calls[0]!.body).toMatchObject({ model: 'nomic-embed-text', input: ['search_query: chat'], truncate: true });
  });

  it('rejects malformed responses', async () => {
    const { impl } = fakeFetch(() => ({ json: { embeddings: [] } }));
    const e = new OllamaEmbeddings({ baseUrl: 'http://ollama', model: 'm', keepAlive: '30m', fetchImpl: impl });
    await expect(e.embed(['a'], 'document')).rejects.toThrow(/unexpected shape/);
  });
});
