import { describe, expect, it } from 'vitest';
import { asksForPhoto, messagesSinceLastPhoto, PhotoTagFilter, stripPhotoTags } from '../src/chat/photoTag.js';

/** Stream `text` in chunks of `size` characters through the filter. */
function stream(text: string, size: number) {
  const f = new PhotoTagFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.end();
  return { out, photo: f.photo };
}

describe('PhotoTagFilter', () => {
  it('removes the tag and captures its description, whatever the chunking', () => {
    const text = 'Regarde ma nouvelle robe ! [photo: mirror selfie, red summer dress, bedroom] Tu aimes ?';
    for (const size of [1, 2, 3, 7, 200]) {
      const { out, photo } = stream(text, size);
      expect(out).toBe('Regarde ma nouvelle robe !  Tu aimes ?');
      expect(photo).toBe('mirror selfie, red summer dress, bedroom');
    }
  });

  it('accepts variants: [Photo : …], [selfie: …], and a tag cut by the end of the stream', () => {
    expect(stripPhotoTags('Tiens [Photo : at the beach]')).toEqual({ text: 'Tiens ', photo: 'at the beach' });
    expect(stripPhotoTags('Coucou [selfie: smiling]').photo).toBe('smiling');
    expect(stripPhotoTags('Voilà [photo: on the sofa, cozy').photo).toBe('on the sofa, cozy');
    expect(stripPhotoTags('Voilà [photo: on the sofa, cozy').text).toBe('Voilà ');
  });

  it('leaves normal brackets alone', () => {
    for (const text of ['[rires] t’es bête', 'Le prix [environ 20 €] est ok', 'a [ph] b', 'fin [']) {
      expect(stream(text, 2)).toEqual({ out: text, photo: undefined });
    }
  });

  it('keeps only the first photo but hides every tag', () => {
    expect(stripPhotoTags('[photo: one] et [photo: two]')).toEqual({ text: ' et ', photo: 'one' });
  });
});

describe('asksForPhoto', () => {
  it('recognises photo requests in French and English', () => {
    for (const t of [
      'Envoie-moi une photo !',
      'tu me montres ta tenue ?',
      'montre-toi',
      'send me a pic',
      'Un petit selfie ?',
      'Show me your outfit',
    ]) {
      expect(asksForPhoto(t)).toBe(true);
    }
  });

  it('ignores messages that only mention photos', () => {
    for (const t of ["J'ai vu ta photo de profil", 'Je prends des photos au travail', 'On se voit demain ?']) {
      expect(asksForPhoto(t)).toBe(false);
    }
  });
});

describe('messagesSinceLastPhoto', () => {
  it('counts her messages after the last photo', () => {
    const m = (role: string, imageId: string | null = null) => ({ role, imageId });
    expect(messagesSinceLastPhoto([m('user'), m('assistant')])).toBe(Number.POSITIVE_INFINITY);
    expect(messagesSinceLastPhoto([m('assistant', 'i1'), m('user'), m('assistant'), m('user'), m('assistant')])).toBe(
      2,
    );
  });
});
