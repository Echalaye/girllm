/** Builds the LLM and embedding providers selected by LLM_PROVIDER. */
import type { AppConfig } from '../config.js';
import { OllamaEmbeddings, OpenAiCompatEmbeddings, type EmbeddingProvider } from '../memory/embeddings.js';
import { OllamaProvider } from './ollamaProvider.js';
import { OpenAiCompatProvider } from './openaiCompatProvider.js';
import type { LlmProvider } from './types.js';

export function createLlmProvider(config: AppConfig): LlmProvider {
  const { llm, generation } = config;
  return llm.provider === 'ollama'
    ? new OllamaProvider({
        baseUrl: llm.baseUrl,
        model: llm.model,
        numCtx: generation.contextTokens,
        keepAlive: llm.keepAlive,
      })
    : new OpenAiCompatProvider({ baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey });
}

/** Undefined when no embedding model is configured. */
export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider | undefined {
  const model = config.memory.embeddingModel;
  if (!model) return undefined;
  return config.llm.provider === 'ollama'
    ? new OllamaEmbeddings({ baseUrl: config.memory.embeddingBaseUrl, model, keepAlive: config.llm.keepAlive })
    : new OpenAiCompatEmbeddings({ baseUrl: config.memory.embeddingBaseUrl, model, apiKey: config.llm.apiKey });
}
