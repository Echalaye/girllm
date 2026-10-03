/**
 * "What time is it for her?" — gives the character a sense of time: the
 * current day and hour, and how long since the previous message. Without
 * it, models say good morning at 11 pm and ignore a three-day silence.
 */

/** Locale used to write dates in the reply language (falls back to English). */
const LOCALES: Record<string, string> = {
  french: 'fr-FR',
  français: 'fr-FR',
  english: 'en-GB',
  spanish: 'es-ES',
  español: 'es-ES',
  german: 'de-DE',
  deutsch: 'de-DE',
  italian: 'it-IT',
  italiano: 'it-IT',
  portuguese: 'pt-PT',
};

export function localeFor(language: string | undefined): string {
  return (language && LOCALES[language.trim().toLowerCase()]) ?? 'en-GB';
}

/** "Saturday 3 October 2026, 23:01" in the given locale and time zone. */
export function formatNow(now: Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
}

/** Human description of a duration in English (the prompt's language). */
export function describeGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours > 1 ? 's' : ''}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** Gaps shorter than this are not worth mentioning. */
export const NOTABLE_GAP_MS = 30 * 60_000;
/** Gaps longer than this should be acknowledged by the character. */
export const LONG_GAP_MS = 6 * 60 * 60_000;
