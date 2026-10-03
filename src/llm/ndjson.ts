/**
 * Newline-delimited JSON stream parser (Ollama's native streaming format:
 * one JSON object per line). Handles lines split across network chunks.
 */
export async function* parseNdjson(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON line from backend: ${line.slice(0, 120)}`);
    }
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield parseLine(line);
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield parseLine(rest);
}
