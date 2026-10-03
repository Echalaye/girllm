import { describe, expect, it } from 'vitest';
import { assistantIsms, cell, checkReply, frenchRatio, SCENARIOS_FR, speaksForUser } from '../scripts/compareLib.js';

describe('model comparison checks', () => {
  it('flags assistant-like phrasing and lists', () => {
    expect(assistantIsms("Je suis là pour toi, n'hésite pas à m'en parler.")).toHaveLength(2);
    expect(assistantIsms('Voici quelques idées :\n- dormir\n- manger')).not.toHaveLength(0);
    expect(assistantIsms('Oh non… viens là, raconte-moi tout 🫂')).toEqual([]);
  });

  it('estimates whether a reply is French', () => {
    expect(frenchRatio("Je suis trop contente pour toi, c'est génial")).toBeGreaterThan(0.9);
    expect(frenchRatio('I am so happy for you, this is great')).toBeLessThan(0.2);
  });

  it('detects the model writing the user’s lines', () => {
    expect(speaksForUser('Haha !\nEtienne: oui', 'Etienne')).toBe(true);
    expect(speaksForUser('Etienne, tu es nul 😂', 'Etienne')).toBe(false);
  });

  it('summarises a reply and keeps table cells on one line', () => {
    expect(checkReply('*rit* Non. Jamais ! Bon, peut-être…', 'E')).toMatchObject({
      sentences: 3,
      speaksForUser: false,
    });
    expect(cell('a | b\nc')).toBe('a \\| b ⏎ c');
  });

  it('scenarios all end with the user’s message', () => {
    for (const s of SCENARIOS_FR) expect(s.history.at(-1)?.role).toBe('user');
  });
});
