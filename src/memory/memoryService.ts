/**
 * Orchestrates the memory system:
 *
 *  - before a reply: `buildContext` gathers the running summary, the
 *    character's mood and the long-term memories most relevant to the
 *    user's latest message (semantic search, recency fallback);
 *  - after a reply: `schedule` queues background jobs that fold old
 *    messages into the summary and extract new facts.
 *
 * Background jobs never block the chat: they run after the reply was
 * streamed, sequentially per character, and their failures are only logged.
 */
import type { CharacterRepository } from '../characters/characterRepository.js';
import type { Session, SessionStore, StoredMessage } from '../chat/sessionStore.js';
import type { LlmProvider } from '../llm/types.js';
import { estimateTokens } from '../prompt/tokenEstimator.js';
import { SerialQueue } from '../util/serialQueue.js';
import type { EmbeddingProvider } from './embeddings.js';
import { extractFacts } from './factExtractor.js';
import type { Memory, MemoryCategory, MemoryStore } from './memoryStore.js';
import { selectMessagesToSummarize, summarize, type SummaryPolicy } from './summarizer.js';

export interface MemoryServiceOptions {
  userName: string;
  replyLanguage?: string | undefined;
  summaryPolicy: SummaryPolicy;
  /** Max memories injected in the prompt. */
  topK: number;
  /** Token cap for the injected memories block. */
  memoryTokenBudget: number;
  /** Extract facts once at least this many new messages are pending. */
  extractEvery: number;
  /** Cosine similarity above which a new fact is considered a duplicate. */
  duplicateThreshold: number;
  /** Minimum similarity for a memory to count as relevant. */
  minRelevance: number;
}

export interface MemoryContext {
  summary: string;
  mood: string;
  memories: string[];
}

export interface MemoryLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** Messages per extraction batch (bounds the helper prompt size). */
const EXTRACTION_BATCH = 12;
/** Safety bound on summary iterations per job (large imported backlogs). */
const MAX_SUMMARY_ROUNDS = 5;
/** Known facts shown to the extractor to avoid repeats. */
const KNOWN_FACTS_IN_PROMPT = 40;
/** Query text cap for embedding. */
const QUERY_MAX_CHARS = 1000;

export class MemoryService {
  private readonly queue = new SerialQueue();
  private lastEmbeddingWarning = 0;

  constructor(
    private readonly sessions: SessionStore,
    private readonly characters: CharacterRepository,
    private readonly store: MemoryStore,
    private readonly llm: LlmProvider,
    private readonly embeddings: EmbeddingProvider | undefined,
    private readonly log: MemoryLogger,
    private readonly opts: MemoryServiceOptions,
  ) {}

  // ---------------------------------------------------------------- read path

  /** Gather what the character "remembers" for the next reply. */
  async buildContext(session: Session): Promise<MemoryContext> {
    const memories = await this.retrieve(session.characterId, buildQuery(session.messages));
    return { summary: session.summary, mood: session.mood, memories };
  }

  /**
   * Relevant memories first (semantic search), then the most recent ones to
   * fill the remaining slots, within the token budget.
   */
  private async retrieve(characterId: string, query: string): Promise<string[]> {
    const picked = new Map<string, Memory>();

    if (this.embeddings && query) {
      const vector = await this.embedSafely(query, 'query');
      if (vector) {
        for (const m of this.store.search(characterId, vector, this.embeddings.model, this.opts.topK)) {
          if (m.score >= this.opts.minRelevance) picked.set(m.id, m);
        }
      }
    }
    for (const m of this.store.list(characterId, this.opts.topK * 2)) {
      if (picked.size >= this.opts.topK) break;
      picked.set(m.id, m);
    }

    const result: string[] = [];
    let used = 0;
    for (const m of picked.values()) {
      const cost = estimateTokens(m.content) + 2;
      if (used + cost > this.opts.memoryTokenBudget) break;
      result.push(m.content);
      used += cost;
    }
    return result;
  }

  // --------------------------------------------------------------- write path

  /** Queue background memory jobs for a session (fire-and-forget). */
  schedule(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    void this.queue.enqueue(
      session.characterId,
      () => this.runJobs(sessionId),
      (err) => {
        this.log.warn({ err, sessionId }, 'memory job failed');
      },
    );
  }

  /** Wait for queued jobs (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** Summarize then extract facts. Public for tests. */
  async runJobs(sessionId: string): Promise<void> {
    await this.updateSummary(sessionId);
    await this.extract(sessionId);
  }

  private async updateSummary(sessionId: string): Promise<void> {
    for (let round = 0; round < MAX_SUMMARY_ROUNDS; round++) {
      const ctx = this.load(sessionId);
      if (!ctx) return;
      const { session, charName } = ctx;

      const unsummarized = session.messages.filter((m) => m.seq > session.summarizedUntil);
      const batch = selectMessagesToSummarize(unsummarized, this.opts.summaryPolicy);
      if (batch.length === 0) return;

      const summary = await summarize(this.llm, {
        previousSummary: session.summary,
        messages: batch,
        charName,
        userName: this.opts.userName,
        language: this.opts.replyLanguage,
      });
      this.sessions.updateMemoryState(sessionId, { summary, summarizedUntil: batch.at(-1)!.seq });
      this.log.info({ sessionId, messages: batch.length }, 'conversation summary updated');
    }
  }

  private async extract(sessionId: string): Promise<void> {
    const ctx = this.load(sessionId);
    if (!ctx) return;
    const { session, charName } = ctx;

    // The latest reply may still be regenerated ("swiped"): don't learn from it yet.
    const eligible = session.messages.filter((m) => m.seq > session.factsExtractedUntil);
    if (eligible.at(-1)?.role === 'assistant') eligible.pop();
    if (eligible.length < this.opts.extractEvery) return;

    for (let i = 0; i < eligible.length; i += EXTRACTION_BATCH) {
      const batch = eligible.slice(i, i + EXTRACTION_BATCH);
      const known = this.store.list(session.characterId, KNOWN_FACTS_IN_PROMPT).map((m) => m.content);
      const result = await extractFacts(this.llm, {
        messages: batch,
        charName,
        userName: this.opts.userName,
        knownFacts: known,
        language: this.opts.replyLanguage,
      });

      let added = 0;
      for (const fact of result.facts) {
        if (await this.remember(session.characterId, fact.category, fact.content, sessionId)) added++;
      }
      this.sessions.updateMemoryState(sessionId, {
        factsExtractedUntil: batch.at(-1)!.seq,
        ...(result.mood ? { mood: result.mood } : {}),
      });
      if (added) this.log.info({ sessionId, added }, 'new memories stored');
    }
  }

  /**
   * Store a fact unless it is a duplicate (exact text, or semantically
   * near-identical). Duplicates refresh the existing memory's recency.
   * @returns the stored memory, or undefined if it was a duplicate.
   */
  async remember(
    characterId: string,
    category: MemoryCategory,
    content: string,
    sourceSessionId: string | null = null,
  ): Promise<Memory | undefined> {
    const exact = this.store.findExact(characterId, content);
    if (exact) {
      this.store.touch(exact.id);
      return undefined;
    }

    const embedding = this.embeddings ? await this.embedSafely(content, 'document') : undefined;
    if (embedding && this.embeddings) {
      const [nearest] = this.store.search(characterId, embedding, this.embeddings.model, 1);
      if (nearest && nearest.score >= this.opts.duplicateThreshold) {
        this.store.touch(nearest.id);
        return undefined;
      }
    }

    return this.store.add({
      characterId,
      category,
      content,
      embedding,
      embeddingModel: this.embeddings?.model,
      sourceSessionId,
    });
  }

  // ----------------------------------------------------------------- helpers

  private load(sessionId: string): { session: Session; charName: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined; // deleted meanwhile
    const character = this.characters.get(session.characterId);
    if (!character) return undefined; // card removed from the folder
    return { session, charName: character.name };
  }

  /** Embedding failures degrade to recency-only memory instead of breaking the chat. */
  private async embedSafely(text: string, kind: 'query' | 'document'): Promise<Float32Array | undefined> {
    try {
      const [vector] = await this.embeddings!.embed([text], kind);
      return vector;
    } catch (err) {
      const now = Date.now();
      if (now - this.lastEmbeddingWarning > 60_000) {
        this.lastEmbeddingWarning = now;
        this.log.warn(
          { err: (err as Error).message },
          `embeddings unavailable (is "${this.embeddings!.model}" pulled?) — using recent memories only`,
        );
      }
      return undefined;
    }
  }
}

/** Search query: the user's latest message plus the reply it answers. */
export function buildQuery(messages: readonly StoredMessage[]): string {
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  if (lastUser === -1) return '';
  const previous = messages[lastUser - 1];
  const text = [previous?.role === 'assistant' ? previous.content : '', messages[lastUser]!.content]
    .filter(Boolean)
    .join('\n');
  return text.slice(-QUERY_MAX_CHARS);
}
