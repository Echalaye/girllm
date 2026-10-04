/**
 * Conversation storage contract. The SQLite implementation lives in
 * `sqliteSessionStore.ts`; keeping the interface separate lets the chat
 * service and memory system be tested against any implementation.
 */
import type { ChatRole } from '../llm/types.js';

export interface StoredMessage {
  /** Monotonic sequence number — used as a cursor by the memory system. */
  seq: number;
  id: string;
  role: Exclude<ChatRole, 'system'>;
  content: string;
  /** Attached generated image (a "photo" she sent), if any. */
  imageId: string | null;
  createdAt: string; // ISO-8601
}

/** Memory-related state attached to a session. */
export interface SessionMemoryState {
  /** Running summary of every message with seq <= summarizedUntil. */
  summary: string;
  summarizedUntil: number;
  /** Messages with seq <= factsExtractedUntil were already mined for facts. */
  factsExtractedUntil: number;
  /** Character's current mood, as last inferred (may be empty). */
  mood: string;
}

export interface Session extends SessionMemoryState {
  id: string;
  characterId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

/** Lightweight row for chat lists (no messages). */
export interface SessionListItem {
  id: string;
  characterId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionStore {
  create(characterId: string, greeting?: string): Session;
  get(id: string): Session | undefined;
  listByCharacter(characterId: string, limit?: number): SessionListItem[];
  /** Every session id of a character (no limit), e.g. to delete them all. */
  listIdsByCharacter(characterId: string): string[];
  /** @returns false if the session did not exist. */
  delete(id: string): boolean;
  appendMessage(sessionId: string, role: StoredMessage['role'], content: string, imageId?: string): StoredMessage;
  /** Remove and return the last message if it has the given role. */
  popLastIf(sessionId: string, role: StoredMessage['role']): StoredMessage | undefined;
  updateMemoryState(sessionId: string, patch: Partial<SessionMemoryState>): void;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session ${id} not found`);
    this.name = 'SessionNotFoundError';
  }
}
