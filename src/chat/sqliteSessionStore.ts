/**
 * SQLite-backed SessionStore. All statements are prepared once and use
 * bound parameters (no SQL string building with user data).
 */
import { randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { transaction, type Db } from '../db/database.js';
import {
  SessionNotFoundError,
  type Session,
  type SessionListItem,
  type SessionMemoryState,
  type NewMessageOptions,
  type SessionStore,
  type StoredMessage,
} from './sessionStore.js';

/** Max length of the auto-generated chat title. */
const TITLE_MAX_CHARS = 60;

interface SessionRow {
  id: string;
  character_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  summary: string;
  summarized_until: number;
  facts_extracted_until: number;
  mood: string;
}

interface MessageRow {
  seq: number;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image_id: string | null;
  kind: StoredMessage['kind'];
  created_at: string;
}

const toMessage = (r: MessageRow): StoredMessage => ({
  seq: r.seq,
  id: r.id,
  role: r.role,
  content: r.content,
  imageId: r.image_id,
  kind: r.kind,
  createdAt: r.created_at,
});

/** Build a short chat title from the first user message. */
export function makeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > TITLE_MAX_CHARS ? `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…` : oneLine;
}

export class SqliteSessionStore implements SessionStore {
  private readonly stmt: Record<string, StatementSync>;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stmt = {
      insertSession: db.prepare('INSERT INTO sessions (id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?)'),
      getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
      getMessages: db.prepare(
        'SELECT seq, id, role, content, image_id, kind, created_at FROM messages WHERE session_id = ? ORDER BY seq',
      ),
      list: db.prepare(`
        SELECT s.id, s.character_id, s.title, s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
        FROM sessions s WHERE s.character_id = ?
        ORDER BY s.updated_at DESC LIMIT ?`),
      deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
      idsByCharacter: db.prepare('SELECT id FROM sessions WHERE character_id = ?'),
      insertMessage: db.prepare(
        'INSERT INTO messages (id, session_id, role, content, image_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      setImage: db.prepare('UPDATE messages SET image_id = ? WHERE id = ?'),
      touch: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
      setTitleIfEmpty: db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL'),
      lastMessage: db.prepare(
        'SELECT seq, id, role, content, image_id, kind, created_at FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      ),
      deleteMessage: db.prepare('DELETE FROM messages WHERE seq = ?'),
      exists: db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?'),
    };
  }

  create(characterId: string, greeting?: string): Session {
    const id = randomUUID();
    const ts = this.now().toISOString();
    transaction(this.db, () => {
      this.stmt.insertSession!.run(id, characterId, ts, ts);
      if (greeting?.trim()) this.insertMessage(id, 'assistant', greeting, ts);
    });
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.stmt.getSession!.get(id) as SessionRow | undefined;
    if (!row) return undefined;
    const messages = (this.stmt.getMessages!.all(id) as unknown as MessageRow[]).map(toMessage);
    return {
      id: row.id,
      characterId: row.character_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      summary: row.summary,
      summarizedUntil: row.summarized_until,
      factsExtractedUntil: row.facts_extracted_until,
      mood: row.mood,
      messages,
    };
  }

  listByCharacter(characterId: string, limit = 50): SessionListItem[] {
    const rows = this.stmt.list!.all(characterId, limit) as unknown as Array<
      Omit<SessionRow, 'summary' | 'summarized_until' | 'facts_extracted_until' | 'mood'> & { message_count: number }
    >;
    return rows.map((r) => ({
      id: r.id,
      characterId: r.character_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
    }));
  }

  listIdsByCharacter(characterId: string): string[] {
    return (this.stmt.idsByCharacter!.all(characterId) as Array<{ id: string }>).map((r) => r.id);
  }

  delete(id: string): boolean {
    // Messages cascade; memories keep living (source_session_id -> NULL).
    return Number(this.stmt.deleteSession!.run(id).changes) > 0;
  }

  appendMessage(
    sessionId: string,
    role: StoredMessage['role'],
    content: string,
    options: NewMessageOptions = {},
  ): StoredMessage {
    return transaction(this.db, () => {
      this.requireExists(sessionId);
      const ts = this.now().toISOString();
      const message = this.insertMessage(sessionId, role, content, ts, options);
      this.stmt.touch!.run(ts, sessionId);
      if (role === 'user') this.stmt.setTitleIfEmpty!.run(makeTitle(content), sessionId);
      return message;
    });
  }

  setMessageImage(messageId: string, imageId: string): void {
    this.stmt.setImage!.run(imageId, messageId);
  }

  popLastIf(sessionId: string, role: StoredMessage['role']): StoredMessage | undefined {
    return transaction(this.db, () => {
      this.requireExists(sessionId);
      const row = this.stmt.lastMessage!.get(sessionId) as MessageRow | undefined;
      if (!row || row.role !== role) return undefined;
      this.stmt.deleteMessage!.run(row.seq);
      return toMessage(row);
    });
  }

  updateMemoryState(sessionId: string, patch: Partial<SessionMemoryState>): void {
    // Column names come from this fixed map, never from input: no injection.
    const columns: Record<keyof SessionMemoryState, string> = {
      summary: 'summary',
      summarizedUntil: 'summarized_until',
      factsExtractedUntil: 'facts_extracted_until',
      mood: 'mood',
    };
    const entries = (Object.keys(patch) as Array<keyof SessionMemoryState>).filter((k) => patch[k] !== undefined);
    if (entries.length === 0) return;
    const sql = `UPDATE sessions SET ${entries.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map((k) => patch[k] as string | number), sessionId);
  }

  private insertMessage(
    sessionId: string,
    role: StoredMessage['role'],
    content: string,
    ts: string,
    {
      imageId = null,
      kind = null,
    }: { imageId?: string | null | undefined; kind?: StoredMessage['kind'] | undefined } = {},
  ): StoredMessage {
    const id = randomUUID();
    const result = this.stmt.insertMessage!.run(id, sessionId, role, content, imageId ?? null, kind ?? null, ts);
    return {
      seq: Number(result.lastInsertRowid),
      id,
      role,
      content,
      imageId: imageId ?? null,
      kind: kind ?? null,
      createdAt: ts,
    };
  }

  private requireExists(sessionId: string): void {
    if (!this.stmt.exists!.get(sessionId)) throw new SessionNotFoundError(sessionId);
  }
}
