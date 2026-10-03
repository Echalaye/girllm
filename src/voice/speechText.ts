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
