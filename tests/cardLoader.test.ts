import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCardJsonFromPng, loadCardFile, parseCardObject, slugify } from '../src/characters/cardLoader.js';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { cardStatesMinorAge, mentionsMinor } from '../src/images/safety.js';

/** Build a minimal PNG containing the given tEXt chunks (CRC not checked). */
function pngWithText(entries: Record<string, string>): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const text = Object.entries(entries).map(([k, v]) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1')));
  return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), ...text, chunk('IEND', Buffer.alloc(0))]);
}

const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Mira', description: 'd', first_mes: 'hey' } };

describe('slugify', () => {
  it('produces URL-safe ids', () => {
    expect(slugify('/x/My Wáifu (v2).png')).toBe('my-waifu-v2');
    expect(slugify('***.json')).toBe('character');
  });
});

describe('parseCardObject', () => {
  it('accepts V2, V3 and V1 cards and applies defaults', () => {
    expect(parseCardObject(v2).name).toBe('Mira');
    expect(parseCardObject({ ...v2, spec: 'chara_card_v3' }).first_mes).toBe('hey');
    const v1 = parseCardObject({ name: 'Old', description: 'x' });
    expect(v1.tags).toEqual([]);
    expect(v1.post_history_instructions).toBe('');
  });

  it('rejects invalid cards', () => {
    expect(() => parseCardObject({ spec: 'chara_card_v2', data: { name: '' } })).toThrow(/invalid card/);
    expect(() => parseCardObject(42)).toThrow();
  });
});

describe('extractCardJsonFromPng', () => {
  it('reads the chara chunk and prefers ccv3', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    expect(JSON.parse(extractCardJsonFromPng(pngWithText({ chara: b64(v2) }))).data.name).toBe('Mira');
    const both = pngWithText({ chara: b64({ name: 'old' }), ccv3: b64({ name: 'new' }) });
    expect(JSON.parse(extractCardJsonFromPng(both)).name).toBe('new');
  });

  it('rejects non-PNG, truncated and card-less files', () => {
    expect(() => extractCardJsonFromPng(Buffer.from('hello world'))).toThrow(/not a PNG/);
    expect(() => extractCardJsonFromPng(pngWithText({ Comment: 'x' }))).toThrow(/no character data/);
    const truncated = pngWithText({ chara: 'AAAA' }).subarray(0, 30);
    expect(() => extractCardJsonFromPng(truncated)).toThrow(/truncated/);
  });
});

describe('loadCardFile / CharacterRepository', () => {
  it('loads a directory, skipping invalid cards and de-duplicating ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girllm-'));
    await writeFile(join(dir, 'mira.json'), JSON.stringify(v2));
    await writeFile(join(dir, 'mira.png'), pngWithText({ chara: Buffer.from(JSON.stringify(v2)).toString('base64') }));
    await writeFile(join(dir, 'broken.json'), '{nope');
    await writeFile(join(dir, 'notes.txt'), 'ignored');

    const warnings: string[] = [];
    const repo = await CharacterRepository.loadFromDirectory(dir, { info: () => {}, warn: (m) => warnings.push(m) });
    expect(
      repo
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(['mira', 'mira-2']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/broken\.json/);
  });

  it('rejects unsupported extensions', async () => {
    await expect(loadCardFile('x.txt')).rejects.toThrow(/unsupported extension/);
  });
});

describe('shipped character cards', () => {
  it('load and pass the image safety rules', async () => {
    // Whatever cards the repository ships (they change over time), not a fixed list.
    const files = (await readdir('characters')).filter((f) => /\.(json|png)$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const card = await loadCardFile(join('characters', file));
      // The appearance is optional (a card made in the editor may not have one
      // yet); when set, it must describe an adult.
      expect(mentionsMinor(card.appearance), file).toBe(false);
      expect(cardStatesMinorAge(card.description), file).toBe(false);
    }
  });
});
