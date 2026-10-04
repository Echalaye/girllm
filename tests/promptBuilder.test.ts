import { describe, expect, it } from 'vitest';
import {
  applyMacros,
  buildNowBlock,
  buildPrompt,
  buildReminderBlock,
  buildSystemPrompt,
  STYLE_PROMPTS,
  PromptTooLargeError,
  type PromptOptions,
} from '../src/prompt/promptBuilder.js';
import { opening, overusedPhrases, recentOpenings } from '../src/prompt/styleGuard.js';
import { previousMessageTime } from '../src/chat/chatService.js';
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
    expect(s).toContain(applyMacros(STYLE_PROMPTS.roleplay, 'Aria', 'Etienne'));
    expect(s).toContain('Aria is an illustrator dating Etienne.');
    expect(s).toContain('Personality: playful');
    expect(s).toContain('Example 1:\n> Etienne: hi');
    // Examples are fenced as fiction and placed BEFORE the character definition.
    expect(s).toContain('FICTIONAL');
    expect(s.indexOf('Example 1:')).toBeLessThan(s.indexOf('[Character: Aria]'));
    expect(s).not.toContain('{{');
  });

  it('prefers the card system prompt', () => {
    expect(buildSystemPrompt(makeCharacter({ system_prompt: 'Custom for {{char}}' }), 'U')).toMatch(/^Custom for Aria/);
  });
});

describe('buildPrompt', () => {
  it('keeps the greeting in a fresh chat and puts post-history instructions in the system prompt', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'Hello' },
    ];
    const p = buildPrompt(makeCharacter({ post_history_instructions: 'Stay as {{char}}' }), history, 'U', budget);
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(p.messages[1]).toEqual({ role: 'user', content: '(U opens the chat.)' });
    expect(p.messages[2]).toEqual({ role: 'assistant', content: 'Hi!' });
    expect(p.messages[0]?.content).toContain('[Reminders]\nStay as Aria');
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
  it('adds the language rule to the reminders, never as a trailing message', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'Salut' }];
    const p = buildPrompt(makeCharacter({ post_history_instructions: 'Be {{char}}' }), history, 'U', budget, {
      replyLanguage: 'French',
    });
    expect(p.messages[0]?.content).toContain('Always write in French');
    expect(p.messages[0]?.content).toContain('Be Aria');
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: 'Salut' });
  });

  it('adds nothing when no language is set', () => {
    const p = buildPrompt(makeCharacter(), [{ role: 'user', content: 'Hi' }], 'U', budget);
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(p.messages[0]?.content).not.toContain('Always write in');
  });
});

describe('prompt layout invariants (regression: Ollama Mistral template)', () => {
  // Ollama's Mistral template only renders the system prompt when the LAST
  // message is the user's. A trailing system message silently dropped the
  // whole character card. These invariants must hold in every configuration.
  const configs: Array<[string, PromptOptions]> = [
    ['plain', {}],
    ['language', { replyLanguage: 'French' }],
    ['memory + time', { memory: { summary: 'S', memories: ['M'], mood: 'calm' }, time: { now: new Date() } }],
  ];
  it.each(configs)('%s: one system message first, last message from the user', (_name, options) => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: 'Hey' },
      { role: 'user', content: 'Yo' },
      { role: 'assistant', content: 'What?' },
      { role: 'user', content: 'Nothing' },
    ];
    const p = buildPrompt(makeCharacter({ post_history_instructions: 'PHI' }), history, 'U', budget, options);
    expect(p.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(p.messages[0]!.role).toBe('system');
    expect(p.messages.at(-1)).toEqual({ role: 'user', content: 'Nothing' });
    // Turns start with the user and alternate (strict templates require it).
    p.messages.slice(1).forEach((m, i) => {
      expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
    });
  });
});

describe('writing styles', () => {
  it('uses the texting prompt for texting cards and the roleplay prompt otherwise', () => {
    expect(buildSystemPrompt(makeCharacter({ style: 'texting' }), 'Etienne')).toContain(
      'texting with Etienne on your phone',
    );
    expect(buildSystemPrompt(makeCharacter(), 'Etienne')).toContain('immersive roleplay with Etienne');
    expect(buildSystemPrompt(makeCharacter({ style: 'texting', system_prompt: 'Custom' }), 'E')).toMatch(/^Custom/);
  });
});

describe('time awareness', () => {
  const now = new Date('2026-10-03T21:01:00Z'); // 23:01 in Paris

  it('states the local date and time in the reply language', () => {
    const block = buildNowBlock({ now, timeZone: 'Europe/Paris' }, '', 'French', 'Aria', 'Etienne');
    expect(block).toContain('samedi 3 octobre 2026');
    expect(block).toContain('23:01');
  });

  it('mentions notable pauses and asks to react to long ones', () => {
    const at = (ms: number) => ({ now, previousMessageAt: new Date(now.getTime() - ms), timeZone: 'Europe/Paris' });
    expect(buildNowBlock(at(10 * 60_000), '', undefined, 'A', 'E')).not.toContain('after the previous one');
    expect(buildNowBlock(at(2 * 3600_000), '', undefined, 'A', 'E')).toContain('2 hours after the previous one.');
    expect(buildNowBlock(at(3 * 86_400_000), 'tired', undefined, 'A', 'E')).toMatch(
      /3 days after .*react to that pause[\s\S]*mood: tired/,
    );
  });

  it('reports the time of the message before the latest user message', () => {
    const m = (seq: number, role: 'user' | 'assistant', createdAt: string) => ({
      seq,
      id: `${seq}`,
      role,
      content: 'x',
      imageId: null,
      kind: null,
      createdAt,
    });
    expect(
      previousMessageTime([
        m(1, 'assistant', '2026-10-01T10:00:00Z'),
        m(2, 'user', '2026-10-03T21:00:00Z'),
      ])?.toISOString(),
    ).toBe('2026-10-01T10:00:00.000Z');
    expect(previousMessageTime([m(1, 'user', '2026-10-03T21:00:00Z')])).toBeUndefined();
  });
});

describe('anti-repetition', () => {
  const replies = (...texts: string[]): ChatMessage[] =>
    texts.flatMap((t) => [
      { role: 'user' as const, content: 'u' },
      { role: 'assistant' as const, content: t },
    ]);

  it('lists recent openings (ignoring actions and emojis) and overused phrases', () => {
    const history = replies(
      '*sourit* Oh là là, tu es trop mignon ce soir 😊',
      'Haha, tu es trop mignon ce soir vraiment',
      'Oh là là je rêve de dormir',
    );
    expect(recentOpenings(history)).toEqual(['oh là là', 'haha tu es']);
    expect(overusedPhrases(history)).toContain('tu es trop mignon');
    const block = buildReminderBlock(history, makeCharacter(), 'U', undefined);
    expect(block).toContain('Start differently');
    expect(block).toContain('"tu es trop mignon"');
  });

  it('stays quiet when there is nothing to report', () => {
    expect(buildReminderBlock(replies('Salut toi'), makeCharacter(), 'U', undefined)).toBe('');
    expect(opening('*rit* ...Bon, d’accord !')).toBe('bon d’accord');
  });
});

/**
 * Re-implementation of Ollama's template for mistral-nemo (fetched from
 * ollama.com/library/mistral-nemo, blob 438402ddac75): system messages are
 * collected into $.System and printed ONLY inside the last user turn.
 */
function renderMistralNemo(messages: ChatMessage[]): string {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  return turns
    .map((m, i) => {
      const isLast = i === turns.length - 1;
      if (m.role === 'user') return `[INST]${isLast && system ? `${system}\n\n` : ''}${m.content}[/INST]`;
      return ` ${m.content}${isLast ? '' : '</s>'}`;
    })
    .join('');
}

describe('as rendered by the Mistral Nemo template (regression)', () => {
  const card = makeCharacter({
    style: 'texting',
    mes_example: "<START>\n{{user}}: J'ai enfin corrigé ce bug.\n{{char}}: LE bug ?",
  });
  const history: ChatMessage[] = [
    { role: 'assistant', content: 'Coucou !' },
    { role: 'user', content: 'Je cuisine pour notre repas de ce soir' },
  ];
  const rendered = renderMistralNemo(
    buildPrompt(card, history, 'Etienne', budget, { replyLanguage: 'French' }).messages,
  );

  it('includes the character card (it used to be dropped entirely)', () => {
    expect(rendered).toContain('[Character: Aria]');
  });

  it('puts the end-of-notes boundary immediately before the user message', () => {
    expect(rendered).toContain(
      "[End of notes. Now reply as Aria, and only as Aria, to Etienne's latest message.]\n\nJe cuisine pour notre repas de ce soir[/INST]",
    );
  });

  it('keeps the fictional examples far from the user message', () => {
    const examplePos = rendered.indexOf('corrigé ce bug');
    const userPos = rendered.indexOf('Je cuisine');
    expect(examplePos).toBeGreaterThan(-1);
    expect(rendered.slice(examplePos, userPos)).toContain('[Character: Aria]');
  });
});
