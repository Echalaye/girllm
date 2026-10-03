/**
 * Minimal Server-Sent Events parser for OpenAI-style streaming responses.
 *
 * Handles events split across network chunks and both \n and \r\n line
 * endings. Only `data:` fields are relevant for chat completions, so other
 * fields (event, id, retry) and comments are ignored.
 */
export async function* parseSseData(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);

      if (line === '') {
        // Blank line = end of event.
        if (dataLines.length > 0) {
          yield dataLines.join('\n');
          dataLines = [];
        }
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // Other fields / ":" comments are intentionally ignored.
    }
  }

  // Flush a final event that wasn't followed by a blank line.
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
  if (dataLines.length > 0) yield dataLines.join('\n');
}
