import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { CharacterInputSchema, type CharacterBook } from '../src/characters/schema.js';
import { selectLore } from '../src/prompt/lorebook.js';
import { buildPrompt } from '../src/prompt/promptBuilder.js';
import { makeCharacter } from './helpers.js';

const entry = (keys: string[], content: string, extra: Partial<CharacterBook['entries'][number]> = {}) => ({
  keys,
  content,
  enabled: true,
  constant: false,
  case_sensitive: false,
  insertion_order: 100,
  ...extra,
});
const book = (entries: CharacterBook['entries'], extra: Partial<CharacterBook> = {}): CharacterBook => ({
  entries,
  extensions: {},
  ...extra,
});

describe('selectLore', () => {
  const lore = book([
    entry(['Chloé', 'sister'], 'Her sister Chloé is a nurse in Lyon.'),
    entry(['café'], 'She works part-time at the Café des Arts.'),
    entry([], 'She is allergic to cats.', { constant: true }),
    entry(['jazz'], 'She plays the saxophone.', { enabled: false }),
  ]);

  it('includes entries whose keys appear (whole words, accents, any case) and constant ones', () => {
    expect(selectLore(lore, ['Tu as des nouvelles de CHLOÉ ?'], 1000)).toEqual([
      'Her sister Chloé is a nurse in Lyon.',
      'She is allergic to cats.',
    ]);
    // "cafés" is another word: no match; "café" is.
    expect(selectLore(lore, ['On va dans des cafés'], 1000)).toEqual(['She is allergic to cats.']);
    expect(selectLore(lore, ['Un café ?'], 1000)).toContain('She works part-time at the Café des Arts.');
  });

  it('ignores disabled entries and only scans the last messages', () => {
    expect(selectLore(lore, ['jazz ce soir ?'], 1000)).toEqual(['She is allergic to cats.']);
    const old = ['Chloé vient demain', 'a', 'b', 'c', 'd'];
    expect(selectLore(lore, old, 1000)).toEqual(['She is allergic to cats.']);
    expect(selectLore(book(lore.entries, { scan_depth: 10 }), old, 1000)).toHaveLength(2);
  });

  it('keeps the highest insertion_order entries within the budget, in ascending order', () => {
    const big = 'x'.repeat(400); // ~115 tokens
    const b = book([
      entry(['a'], `A ${big}`, { insertion_order: 1 }),
      entry(['a'], `B ${big}`, { insertion_order: 50 }),
      entry(['a'], 'C short', { insertion_order: 10 }),
    ]);
    const kept = selectLore(b, ['a'], 150);
    expect(kept.map((k) => k[0])).toEqual(['C', 'B']);
  });

  it('treats keys as plain text, never as regular expressions', () => {
    const b = book([entry(['(a+)+$'], 'never')]);
    expect(selectLore(b, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'], 1000)).toEqual([]);
  });
});

describe('lorebook in the prompt and in cards', () => {
  it('adds a [World info] block with macros applied', () => {
    const prompt = buildPrompt(
      makeCharacter(),
      [{ role: 'user', content: 'Salut' }],
      'Etienne',
      {
        contextTokens: 4096,
        maxReplyTokens: 200,
      },
      { lore: ["{{char}}'s sister is Chloé."] },
    );
    expect(prompt.messages[0]?.content).toContain("[World info]\nAria's sister is Chloé.");
  });

  it('saves the voice description and lorebook in the V2 card and loads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girllm-lore-'));
    const repo = await CharacterRepository.loadFromDirectory(dir, { info: () => {}, warn: () => {} });
    await repo.save(
      CharacterInputSchema.parse({
        name: 'Magi',
        description: '{{char}} is 23.',
        voiceDescription: 'Warm, slightly husky voice, calm',
        lorebook: [{ keys: ['Chloé'], content: 'Her sister.', constant: false }],
      }),
    );
    const raw = JSON.parse(await readFile(join(dir, 'magi.json'), 'utf8'));
    expect(raw.data.extensions.girllm.voiceDescription).toBe('Warm, slightly husky voice, calm');
    expect(raw.data.character_book.entries[0]).toMatchObject({
      keys: ['Chloé'],
      content: 'Her sister.',
      enabled: true,
    });

    const reloaded = await CharacterRepository.loadFromDirectory(dir, { info: () => {}, warn: () => {} });
    const magi = reloaded.get('magi')!;
    expect(magi.voiceDescription).toBe('Warm, slightly husky voice, calm');
    expect(magi.character_book?.entries).toHaveLength(1);
  });

  it('limits the voice description to 500 characters', () => {
    expect(() => CharacterInputSchema.parse({ name: 'X', voiceDescription: 'a'.repeat(501) })).toThrow();
    expect(CharacterInputSchema.parse({ name: 'X', voiceDescription: '  calm  ' }).voiceDescription).toBe('calm');
  });
});
