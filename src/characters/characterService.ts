/**
 * Character lifecycle beyond the card file: deleting a character also
 * deletes its chats (and their photos), its long-term memories, its
 * reference face, its chat background and its voice, so nothing orphaned
 * stays on disk.
 */
import { SessionBusyError, type ChatService } from '../chat/chatService.js';
import type { SessionStore } from '../chat/sessionStore.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { CharacterRepository } from './characterRepository.js';
import type { VoiceStore } from '../voice/voiceStore.js';
import type { FaceStore } from './faceStore.js';

export class CharacterService {
  constructor(
    private readonly repo: CharacterRepository,
    private readonly chat: ChatService,
    private readonly sessions: SessionStore,
    private readonly memories: MemoryStore,
    private readonly faces: FaceStore,
    /** Chat backgrounds (optional). */
    private readonly backgrounds?: FaceStore,
    /** Reference voices (optional). */
    private readonly voices?: VoiceStore,
  ) {}

  /**
   * Delete a character and everything attached to it.
   * @returns false if it didn't exist.
   * @throws SessionBusyError if one of its chats is generating a reply.
   */
  async remove(characterId: string): Promise<{ chats: number; memories: number } | false> {
    if (!this.repo.get(characterId)) return false;
    const sessionIds = this.sessions.listIdsByCharacter(characterId);
    // Check everything first: never stop halfway through a deletion.
    if (sessionIds.some((id) => this.chat.isBusy(id))) throw new SessionBusyError();
    // ChatService.deleteSession also deletes the chats' photo files.
    for (const id of sessionIds) this.chat.deleteSession(id);
    const memories = this.memories.deleteByCharacter(characterId);
    await this.faces.remove(characterId);
    await this.backgrounds?.remove(characterId);
    await this.voices?.remove(characterId);
    await this.repo.remove(characterId);
    return { chats: sessionIds.length, memories };
  }
}
