/**
 * Turns a roleplay reply into text worth reading aloud.
 *
 * Actions written between asterisks ("*smiles*") are stage directions, not
 * speech: reading them aloud sounds robotic, so they are removed. So are
 * emojis, markdown symbols and URLs, which TTS engines spell out badly.
 */
export const MAX_TTS_CHARS = 1000;

export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ') // *actions*
    .replace(/https?:\/\/\S+/g, ' ') // URLs
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ') // emojis
    .replace(/[*_~`#>|[\]]/g, ' ') // leftover markdown
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whisper was trained on subtitled videos: on silence or background noise
 * it tends to "hear" subtitle credits and outros. In hands-free mode the
 * microphone picks up plenty of noise, so these phantom sentences must
 * never be sent to her as if the user had said them.
 */
const WHISPER_HALLUCINATIONS: readonly RegExp[] = [
  /sous-titr(?:es|age|é)/i, // "Sous-titres réalisés par la communauté d'Amara.org"
  /amara\.org/i,
  /merci d'avoir regardé/i,
  /abonnez-vous/i,
  /thanks? (?:you )?for watching/i,
  /please subscribe/i,
  /subtitles by/i,
];

/**
 * Normalize a transcript and drop known hallucinations.
 * @returns the cleaned text, or '' when nothing real was said.
 */
export function cleanTranscript(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  // Only punctuation / music notes ("...", "♪") = nothing was said.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return '';
  if (WHISPER_HALLUCINATIONS.some((re) => re.test(trimmed))) return '';
  return trimmed;
}
