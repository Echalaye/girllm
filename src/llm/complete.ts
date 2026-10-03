/** Non-streaming helper: run a chat request and return the full text. */
import type { ChatMessage, GenerationOptions, LlmProvider } from './types.js';

export async function complete(llm: LlmProvider, messages: ChatMessage[], options: GenerationOptions): Promise<string> {
  let text = '';
  for await (const delta of llm.streamChat(messages, options)) text += delta;
  return text.trim();
}
