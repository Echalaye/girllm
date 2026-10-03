/**
 * In-memory registry of the character cards found in CHARACTERS_DIR.
 *
 * Cards are read once at startup. Client requests only ever reference a
 * character by id (a lookup in this map), never by path, so there is no
 * path-traversal surface.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadCardFile } from './cardLoader.js';
import type { Character } from './schema.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class CharacterRepository {
  private constructor(private readonly byId: ReadonlyMap<string, Character>) {}

  /**
   * Load every .json/.png card of a directory. Invalid cards are logged and
   * skipped so one broken download doesn't prevent the app from starting.
   */
  static async loadFromDirectory(dir: string, log: Logger): Promise<CharacterRepository> {
    const absDir = resolve(dir);
    const entries = await readdir(absDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && /\.(json|png)$/i.test(e.name))
      .map((e) => join(absDir, e.name))
      .sort();

    const results = await Promise.allSettled(files.map((f) => loadCardFile(f)));
    const byId = new Map<string, Character>();

    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn((r.reason as Error).message);
        continue;
      }
      const card = r.value;
      // Disambiguate duplicate ids (e.g. "aria.json" + "aria.png").
      let id = card.id;
      for (let n = 2; byId.has(id); n++) id = `${card.id}-${n}`;
      byId.set(id, { ...card, id });
    }

    log.info(`Loaded ${byId.size} character card(s) from ${absDir}`);
    return new CharacterRepository(byId);
  }

  /** Build a repository from already-loaded characters (tests). */
  static fromCharacters(characters: Character[]): CharacterRepository {
    return new CharacterRepository(new Map(characters.map((c) => [c.id, c])));
  }

  get(id: string): Character | undefined {
    return this.byId.get(id);
  }

  list(): Character[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
