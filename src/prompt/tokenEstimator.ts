/**
 * Fast token-count estimation.
 *
 * Exact counts would need each model's tokenizer; for budgeting a prompt a
 * slightly pessimistic estimate is enough and costs nothing. ~3.5 characters
 * per token is conservative for English/French with Llama/Mistral-family
 * tokenizers, so we rarely overflow the backend context window.
 *
 * TODO(step 2): optionally use the backend's /tokenize endpoint when exact
 * counts matter (llama.cpp / KoboldCpp expose one).
 */
const CHARS_PER_TOKEN = 3.5;
/** Per-message overhead of chat templates (role tags, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(content: string): number {
  return estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
}
