import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { ChatService, NotFoundError, SessionBusyError } from '../src/chat/chatService.js';
import { FakeLlm, makeCharacter, makeStore } from './helpers.js';

function setup(llm = new FakeLlm()) {
  const { store } = makeStore();
  const service = new ChatService(CharacterRepository.fromCharacters([makeCharacter()]), store, llm, {
    userName: 'Etienne',
    budget: { contextTokens: 4096, maxReplyTokens: 200 },
    temperature: 0.8,
    topP: 0.9,
  });
  return { service, store, llm };
}

describe('ChatService', () => {
  it('creates a session with the greeting and streams + stores a reply', async () => {
    const { service, llm } = setup();
    const { session } = service.createSession('aria');
    expect(session.messages).toHaveLength(1);

    const tokens: string[] = [];
    const result = await service.sendMessage(session.id, 'Hey you', (t) => tokens.push(t));

    expect(tokens.join('')).toBe('Hello there');
    expect(result.message?.content).toBe('Hello there');
    expect(service.getSession(session.id).session.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(llm.lastOptions?.stop).toContain('\nEtienne:');
    expect(llm.lastMessages[0]?.role).toBe('system');
  });

  it('regenerate replaces the last reply', async () => {
    const { service } = setup();
    const { session } = service.createSession('aria');
    await service.sendMessage(session.id, 'Hi', () => {});
    await service.regenerate(session.id, () => {});
    expect(service.getSession(session.id).session.messages).toHaveLength(3);
  });

  it('refuses to regenerate when there is no user message', async () => {
    const { service } = setup();
    const { session } = service.createSession('aria');
    await expect(service.regenerate(session.id, () => {})).rejects.toThrow(NotFoundError);
    expect(service.getSession(session.id).session.messages).toHaveLength(1); // greeting kept
  });

  it('allows only one generation per session at a time', async () => {
    const { service } = setup(new FakeLlm(['a', 'b'], 20));
    const { session } = service.createSession('aria');
    const first = service.sendMessage(session.id, 'one', () => {});
    await expect(service.sendMessage(session.id, 'two', () => {})).rejects.toThrow(SessionBusyError);
    await first;
  });

  it('keeps the partial reply when aborted', async () => {
    const { service } = setup(new FakeLlm(['part', 'never'], 10));
    const { session } = service.createSession('aria');
    const controller = new AbortController();
    const result = await service.sendMessage(session.id, 'go', () => controller.abort(), controller.signal);
    expect(result.aborted).toBe(true);
    expect(result.message?.content).toBe('part');
  });

  it('lists and deletes sessions', async () => {
    const { service } = setup();
    const { session } = service.createSession('aria');
    await service.sendMessage(session.id, 'First message', () => {});
    expect(service.listSessions('aria')).toMatchObject([{ id: session.id, title: 'First message', messageCount: 3 }]);
    service.deleteSession(session.id);
    expect(service.listSessions('aria')).toEqual([]);
    expect(() => service.deleteSession(session.id)).toThrow(NotFoundError);
  });

  it('rejects unknown characters and sessions', () => {
    const { service } = setup();
    expect(() => service.createSession('nobody')).toThrow(NotFoundError);
    expect(() => service.getSession('00000000-0000-4000-8000-000000000000')).toThrow(NotFoundError);
  });
});

