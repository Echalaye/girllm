import { describe, expect, it } from 'vitest';
import { makeTitle, SqliteSessionStore } from '../src/chat/sqliteSessionStore.js';
import { SessionNotFoundError } from '../src/chat/sessionStore.js';
import { migrate, openDatabase } from '../src/db/database.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { makeStore } from './helpers.js';

describe('database', () => {
  it('migrates idempotently and refuses newer schemas', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db)).not.toThrow();
    db.exec('PRAGMA user_version = 99');
    expect(() => migrate(db)).toThrow(/newer than this app supports/);
  });
});

describe('SqliteSessionStore', () => {
  it('creates sessions with greeting and keeps message order with increasing seq', () => {
    const { store } = makeStore();
    const s = store.create('aria', 'Hello!');
    const m1 = store.appendMessage(s.id, 'user', 'Hi');
    const m2 = store.appendMessage(s.id, 'assistant', 'Hey');
    const loaded = store.get(s.id)!;
    expect(loaded.messages.map((m) => m.content)).toEqual(['Hello!', 'Hi', 'Hey']);
    expect(m2.seq).toBeGreaterThan(m1.seq);
    expect(loaded.title).toBe('Hi');
    expect(loaded.summarizedUntil).toBe(0);
  });

  it('pops only the matching last message', () => {
    const { store } = makeStore();
    const s = store.create('aria');
    store.appendMessage(s.id, 'user', 'Hi');
    expect(store.popLastIf(s.id, 'assistant')).toBeUndefined();
    expect(store.popLastIf(s.id, 'user')?.content).toBe('Hi');
    expect(store.get(s.id)!.messages).toHaveLength(0);
  });

  it('lists by character, most recent first, and deletes with cascade', () => {
    let t = 0;
    const db = openDatabase(':memory:');
    const store = new SqliteSessionStore(db, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    const a = store.create('aria');
    const b = store.create('aria');
    store.create('other');
    store.appendMessage(a.id, 'user', 'bump a');
    expect(store.listByCharacter('aria').map((s) => s.id)).toEqual([a.id, b.id]);

    expect(store.delete(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
  });

  it('updates memory state and validates session existence', () => {
    const { store } = makeStore();
    const s = store.create('aria');
    store.updateMemoryState(s.id, { summary: 'They met.', summarizedUntil: 3, mood: 'happy' });
    expect(store.get(s.id)).toMatchObject({ summary: 'They met.', summarizedUntil: 3, mood: 'happy', factsExtractedUntil: 0 });
    expect(() => store.appendMessage('nope', 'user', 'x')).toThrow(SessionNotFoundError);
  });

  it('keeps memories when their source chat is deleted', () => {
    const { db, store } = makeStore();
    const memories = new MemoryStore(db);
    const s = store.create('aria');
    const m = memories.add({ characterId: 'aria', category: 'user', content: 'Likes tea', sourceSessionId: s.id });
    expect(m.sourceSessionId).toBe(s.id);
    store.delete(s.id);
    expect(memories.get(m.id)?.sourceSessionId).toBeNull();
    // Unknown source session -> stored with NULL instead of an FK error.
    expect(memories.add({ characterId: 'aria', category: 'user', content: 'x y z', sourceSessionId: 'gone' }).sourceSessionId).toBeNull();
  });
});

describe('makeTitle', () => {
  it('collapses whitespace and truncates', () => {
    expect(makeTitle('  hello\n  world ')).toBe('hello world');
    expect(makeTitle('a'.repeat(100))).toHaveLength(60);
  });
});
