/**
 * Persistent long-term memories ("facts") per character, with semantic
 * search over their embeddings.
 */
import { randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { Db } from '../db/database.js';
import { cosine, fromBlob, toBlob } from './embeddings.js';

export const MEMORY_CATEGORIES = ['user', 'character', 'relationship', 'event'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface Memory {
  id: string;
  characterId: string;
  category: MemoryCategory;
  content: string;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  characterId: string;
  category: MemoryCategory;
  content: string;
  embedding?: Float32Array | undefined;
  embeddingModel?: string | undefined;
  sourceSessionId?: string | null | undefined;
}

export interface ScoredMemory extends Memory {
  score: number;
}

interface MemoryRow {
  id: string;
  character_id: string;
  category: MemoryCategory;
  content: string;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  embedding?: Uint8Array | null;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  characterId: r.character_id,
  category: r.category,
  content: r.content,
  sourceSessionId: r.source_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS = 'id, character_id, category, content, source_session_id, created_at, updated_at';

export class MemoryStore {
  private readonly stmt: Record<string, StatementSync>;

  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stmt = {
      insert: db.prepare(`
        INSERT INTO memories (id, character_id, category, content, embedding, embedding_model,
                              source_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM sessions WHERE id = ?), ?, ?)`),
      list: db.prepare(`SELECT ${COLUMNS} FROM memories WHERE character_id = ? ORDER BY updated_at DESC LIMIT ?`),
      withEmbeddings: db.prepare(
        `SELECT ${COLUMNS}, embedding FROM memories WHERE character_id = ? AND embedding_model = ? AND embedding IS NOT NULL`,
      ),
      get: db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`),
      delete: db.prepare('DELETE FROM memories WHERE id = ?'),
      deleteByCharacter: db.prepare('DELETE FROM memories WHERE character_id = ?'),
      touch: db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?'),
      findExact: db.prepare(
        `SELECT ${COLUMNS} FROM memories WHERE character_id = ? AND lower(trim(content)) = lower(trim(?)) LIMIT 1`,
      ),
      count: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE character_id = ?'),
    };
  }

  add(m: NewMemory): Memory {
    const id = randomUUID();
    const ts = this.now().toISOString();
    // The sub-select stores NULL if the source session no longer exists
    // (deleted while a background job was running) instead of failing the FK.
    this.stmt.insert!.run(
      id,
      m.characterId,
      m.category,
      m.content,
      m.embedding ? toBlob(m.embedding) : null,
      m.embedding ? (m.embeddingModel ?? null) : null,
      m.sourceSessionId ?? null,
      ts,
      ts,
    );
    return this.get(id)!;
  }

  get(id: string): Memory | undefined {
    const row = this.stmt.get!.get(id) as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }

  /** Most recently created/confirmed memories first. */
  list(characterId: string, limit = 500): Memory[] {
    return (this.stmt.list!.all(characterId, limit) as unknown as MemoryRow[]).map(toMemory);
  }

  count(characterId: string): number {
    return (this.stmt.count!.get(characterId) as { n: number }).n;
  }

  delete(id: string): boolean {
    return Number(this.stmt.delete!.run(id).changes) > 0;
  }

  /** Forget everything about a character. @returns how many memories were deleted. */
  deleteByCharacter(characterId: string): number {
    return Number(this.stmt.deleteByCharacter!.run(characterId).changes);
  }

  /** Mark a memory as re-confirmed (it was mentioned again). */
  touch(id: string): void {
    this.stmt.touch!.run(this.now().toISOString(), id);
  }

  findExact(characterId: string, content: string): Memory | undefined {
    const row = this.stmt.findExact!.get(characterId, content) as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }

  /**
   * Top-k memories by cosine similarity to `query` (brute force, see
   * embeddings.ts for why that is fine at this scale).
   */
  search(characterId: string, query: Float32Array, model: string, k: number): ScoredMemory[] {
    const rows = this.stmt.withEmbeddings!.all(characterId, model) as unknown as MemoryRow[];
    return rows
      .map((r) => ({ ...toMemory(r), score: cosine(query, fromBlob(r.embedding!)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
