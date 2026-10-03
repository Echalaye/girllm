import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import type { StoredMessage } from '../src/chat/sessionStore.js';
import { ChatService } from '../src/chat/chatService.js';
import { cosine, fromBlob, normalize, taskPrefix, toBlob } from '../src/memory/embeddings.js';
import { parseExtraction } from '../src/memory/factExtractor.js';
import { buildQuery, MemoryService, type MemoryServiceOptions } from '../src/memory/memoryService.js';
import { MemoryStore } from '../src/memory/memoryStore.js';
import { defaultSummaryPolicy, selectMessagesToSummarize } from '../src/memory/summarizer.js';
import { buildMemoryBlock } from '../src/prompt/promptBuilder.js';
import { FakeEmbeddings, makeCharacter, makeStore, ScriptedLlm } from './helpers.js';

const msg = (seq: number, role: 'user' | 'assistant', content: string): StoredMessage => ({
  seq,
  id: `m${seq}`,
  role,
  content,
  imageId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const silentLog = { warn: () => {}, info: () => {} };

describe('embeddings helpers', () => {
  it('normalises, compares and round-trips through BLOBs', () => {
    const a = normalize([3, 4]);
    expect(Array.from(a)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, normalize([1, 2, 3]))).toBe(-1); // dimension mismatch
    expect(Array.from(fromBlob(toBlob(a)))).toEqual(Array.from(a));
  });

  it('applies model-specific task prefixes', () => {
    expect(taskPrefix('nomic-embed-text', 'query')).toBe('search_query: ');
    expect(taskPrefix('multilingual-e5-small', 'document')).toBe('passage: ');
    expect(taskPrefix('paraphrase-multilingual', 'query')).toBe('');
  });
});

describe('selectMessagesToSummarize', () => {
  const policy = { triggerTokens: 100, keepRecentTokens: 40, maxChunkTokens: 1000 };
  const long = 'x'.repeat(70); // ~24 tokens with overhead

  it('does nothing under the trigger', () => {
    expect(selectMessagesToSummarize([msg(1, 'user', 'hi'), msg(2, 'assistant', 'yo')], policy)).toEqual([]);
  });

  it('summarizes the oldest messages and keeps a recent tail of at least 2', () => {
    const messages = Array.from({ length: 8 }, (_, i) => msg(i + 1, i % 2 ? 'assistant' : 'user', long));
    const selected = selectMessagesToSummarize(messages, policy);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0]!.seq).toBe(1);
    expect(messages.length - selected.length).toBeGreaterThanOrEqual(2);
  });

  it('respects the chunk limit', () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(i + 1, 'user', long));
    expect(selectMessagesToSummarize(messages, { ...policy, maxChunkTokens: 50 }).length).toBe(2);
  });

  it('derives a policy from the context size', () => {
    expect(defaultSummaryPolicy(8192, 400)).toEqual({
      triggerTokens: 3896,
      keepRecentTokens: 1948,
      maxChunkTokens: 3276,
    });
  });
});

describe('parseExtraction', () => {
  it('parses JSON wrapped in prose / fences and drops invalid items', () => {
    const raw =
      'Here you go:\n```json\n{"facts":[{"category":"User","content":"Etienne climbs on weekends"},' +
      '{"category":"admin","content":"bad"},{"category":"event","content":"x"}],"mood":"playful"}\n```';
    expect(parseExtraction(raw)).toEqual({
      facts: [{ category: 'user', content: 'Etienne climbs on weekends' }],
      mood: 'playful',
    });
  });

  it('returns an empty result on garbage', () => {
    expect(parseExtraction('no json here')).toEqual({ facts: [], mood: '' });
    expect(parseExtraction('{broken')).toEqual({ facts: [], mood: '' });
  });
});

describe('buildQuery / buildMemoryBlock', () => {
  it('uses the last user message and the reply it answers', () => {
    expect(buildQuery([msg(1, 'assistant', 'How was work?'), msg(2, 'user', 'Tiring')])).toBe('How was work?\nTiring');
    expect(buildQuery([msg(1, 'assistant', 'Hello')])).toBe('');
  });

  it('renders only the non-empty parts', () => {
    expect(buildMemoryBlock({ summary: '', memories: [], mood: '' }, 'Aria', 'U')).toBe('');
    const block = buildMemoryBlock({ summary: 'They met.', memories: ['U likes tea'], mood: 'happy' }, 'Aria', 'U');
    expect(block).toContain('- U likes tea');
    expect(block).toContain('[Story so far]\nThey met.');
    expect(block).not.toContain('happy'); // the mood lives in the [Right now] block
  });
});

function setupMemory(
  opts: Partial<MemoryServiceOptions> = {},
  llm = new ScriptedLlm(),
  embeddings: FakeEmbeddings | undefined = new FakeEmbeddings(),
) {
  const { db, store } = makeStore();
  const characters = CharacterRepository.fromCharacters([makeCharacter()]);
  const memories = new MemoryStore(db);
  const service = new MemoryService(store, characters, memories, llm, embeddings, silentLog, {
    userName: 'Etienne',
    summaryPolicy: { triggerTokens: 100, keepRecentTokens: 30, maxChunkTokens: 2000 },
    topK: 3,
    memoryTokenBudget: 500,
    extractEvery: 2,
    duplicateThreshold: 0.9,
    minRelevance: 0.3,
    ...opts,
  });
  return { store, memories, service, llm, embeddings };
}

describe('MemoryService', () => {
  it('summarizes old messages and advances the cursor', async () => {
    const llm = new ScriptedLlm({ summary: 'Etienne told Aria about his long day.' });
    const { store, service } = setupMemory({}, llm);
    const s = store.create('aria');
    for (let i = 0; i < 8; i++) store.appendMessage(s.id, i % 2 ? 'assistant' : 'user', 'y'.repeat(80));

    await service.runJobs(s.id);
    const after = store.get(s.id)!;
    expect(after.summary).toBe('Etienne told Aria about his long day.');
    expect(after.summarizedUntil).toBeGreaterThan(0);
    expect(after.messages.filter((m) => m.seq > after.summarizedUntil).length).toBeGreaterThanOrEqual(2);
    expect(llm.callsOfKind('summary')[0]![1]!.content).toContain('Existing summary:\n(none yet)');
  });

  it('extracts facts, skips the swipeable last reply, de-duplicates and stores the mood', async () => {
    const extraction = JSON.stringify({
      facts: [
        { category: 'user', content: 'Etienne works at a space company' },
        { category: 'user', content: 'Etienne works at a space company!' }, // near duplicate
      ],
      mood: 'curious',
    });
    const { store, memories, service, llm } = setupMemory({}, new ScriptedLlm({ extraction }));
    const s = store.create('aria', 'Hi!');
    store.appendMessage(s.id, 'user', 'I work in the space industry');
    store.appendMessage(s.id, 'assistant', 'Wow!');

    await service.runJobs(s.id);
    const after = store.get(s.id)!;
    expect(memories.list('aria').map((m) => m.content)).toEqual(['Etienne works at a space company']);
    expect(after.mood).toBe('curious');
    // The last assistant message ("Wow!") was not processed yet.
    expect(after.factsExtractedUntil).toBe(after.messages[1]!.seq);
    expect(llm.callsOfKind('extraction')[0]![1]!.content).not.toContain('Wow!');

    // Running again with nothing new pending does not call the LLM.
    await service.runJobs(s.id);
    expect(llm.callsOfKind('extraction')).toHaveLength(1);
  });

  it('retrieves relevant memories first, then recent ones, within topK', async () => {
    const { store, service } = setupMemory({ topK: 2 });
    await service.remember('aria', 'user', 'Etienne has a grey cat named Pixel');
    await service.remember('aria', 'user', 'Etienne plays football on sundays');
    await service.remember('aria', 'event', 'They plan a trip to Barcelona');
    const s = store.create('aria');
    store.appendMessage(s.id, 'user', 'my cat Pixel is sick');

    const ctx = await service.buildContext(store.get(s.id)!);
    expect(ctx.memories).toHaveLength(2);
    expect(ctx.memories[0]).toBe('Etienne has a grey cat named Pixel');
  });

  it('falls back to recency when embeddings fail', async () => {
    const embeddings = new FakeEmbeddings();
    const { store, service } = setupMemory({}, new ScriptedLlm(), embeddings);
    embeddings.fail = true;
    expect(await service.remember('aria', 'user', 'Etienne likes tea')).toBeDefined();
    const s = store.create('aria');
    store.appendMessage(s.id, 'user', 'hello');
    expect((await service.buildContext(store.get(s.id)!)).memories).toEqual(['Etienne likes tea']);
  });

  it('works without any embedding provider and rejects exact duplicates', async () => {
    const { service } = setupMemory({}, new ScriptedLlm(), undefined);
    expect(await service.remember('aria', 'user', 'Likes tea')).toBeDefined();
    expect(await service.remember('aria', 'user', '  likes TEA ')).toBeUndefined();
  });

  it('is wired into ChatService: summary + memories reach the prompt, jobs run after replies', async () => {
    const llm = new ScriptedLlm({ chat: 'Of course I remember!', summary: 'They talked about Pixel.' });
    const { db, store } = makeStore();
    const characters = CharacterRepository.fromCharacters([makeCharacter()]);
    const memories = new MemoryStore(db);
    const memory = new MemoryService(store, characters, memories, llm, new FakeEmbeddings(), silentLog, {
      userName: 'Etienne',
      summaryPolicy: { triggerTokens: 60, keepRecentTokens: 20, maxChunkTokens: 2000 },
      topK: 5,
      memoryTokenBudget: 500,
      extractEvery: 50,
      duplicateThreshold: 0.9,
      minRelevance: 0.3,
    });
    const chat = new ChatService(
      characters,
      store,
      llm,
      {
        userName: 'Etienne',
        budget: { contextTokens: 4096, maxReplyTokens: 200 },
        temperature: 0.7,
        topP: 0.9,
      },
      memory,
    );

    await memory.remember('aria', 'user', 'Etienne has a cat named Pixel');
    const { session } = chat.createSession('aria');
    for (let i = 0; i < 3; i++)
      await chat.sendMessage(session.id, `Long message number ${i} ${'z'.repeat(80)}`, () => {});
    await memory.idle();

    expect(store.get(session.id)!.summary).toBe('They talked about Pixel.');
    await chat.sendMessage(session.id, 'Do you remember my cat?', () => {});
    const lastChat = llm.callsOfKind('chat').at(-1)!;
    expect(lastChat[0]!.content).toContain('- Etienne has a cat named Pixel');
    expect(lastChat[0]!.content).toContain('[Story so far]\nThey talked about Pixel.');
    // Summarized messages are no longer sent verbatim.
    expect(lastChat.some((m) => m.content.includes('Long message number 0'))).toBe(false);
  });
});
