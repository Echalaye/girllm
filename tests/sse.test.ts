import { describe, expect, it } from 'vitest';
import { parseSseData } from '../src/llm/sse.js';

async function* chunks(...parts: string[]) {
  const enc = new TextEncoder();
  for (const p of parts) yield enc.encode(p);
}

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseSseData', () => {
  it('parses events split across chunks', async () => {
    const out = await collect(parseSseData(chunks('data: {"a"', ':1}\n\nda', 'ta: [DONE]\n\n')));
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });

  it('handles CRLF, comments and other fields', async () => {
    const out = await collect(parseSseData(chunks(': keep-alive\r\nevent: x\r\ndata: hi\r\n\r\n')));
    expect(out).toEqual(['hi']);
  });

  it('flushes a trailing event without blank line', async () => {
    expect(await collect(parseSseData(chunks('data: last')))).toEqual(['last']);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: café 💖\n\n');
    async function* split() {
      yield bytes.slice(0, 10);
      yield bytes.slice(10);
    }
    expect(await collect(parseSseData(split()))).toEqual(['café 💖']);
  });
});
