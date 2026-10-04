/**
 * Registry of the character cards in CHARACTERS_DIR, editable from the app.
 *
 * Client requests only ever reference a character by id (a lookup in this
 * map), never by path: file names are derived from slugified names inside
 * CHARACTERS_DIR, so there is no path-traversal surface.
 *
 * Edited and created characters are saved as Character Card V2 JSON, so
 * they stay compatible with SillyTavern & co.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../util/atomicWrite.js';
import { Mutex } from '../util/mutex.js';
import { cardStatesMinorAge, mentionsMinor } from '../images/safety.js';
import { loadCardFile, parseCardObject, slugify } from './cardLoader.js';
import { readAppearance, readStyle, type CardFields, type Character, type CharacterInput } from './schema.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Thrown when a card describes a minor: girllm only supports adult characters. */
export class CharacterRejectedError extends Error {
  constructor() {
    super('Characters must be adults. Remove any age under 18 from the card.');
    this.name = 'CharacterRejectedError';
  }
}

/** @throws CharacterRejectedError if the card states an under-18 age or a minor appearance. */
export function assertAdultCharacter(fields: Pick<CardFields, 'description' | 'personality' | 'scenario' | 'first_mes' | 'system_prompt'> & { appearance?: string }): void {
  const text = [fields.description, fields.personality, fields.scenario, fields.first_mes, fields.system_prompt].join('\n');
  if (cardStatesMinorAge(text) || mentionsMinor(fields.appearance ?? '')) throw new CharacterRejectedError();
}

/** Folder (inside CHARACTERS_DIR) where replaced PNG cards are kept, not loaded. */
const ORIGINALS_DIR = '.originals';

export class CharacterRepository {
  /** Serializes writes: two concurrent creations must not pick the same id. */
  private readonly writes = new Mutex();

  private constructor(
    private readonly byId: Map<string, Character>,
    /** Absolute CHARACTERS_DIR; undefined = read-only (tests). */
    private readonly dir: string | undefined,
  ) {}

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
    return new CharacterRepository(byId, absDir);
  }

  /** Build a read-only repository from already-loaded characters (tests). */
  static fromCharacters(characters: Character[]): CharacterRepository {
    return new CharacterRepository(new Map(characters.map((c) => [c.id, c])), undefined);
  }

  get(id: string): Character | undefined {
    return this.byId.get(id);
  }

  list(): Character[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create (no `id`) or update a character, and save it as a V2 JSON card.
   * The id never changes on update, even if the name does (chats and
   * memories reference it).
   */
  save(input: CharacterInput, id?: string): Promise<Character> {
    return this.writes.run(() => this.saveNow(input, id));
  }

  private async saveNow(input: CharacterInput, id?: string): Promise<Character> {
    const dir = this.requireWritable();
    const existing = id ? this.byId.get(id) : undefined;
    if (id && !existing) throw new Error(`Character ${id} not found`);
    assertAdultCharacter(input);

    const finalId = existing?.id ?? this.newId(input.name);
    const path = join(dir, `${finalId}.json`);
    const card = this.toCardJson(input, existing);
    // Round-trip through the loader's validation: what we write must load.
    const fields = parseCardObject(JSON.parse(JSON.stringify(card)));
    await writeFileAtomic(path, `${JSON.stringify(card, null, 2)}\n`);

    // The card now lives in <id>.json. If it came from another file (a PNG
    // card, or a JSON with a different name), move that one aside so it isn't
    // loaded again as a duplicate (kept, not deleted).
    if (existing && resolve(existing.sourceFile) !== path) {
      await this.moveToOriginals(existing.sourceFile);
    }

    const character: Character = {
      ...fields,
      id: finalId,
      sourceFile: path,
      appearance: readAppearance(fields.extensions),
      style: readStyle(fields.extensions),
    };
    this.byId.set(finalId, character);
    return character;
  }

  /** Validate and add a card file's content (import from SillyTavern, chub.ai…). */
  async import(card: CardFields): Promise<Character> {
    assertAdultCharacter({ ...card, appearance: readAppearance(card.extensions) });
    return this.save({
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      creator_notes: card.creator_notes,
      tags: card.tags.slice(0, 20).map((t) => t.slice(0, 40)).filter(Boolean),
      style: readStyle(card.extensions),
      appearance: readAppearance(card.extensions),
    });
  }

  /** Delete the card file (PNG cards are moved aside rather than deleted). */
  remove(id: string): Promise<boolean> {
    return this.writes.run(async () => {
      this.requireWritable();
      const existing = this.byId.get(id);
      if (!existing) return false;
      if (extname(existing.sourceFile).toLowerCase() === '.png') await this.moveToOriginals(existing.sourceFile);
      else await rm(existing.sourceFile, { force: true });
      this.byId.delete(id);
      return true;
    });
  }

  /** V2 card JSON for export (same format as the saved file). */
  exportCard(id: string): object | undefined {
    const c = this.byId.get(id);
    return c ? this.toCardJson(c, c) : undefined;
  }

  // ---------------------------------------------------------------- helpers

  private requireWritable(): string {
    if (!this.dir) throw new Error('This character repository is read-only');
    return this.dir;
  }

  /** Unique id from the name, not used by a loaded card nor an existing file. */
  private newId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.byId.has(id) || existsSync(join(this.dir!, `${id}.json`)); n++) id = `${base}-${n}`;
    return id;
  }

  private toCardJson(input: CharacterInput, existing?: Character) {
    const extensions = { ...(existing?.extensions ?? {}) };
    const girllm = { ...((extensions.girllm as Record<string, unknown> | undefined) ?? {}) };
    girllm.style = input.style;
    if (input.appearance) girllm.appearance = input.appearance;
    else delete girllm.appearance;
    extensions.girllm = girllm;
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: input.name,
        description: input.description,
        personality: input.personality,
        scenario: input.scenario,
        first_mes: input.first_mes,
        mes_example: input.mes_example,
        system_prompt: input.system_prompt,
        post_history_instructions: input.post_history_instructions,
        creator_notes: input.creator_notes,
        alternate_greetings: existing?.alternate_greetings ?? [],
        tags: input.tags,
        creator: existing?.creator ?? '',
        character_version: existing?.character_version ?? '',
        extensions,
      },
    };
  }

  private async moveToOriginals(file: string): Promise<void> {
    const target = join(dirname(file), ORIGINALS_DIR, basename(file));
    await mkdir(dirname(target), { recursive: true });
    await rename(file, existsSync(target) ? `${target}.${Date.now()}` : target);
  }
}
