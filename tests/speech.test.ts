import { describe, expect, it } from 'vitest';
// Plain browser ES module, shared with the front-end.
import { SentenceSplitter } from '../public/speech.js';

/** Feed text in small chunks like a token stream; collect all sentences. */
function run(text: string, options?: { minChars?: number; maxChars?: number }, chunk = 3) {
  const s = new SentenceSplitter(options);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  return { streamed: [...out], all: [...out, ...s.flush()] };
}

describe('SentenceSplitter', () => {
  it('emits sentences as soon as they are complete', () => {
    const { streamed, all } = run("Coucou toi, ça va bien ? J'ai passé une super journée ! Et toi");
    expect(streamed).toEqual(['Coucou toi, ça va bien ?', "J'ai passé une super journée !"]);
    expect(all.at(-1)).toBe('Et toi');
  });

  it('merges fragments shorter than minChars', () => {
    expect(run('Oh. Ah. Vraiment, tu es sérieux ? Oui.').all).toEqual(['Oh. Ah. Vraiment, tu es sérieux ?', 'Oui.']);
  });

  it('never cuts inside an *action*', () => {
    const { all } = run('*pose sa tasse. Elle sourit doucement.* Tu es rentré tard ce soir. Viens là.');
    expect(all[0]).toBe('*pose sa tasse. Elle sourit doucement.* Tu es rentré tard ce soir.');
  });

  it('cuts at paragraph breaks and handles ellipses and quotes', () => {
    expect(run('Je ne sais pas trop quoi dire…\nMais je suis contente.').all).toEqual([
      'Je ne sais pas trop quoi dire…',
      'Mais je suis contente.',
    ]);
    // The closing » stays with its quote.
    expect(run('Elle a dit « tu verras bien ! » et elle est partie.').all).toEqual([
      'Elle a dit « tu verras bien ! »',
      'et elle est partie.',
    ]);
  });

  it('forces a cut in very long sentences, preferring commas', () => {
    const long = `${'mot '.repeat(20)}, ${'encore '.repeat(30)}fin.`;
    const { all } = run(long, { maxChars: 120 });
    expect(all.length).toBeGreaterThan(1);
    expect(all[0]!.endsWith(',')).toBe(true);
    expect(all.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('returns nothing for empty input', () => {
    expect(run('   ').all).toEqual([]);
  });
});
