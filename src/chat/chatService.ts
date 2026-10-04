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
import type { Session, SessionListItem, SessionStore, StoredMessage } from './sessionStore.js';

export interface ChatServiceOptions {
  userName: string;
  budget: PromptBudget;
  temperature: number;
  topP: number;
  minP?: number | undefined;
  repeatPenalty?: number | undefined;
  /** Force replies in this language (e.g. "French"). */
  replyLanguage?: string | undefined;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

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
  ): Promise<ReplyResult> {
    return this.withLock(sessionId, async () => {
      this.getSession(sessionId); // validate before mutating
      this.sessions.appendMessage(sessionId, 'user', text);
      return this.generate(sessionId, onToken, signal);
    });
  }

  /** Discard the last reply (if any) and generate a new one ("swipe"). */
  regenerate(sessionId: string, onToken: (t: string) => void, signal?: AbortSignal): Promise<ReplyResult> {
    return this.withLock(sessionId, async () => {
      const { session } = this.getSession(sessionId);
      const last = session.messages.at(-1);
      // Never regenerate the greeting alone: there must be a user turn.
      if (last?.role === 'assistant' && session.messages.length > 1) {
        this.sessions.popLastIf(sessionId, 'assistant');
      }
      if (this.sessions.get(sessionId)?.messages.at(-1)?.role !== 'user') {
        throw new NotFoundError('User message to reply to');
      }
      return this.generate(sessionId, onToken, signal);
    });
  }

  private async generate(sessionId: string, onToken: (t: string) => void, signal?: AbortSignal): Promise<ReplyResult> {
    const { session, character } = this.getSession(sessionId);
    // Messages already folded into the summary are represented by it.
    const history: ChatMessage[] = session.messages
      .filter((m) => m.seq > session.summarizedUntil)
      .map((m) => ({ role: m.role, content: this.withPhotoNote(m, character.name) }));
    const memory = this.memory ? await this.memory.buildContext(session) : undefined;
    const prompt = buildPrompt(character, history, this.opts.userName, this.opts.budget, {
      replyLanguage: this.opts.replyLanguage,
      memory,
      time: { now: (this.opts.now ?? (() => new Date()))(), previousMessageAt: previousMessageTime(session.messages) },
    });

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
        reply += delta;
        onToken(delta);
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
      aborted = true; // Client stopped: keep what was generated so far.
    }

    const content = reply.trim();
    const message = content ? this.sessions.appendMessage(sessionId, 'assistant', content) : undefined;
    // Summarize / learn in the background, after the reply is delivered.
    if (message) this.memory?.schedule(sessionId);
    return { message, estimatedTokens: prompt.estimatedTokens, droppedMessages: prompt.droppedMessages, aborted };
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
