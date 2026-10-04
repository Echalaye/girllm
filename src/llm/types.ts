/**
 * Backend-agnostic LLM abstractions.
 *
 * The rest of the app only depends on `LlmProvider`, so switching from
 * Ollama to llama.cpp server, KoboldCpp or LM Studio is a config change,
 * and adding a non-OpenAI backend is a new class — nothing else moves.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerationOptions {
  maxTokens: number;
  temperature: number;
  topP: number;
  /**
   * Min-p sampling: drop tokens whose probability is below minP × that of
   * the most likely token. Very effective against incoherent tangents while
   * keeping creativity. Ignored by backends that don't support it.
   */
  minP?: number;
  /** Penalise recently used tokens (>1 = less repetition). */
  repeatPenalty?: number;
  /** Strings that end generation (e.g. "\nEtienne:" to stop the model speaking for the user). */
  stop?: string[];
  /** Aborts the request (client disconnected, user pressed "stop"…). */
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Stream the assistant reply as text deltas. */
  streamChat(messages: ChatMessage[], options: GenerationOptions): AsyncIterable<string>;
  /** Cheap reachability check used by the /api/health endpoint. */
  ping(): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  /**
   * Free a model's VRAM now (optional: only some backends support it).
   * @param model defaults to the current model.
   */
  unload?(model?: string): Promise<void>;
}

/** Error raised for non-2xx backend responses, carrying the HTTP status. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}
