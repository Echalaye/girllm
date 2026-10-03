/**
 * Decorators that make every LLM / embedding call pass through the
 * GpuGate, so they pause while an image is being generated.
 */
import type { EmbeddingKind, EmbeddingProvider } from '../memory/embeddings.js';
import type { GpuGate } from '../util/gpuGate.js';
import type { ChatMessage, GenerationOptions, LlmProvider } from './types.js';

export class GatedLlmProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly gate: GpuGate,
  ) {}

  async *streamChat(messages: ChatMessage[], options: GenerationOptions): AsyncGenerator<string> {
    const leave = await this.gate.enterShared();
    try {
      yield* this.inner.streamChat(messages, options);
    } finally {
      leave(); // also runs if the consumer stops early (abort / break)
    }
  }

  ping() {
    return this.inner.ping();
  }

  async unload(): Promise<void> {
    await this.inner.unload?.();
  }
}

export class GatedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly gate: GpuGate,
  ) {}

  get model() {
    return this.inner.model;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    const leave = await this.gate.enterShared();
    try {
      return await this.inner.embed(texts, kind);
    } finally {
      leave();
    }
  }
}
