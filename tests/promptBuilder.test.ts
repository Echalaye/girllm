import { describe, expect, it } from 'vitest';
import { applyMacros, buildPrompt, buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, PromptTooLargeError } from '../src/prompt/promptBuilder.js';
import type { ChatMessage } from '../src/llm/types.js';
import { makeCharacter } from './helpers.js';

const budget = { contextTokens: 2048, maxReplyTokens: 200 };

describe('applyMacros', () => {
  it('replaces all macro forms, case-insensitively, without $ pitfalls', () => {
    expect(applyMacros('{{char}} {{CHAR}} <BOT> {{user}} <user>', 'A$&', 'U')).toBe('A$& A$& A$& U U');
  });
});

describe('buildSystemPrompt', () => {
  it('uses the default prompt and includes the card definition', () => {
    const s = buildSystemPrompt(makeCharacter({ mes_example: '<START>\n{{user}}: hi' }), 'Etienne');
    expect(s).toContain(applyMacros(DEFAULT_SYSTEM_PROMPT, 'Aria', 'Etienne'));
    expect(s).toContain('Aria is an illustrator dating Etienne.');
    expect(s).toContain('Personality: playful');
    expect(s).toContain('---\nEtienne: hi');
    expect(s).not.toContain('{{');
  });

  it('prefers the card system prompt', () => {
    expect(buildSystemPrompt(makeCharacter({ system_prompt: 'Custom for {{char}}' }), 'U')).toMatch(/^Custom for Aria/);
  });
});

describe('buildPrompt', () => {
  it('keeps the greeting in a fresh chat and appends post-history instructions', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'Hello' },
    ];
    const p = buildPrompt(makeCharacter({ post_history_instructions: 'Stay as {{char}}' }), history, 'U', budget);
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user', 'system']);
    expect(p.messages.at(-1)?.content).toBe('Stay as Aria');
    expect(p.droppedMessages).toBe(0);
    expect(p.estimatedTokens).toBeGreaterThan(0);
  });

  it('drops oldest messages when over budget and never starts with assistant after trimming', () => {
    const long = 'x'.repeat(2000); // ~572 tokens each
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: long });
    history.push({ role: 'user', content: 'latest' });

    const p = buildPrompt(makeCharacter(), history, 'U', budget);
    expect(p.droppedMessages).toBeGreaterThan(0);
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: 'latest' });
    expect(p.messages[1]?.role).toBe('user');
    expect(p.estimatedTokens).toBeLessThanOrEqual(budget.contextTokens - budget.maxReplyTokens);
  });

  it('throws when even the last message cannot fit', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'y'.repeat(20_000) }];
    expect(() => buildPrompt(makeCharacter(), history, 'U', budget)).toThrow(PromptTooLargeError);
  });
});

describe('buildPrompt replyLanguage', () => {
  it('adds the language rule to the system prompt and as a final reminder', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'Salut' }];
    const p = buildPrompt(makeCharacter({ post_history_instructions: 'Be {{char}}' }), history, 'U', budget, {
      replyLanguage: 'French',
    });
    expect(p.messages[0]?.content).toContain('Always write your replies in French');
    expect(p.messages.at(-1)).toEqual({ role: 'system', content: 'Be Aria\n(Reply in French.)' });
  });

  it('adds nothing when no language is set', () => {
    const p = buildPrompt(makeCharacter(), [{ role: 'user', content: 'Hi' }], 'U', budget);
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(p.messages[0]?.content).not.toContain('Always write your replies');
  });
});
