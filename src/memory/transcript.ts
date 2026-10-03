/** Formats messages as a plain transcript for summarisation / extraction prompts. */
import type { StoredMessage } from '../chat/sessionStore.js';

/** Per-message cap so one huge message can't blow the helper prompt. */
const MAX_CHARS_PER_MESSAGE = 2000;

export function formatTranscript(messages: readonly StoredMessage[], charName: string, userName: string): string {
  return messages
    .map((m) => {
      const who = m.role === 'user' ? userName : charName;
      const text = m.content.length > MAX_CHARS_PER_MESSAGE ? `${m.content.slice(0, MAX_CHARS_PER_MESSAGE)}…` : m.content;
      return `${who}: ${text}`;
    })
    .join('\n');
}
