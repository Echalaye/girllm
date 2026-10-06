/**
 * The "no minors" rule for voices (step 7). A designed voice must be an
 * adult's: the description goes through the same checks as a FLUX.2 photo
 * prompt (minor terms, under-18 ages, young-look words) plus words that ask
 * for a child's voice, and the designed voice is always described as an
 * adult's (adultVoicePrefix). A card stating an under-18 age gets no voice.
 */
import { cardStatesMinorAge, mentionsMinor, mentionsYoungLook } from '../images/safety.js';

export class VoiceRefusedError extends Error {
  constructor() {
    // Deliberately generic, like ImageRefusedError.
    super("This voice can't be created.");
    this.name = 'VoiceRefusedError';
  }
}

const W_START = '(?<![\\p{L}\\p{N}_])';
const W_END = '(?![\\p{L}\\p{N}_])';
const words = (list: string[]) => new RegExp(`${W_START}(?:${list.join('|')})${W_END}`, 'iu');

/** Ways of asking for a child's voice that name no minor. */
const CHILD_VOICE_TERMS = words([
  'childlike',
  'child-like',
  'babyish',
  'baby voice',
  'baby-voiced',
  'prepubescent',
  'pre-pubescent',
  'squeaky',
  'cartoon child',
  "voix d'enfant",
  'voix de bébé',
  'voix enfantine',
  'voix de petite fille',
  'voix de petit garçon',
  'fillette',
  'gamine',
  'prépubère',
]);

/** True if a voice description asks for a minor's voice in any way. */
export function mentionsChildVoice(text: string): boolean {
  return mentionsMinor(text) || mentionsYoungLook(text) || CHILD_VOICE_TERMS.test(text);
}

/** @throws VoiceRefusedError */
export function assertVoiceSafe(...texts: string[]): void {
  if (texts.some((t) => mentionsChildVoice(t))) throw new VoiceRefusedError();
}

/** @throws VoiceRefusedError if the card states an under-18 age. */
export function assertCardVoiceSafe(card: string): void {
  if (cardStatesMinorAge(card)) throw new VoiceRefusedError();
}

/** Always first in a design description: the voice is an adult's. */
export function adultVoicePrefix(gender: 'female' | 'male'): string {
  return gender === 'male' ? "An adult man's voice." : "An adult woman's voice.";
}
