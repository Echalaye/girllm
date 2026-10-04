/**
 * Chat orchestration: store the user's message, build the prompt, stream
 * the model's reply and persist it. Transport-agnostic (no HTTP here), so
 * it is unit-testable and reusable for a future voice or CLI front-end.
 */
import type { CharacterRepository } from '../characters/characterRepository.js';
import { resolve, type Live } from '../util/resolve.js';
import type { Character } from '../characters/schema.js';
import type { ChatMessage, LlmProvider } from '../llm/types.js';
import type { ImageService } from '../images/imageService.js';
import type { MemoryService } from '../memory/memoryService.js';
import { applyMacros, buildPrompt, stopSequencesFor, type PromptBudget } from '../prompt/promptBuilder.js';
import { describeGap } from '../prompt/timeContext.js';
import { selectLore } from '../prompt/lorebook.js';
import type { PhotoFrequency } from '../config.js';
import { asksForPhoto, messagesSinceLastPhoto, PHOTO_COOLDOWN, PhotoTagFilter } from './photoTag.js';
import type { MessageKind, Session, SessionListItem, SessionStore, StoredMessage } from './sessionStore.js';

export interface ChatServiceOptions {
  userName: string;
  budget: PromptBudget;
  temperature: number;
  topP: number;
  minP?: number | undefined;
  repeatPenalty?: number | undefined;
  /** Force replies in this language (e.g. "French"). */
  replyLanguage?: string | undefined;
  /** Photos she sends on her own ("off" when undefined). */
  photoFrequency?: PhotoFrequency | undefined;
  /** Minutes of silence before she may write first; 0 / undefined = never. */
  proactiveAfterMinutes?: number | undefined;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

/** Why she writes without being answered: first message of a chat, or after a silence. */
export type InitiateReason = MessageKind;

/** Things that happen around a reply, for the transport (SSE) to forward. */
export type ChatEvent =
  /** The text is complete (sent before a photo, which can take a minute). */
  | { type: 'done'; result: ReplyResult }
  | { type: 'photo_start' }
  | { type: 'photo'; messageId: string; imageId: string }
  /** The text reply stands; only the photo failed or was refused. */
  | { type: 'photo_error'; error: unknown };

export interface ReplyResult {
  message: StoredMessage | undefined;
  estimatedTokens: number;
  droppedMessages: number;
  aborted: boolean;
}

/** Thrown when a second generation is requested while one is running. */
export class SessionBusyError extends Error {
  constructor() {
    super('A reply is already being generated for this session');
    this.name = 'SessionBusyError';
  }
}

/** Thrown when she may not write first right now (see ChatService.canInitiate). */
export class NotAllowedError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'NotAllowedError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ChatService {
  /** Sessions currently generating: one generation per session at a time. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly characters: CharacterRepository,
    private readonly sessions: SessionStore,
    private readonly llm: LlmProvider,
    /** Fixed options, or a function returning the current ones (live settings). */
    private readonly options: Live<ChatServiceOptions>,
    /** Optional: without it the app behaves like step 1 (no long-term memory). */
    private readonly memory?: MemoryService,
    /** Optional: photo generation (step 4). */
    private readonly images?: ImageService,
  ) {}

  /** Current options (re-read on every use). */
  private get opts(): ChatServiceOptions {
    return resolve(this.options);
  }

  createSession(characterId: string): { session: Session; character: Character } {
    const character = this.characters.get(characterId);
    if (!character) throw new NotFoundError('Character');
    // Macros are resolved once here so the UI shows "Hi Etienne", not "Hi {{user}}".
    const greeting = applyMacros(character.first_mes, character.name, this.opts.userName);
    const session = this.sessions.create(character.id, greeting);
    return { session, character };
  }

  getSession(sessionId: string): { session: Session; character: Character } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundError('Session');
    const character = this.characters.get(session.characterId);
    if (!character) throw new NotFoundError('Character');
    return { session, character };
  }

  listSessions(characterId: string): SessionListItem[] {
    if (!this.characters.get(characterId)) throw new NotFoundError('Character');
    return this.sessions.listByCharacter(characterId);
  }

  /** Is a reply (or photo) being generated for this chat right now? */
  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  deleteSession(sessionId: string): void {
    if (this.busy.has(sessionId)) throw new SessionBusyError();
    const files = this.images?.collectFiles(sessionId) ?? [];
    if (!this.sessions.delete(sessionId)) throw new NotFoundError('Session');
    void this.images?.deleteFiles(files); // best effort, after the DB change
  }

  /** Have the character send a photo (step 4). One action per session at a time. */
  sendPhoto(sessionId: string, request: string, signal?: AbortSignal): Promise<StoredMessage> {
    return this.withLock(sessionId, async () => {
      if (!this.images) throw new NotFoundError('Image generation');
      this.getSession(sessionId);
      return this.images.createPhoto(sessionId, request, signal);
    });
  }

  /** Add the user's message and stream the character's reply. */
  sendMessage(
    sessionId: string,
    text: string,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    onEvent?: (e: ChatEvent) => void,
  ): Promise<ReplyResult> {
    return this.withLock(sessionId, async () => {
      this.getSession(sessionId); // validate before mutating
      this.sessions.appendMessage(sessionId, 'user', text);
      return this.generate(sessionId, { onToken, onEvent, signal });
    });
  }

  /**
   * Discard the last reply (if any) and generate a new one ("swipe").
   * A message she wrote on her own (opening, nudge) is rewritten as such.
   */
  regenerate(
    sessionId: string,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    onEvent?: (e: ChatEvent) => void,
  ): Promise<ReplyResult> {
    return this.withLock(sessionId, async () => {
      const { session } = this.getSession(sessionId);
      const last = session.messages.at(-1);
      if (last?.role === 'assistant' && last.kind) {
        this.sessions.popLastIf(sessionId, 'assistant');
        return this.generate(sessionId, { onToken, onEvent, signal, initiate: last.kind });
      }
      // Never regenerate the greeting alone: there must be a user turn.
      if (last?.role === 'assistant' && session.messages.length > 1) {
        this.sessions.popLastIf(sessionId, 'assistant');
      }
      if (this.sessions.get(sessionId)?.messages.at(-1)?.role !== 'user') {
        throw new NotFoundError('User message to reply to');
      }
      return this.generate(sessionId, { onToken, onEvent, signal });
    });
  }

  /**
   * May she write first right now?
   *  - opening: the chat is empty (her card has no fixed first message);
   *  - nudge: the setting allows it, the silence is long enough, and her
   *    last message isn't already an unanswered nudge (never two in a row).
   */
  canInitiate(sessionId: string, reason: InitiateReason): boolean {
    const { session } = this.getSession(sessionId);
    const last = session.messages.at(-1);
    if (reason === 'opening') return session.messages.length === 0;
    const minutes = this.opts.proactiveAfterMinutes ?? 0;
    if (!last || minutes <= 0 || last.kind === 'nudge') return false;
    return this.now().getTime() - new Date(last.createdAt).getTime() >= minutes * 60_000;
  }

  /** She writes first (see canInitiate). @throws NotAllowedError when she may not. */
  initiate(
    sessionId: string,
    reason: InitiateReason,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    onEvent?: (e: ChatEvent) => void,
  ): Promise<ReplyResult> {
    return this.withLock(sessionId, async () => {
      if (!this.canInitiate(sessionId, reason)) throw new NotAllowedError(`Not the moment for a ${reason}`);
      return this.generate(sessionId, { onToken, onEvent, signal, initiate: reason });
    });
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /**
   * Stage direction for a message she writes first. It is sent as a user
   * turn (templates need the conversation to end with the user) but never
   * stored or shown.
   */
  private stageDirection(reason: InitiateReason, session: Session, charName: string): string {
    const user = this.opts.userName;
    if (reason === 'opening') {
      return `(${user} has just opened the chat. Write ${charName}'s first message to ${user}, fitting the scenario and the current time of day.)`;
    }
    const last = session.messages.at(-1);
    const gap = last ? describeGap(this.now().getTime() - new Date(last.createdAt).getTime()) : 'a while';
    const lastWasHers = last?.role === 'assistant';
    return (
      `(${user} hasn't written for ${gap}${lastWasHers ? ` and hasn't answered ${charName}'s last message` : ''}. ` +
      `${charName} decides to text ${user} first: write that message, natural for her mood and the time of day. ` +
      `Don't repeat her previous message.)`
    );
  }

  private async generate(
    sessionId: string,
    run: {
      onToken: (t: string) => void;
      onEvent?: ((e: ChatEvent) => void) | undefined;
      signal?: AbortSignal | undefined;
      /** Set when she writes first (opening / nudge). */
      initiate?: InitiateReason | undefined;
    },
  ): Promise<ReplyResult> {
    const { onToken, onEvent, signal, initiate } = run;
    const { session, character } = this.getSession(sessionId);
    // Messages already folded into the summary are represented by it.
    const history: ChatMessage[] = session.messages
      .filter((m) => m.seq > session.summarizedUntil)
      .map((m) => ({ role: m.role, content: this.withPhotoNote(m, character.name) }));
    if (initiate) history.push({ role: 'user', content: this.stageDirection(initiate, session, character.name) });

    const photoAllowed = this.photoAllowed(session);
    const memory = this.memory ? await this.memory.buildContext(session) : undefined;
    const prompt = buildPrompt(character, history, this.opts.userName, this.opts.budget, {
      replyLanguage: this.opts.replyLanguage,
      memory,
      // For a message she starts, the stage direction already states the silence.
      time: { now: this.now(), previousMessageAt: initiate ? undefined : previousMessageTime(session.messages) },
      reminders: photoAllowed ? [photoReminder(photoAllowed)] : [],
      // Lorebook entries the recent conversation mentions (≤ 15% of the context).
      lore: selectLore(
        character.character_book,
        history.map((m) => m.content),
        Math.floor(this.opts.budget.contextTokens * LORE_BUDGET_SHARE),
      ),
    });

    // The photo tag is removed from the stream before anything is shown.
    const tags = new PhotoTagFilter();
    const emit = (text: string) => {
      if (text) onToken(text);
    };
    let reply = '';
    let aborted = false;
    try {
      for await (const delta of this.llm.streamChat(prompt.messages, {
        maxTokens: this.opts.budget.maxReplyTokens,
        temperature: this.opts.temperature,
        topP: this.opts.topP,
        ...(this.opts.minP !== undefined ? { minP: this.opts.minP } : {}),
        ...(this.opts.repeatPenalty !== undefined ? { repeatPenalty: this.opts.repeatPenalty } : {}),
        stop: stopSequencesFor(this.opts.userName),
        ...(signal ? { signal } : {}),
      })) {
        const visible = tags.push(delta);
        reply += visible;
        emit(visible);
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
      aborted = true; // Client stopped: keep what was generated so far.
    }
    const rest = tags.end();
    reply += rest;
    emit(rest);

    // A message that is only a photo still needs some text in the chat.
    const content = reply.trim() || (tags.photo && photoAllowed ? '📷' : '');
    const message = content
      ? this.sessions.appendMessage(sessionId, 'assistant', content, { kind: initiate })
      : undefined;
    // Summarize / learn in the background, after the reply is delivered.
    if (message) this.memory?.schedule(sessionId);
    const result: ReplyResult = {
      message,
      estimatedTokens: prompt.estimatedTokens,
      droppedMessages: prompt.droppedMessages,
      aborted,
    };
    onEvent?.({ type: 'done', result });

    // She decided to send a photo with this message (and is allowed to).
    if (message && !aborted && tags.photo && photoAllowed && this.images) {
      onEvent?.({ type: 'photo_start' });
      try {
        const imageId = await this.images.attachPhoto(sessionId, message.id, tags.photo, signal);
        onEvent?.({ type: 'photo', messageId: message.id, imageId });
      } catch (err) {
        onEvent?.({ type: 'photo_error', error: err });
      }
    }
    return result;
  }

  /**
   * May she send a photo with this reply? 'asked' when the user just asked
   * for one (no cooldown), 'spontaneous' when the cooldown has passed.
   */
  private photoAllowed(session: Session): 'asked' | 'spontaneous' | undefined {
    const frequency = this.opts.photoFrequency ?? 'off';
    if (frequency === 'off' || !this.images?.configured()) return undefined;
    const last = session.messages.at(-1);
    if (last?.role === 'user' && asksForPhoto(last.content)) return 'asked';
    return messagesSinceLastPhoto(session.messages) >= PHOTO_COOLDOWN[frequency] ? 'spontaneous' : undefined;
  }

  /** Photo messages: tell the model what the photo showed, so she knows what she sent. */
  private withPhotoNote(m: StoredMessage, charName: string): string {
    if (!m.imageId) return m.content;
    const scene = this.images?.get(m.imageId)?.scene;
    return scene ? `${m.content}\n*${charName} sent a photo: ${scene}*` : m.content;
  }

  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(sessionId)) throw new SessionBusyError();
    this.busy.add(sessionId);
    try {
      return await fn();
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

/**
 * When was the message BEFORE the user's latest one sent? (to measure the
 * pause the user just made). Undefined for the first exchange.
 */
export function previousMessageTime(messages: readonly StoredMessage[]): Date | undefined {
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const previous = lastUser > 0 ? messages[lastUser - 1] : undefined;
  return previous ? new Date(previous.createdAt) : undefined;
}

/** Share of the context window lorebook entries may use. */
const LORE_BUDGET_SHARE = 0.15;

/** Reminder telling the model how to send a photo (only when she may). */
function photoReminder(mode: 'asked' | 'spontaneous'): string {
  const how = 'end the message with [photo: what the photo shows, in a few words]';
  return mode === 'asked'
    ? `{{user}} is asking {{char}} for a photo. If {{char}} agrees, ${how}. She may also refuse, in character.`
    : `{{char}} can send {{user}} a photo from her phone when it really fits the moment (not often): then ${how}.`;
}
