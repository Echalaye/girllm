/**
 * Hard safety rule: girllm never generates images that could depict a
 * minor. This is enforced in code (not configurable) on:
 *   - the user's photo request,
 *   - the prompt written by the LLM,
 *   - the final positive prompt (incl. the card's appearance),
 *   - the character card itself (explicit under-18 ages refuse all images).
 * Every positive prompt also states "adult", and terms describing minors
 * are always appended to the negative prompt.
 *
 * The check is deliberately conservative: a false positive only means one
 * photo request is refused.
 */

/**
 * Word boundaries that understand accented letters: JavaScript's \b only
 * knows ASCII, so /\bbébé\b/ would never match "bébé ".
 */
const W_START = '(?<![\\p{L}\\p{N}_])';
const W_END = '(?![\\p{L}\\p{N}_])';
const words = (list: string[]) => new RegExp(`${W_START}(?:${list.join('|')})${W_END}`, 'iu');

const MINOR_TERMS = [
  // English
  words([
    'child',
    'children',
    'kid',
    'kids',
    'toddler',
    'baby',
    'infant',
    'loli',
    'lolicon',
    'shota',
    'shotacon',
    'teen',
    'teens',
    'teenage',
    'teenager',
    'teenagers',
    'underage',
    'under-age',
    'minor',
    'minors',
    'preteen',
    'pre-teen',
    'tween',
    'young girl',
    'little girl',
    'young boy',
    'little boy',
    'schoolgirl',
    'schoolboy',
    'school girl',
    'school uniform',
    'elementary school',
    'middle school',
    'junior high',
    'high schooler',
    'jailbait',
    'childlike',
    'child-like',
  ]),
  // French
  words([
    'enfant',
    'enfants',
    'fillette',
    'fillettes',
    'gamine',
    'gamin',
    'gosse',
    'gosses',
    'bébé',
    'ado',
    'ados',
    'adolescent',
    'adolescente',
    'adolescents',
    'adolescentes',
    'mineur',
    'mineure',
    'mineurs',
    'mineures',
    'collégienne',
    'collégien',
    'lycéenne',
    'lycéen',
    'écolière',
    'écolier',
    'petite fille',
    'petit garçon',
    'jeune fille',
    'uniforme scolaire',
  ]),
];

/** "16 yo", "15-year-old", "14 ans", "aged 12", "âgée de 15"… — any age from 0 to 17. */
const AGE = '(?:[0-9]|1[0-7])';
const MINOR_AGE = new RegExp(
  `${W_START}${AGE}[\\s-]*(?:yo|y/o|y\\.o\\.|years?[\\s-]*old|ans)${W_END}` +
    `|${W_START}(?:aged?|âgée?)\\s+(?:de\\s+)?${AGE}${W_END}`,
  'iu',
);

/** Always appended to the negative prompt. */
export const MINOR_NEGATIVE_TERMS =
  'child, children, kid, teen, teenager, underage, minor, loli, young girl, childlike';

/** Always prepended to the positive prompt. */
export const ADULT_POSITIVE_TERMS = 'adult, mature adult';

export class ImageRefusedError extends Error {
  constructor() {
    // Deliberately generic: the message doesn't explain what triggered it.
    super("This photo can't be generated.");
    this.name = 'ImageRefusedError';
  }
}

/** True if the text mentions minors or an under-18 age. */
export function mentionsMinor(text: string): boolean {
  return MINOR_AGE.test(text) || MINOR_TERMS.some((re) => re.test(text));
}

/**
 * Character cards are free text ("she illustrates children's books" is
 * fine), so only explicit under-18 ages disqualify a character.
 */
export function cardStatesMinorAge(text: string): boolean {
  return MINOR_AGE.test(text);
}

/** @throws ImageRefusedError if any text mentions a minor. */
export function assertSafe(...texts: string[]): void {
  if (texts.some((t) => mentionsMinor(t))) throw new ImageRefusedError();
}
