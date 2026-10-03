/**
 * Scenarios and automatic checks for `npm run compare` (model comparison).
 * Pure functions: unit-tested in tests/compare.test.ts.
 */
import type { ChatMessage } from '../src/llm/types.js';

export interface Scenario {
  id: string;
  /** What this scenario is meant to reveal. */
  goal: string;
  /** Conversation so far; must end with the user's message. */
  history: ChatMessage[];
  /** Long-term memories given to the model (memory system simulation). */
  memories?: string[];
  /** Pause before the last user message, in ms (time awareness). */
  pauseMs?: number;
}

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

/** French scenarios (used when REPLY_LANGUAGE is French). */
export const SCENARIOS_FR: Scenario[] = [
  {
    id: 'pause',
    goal: 'Reacts naturally to a 2-day silence, without being dramatic or robotic',
    history: [a('Bonne nuit toi 😘'), u("Coucou… désolé, j'ai été débordé ces deux derniers jours")],
    pauseMs: 2 * 86_400_000,
  },
  {
    id: 'tired',
    goal: 'Short, warm texting reply; brings her own day in',
    history: [a('Alors, cette journée ?'), u('Je viens de finir le boulot, je suis mort')],
  },
  {
    id: 'bad-news',
    goal: 'Emotional support that sounds human, not like a therapist or customer service',
    history: [
      a('Tu fais une drôle de tête dans ton message 😅'),
      u("Mon projet au taf vient d'être annulé. Six mois de boulot pour rien."),
    ],
  },
  {
    id: 'memory',
    goal: 'Uses a stored memory correctly and casually',
    history: [a('Tu rentres tard ce soir ?'), u('Tu te souviens où je bosse au fait ?')],
    memories: ['Etienne travaille chez Airbus à Toulouse, sur des images satellites'],
  },
  {
    id: 'opinion',
    goal: 'Has her own opinion and can disagree playfully',
    history: [a('Tu fais quoi ce soir ?'), u("Franchement, l'escalade c'est surcoté non ?")],
  },
  {
    id: 'playful',
    goal: 'Playful back-and-forth, short, not a list of guesses',
    history: [a('Coucou toi'), u("Devine ce que j'ai mangé ce midi")],
  },
];

/** Phrases that make a reply sound like an AI assistant rather than a person. */
const ASSISTANT_ISMS = [
  /en tant qu['’]ia/i,
  /je suis (là|toujours là) pour toi/i,
  /n['’]hésite pas à/i,
  /je comprends (parfaitement|tout à fait) (ce que tu ressens|ta frustration)/i,
  /c['’]est tout à fait normal de/i,
  /voici (quelques|des) (idées|conseils|suggestions)/i,
  /as an ai/i,
  /i['’]m (always )?here for you/i,
  /feel free to/i,
  /^\s*[-•]\s/m, // bullet lists
  /^\s*\d+\.\s/m, // numbered lists
];

export function assistantIsms(text: string): string[] {
  return ASSISTANT_ISMS.filter((re) => re.test(text)).map((re) => re.source);
}

const FRENCH_WORDS = new Set(
  'je tu il elle on nous vous les des une un est pas que qui pour avec dans mais ça ce cette mon ton ma ta trop bien tout fait'.split(
    ' ',
  ),
);
const ENGLISH_WORDS = new Set(
  'the you and is are was not that with for this have just what your but my so too all do it i'.split(' '),
);

/** Rough language check: share of French function words among FR+EN ones (0–1). */
export function frenchRatio(text: string): number {
  const tokens = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let fr = 0;
  let en = 0;
  for (const t of tokens) {
    if (FRENCH_WORDS.has(t)) fr++;
    else if (ENGLISH_WORDS.has(t)) en++;
  }
  return fr + en === 0 ? 1 : fr / (fr + en);
}

/** Did the model write the user's lines (a classic small-model failure)? */
export function speaksForUser(text: string, userName: string): boolean {
  return new RegExp(`(^|\\n)\\s*\\**${userName}\\**\\s*:`, 'i').test(text);
}

export interface ReplyCheck {
  chars: number;
  sentences: number;
  french: number;
  assistantIsms: string[];
  speaksForUser: boolean;
}

export function checkReply(text: string, userName: string): ReplyCheck {
  return {
    chars: text.length,
    sentences: (text.replace(/\*[^*]*\*/g, '').match(/[.!?…]+(\s|$)/g) ?? []).length || (text.trim() ? 1 : 0),
    french: frenchRatio(text),
    assistantIsms: assistantIsms(text),
    speaksForUser: speaksForUser(text, userName),
  };
}

/** Markdown-safe single-line cell. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ⏎ ');
}
