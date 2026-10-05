/**
 * Metadata of generated images (the PNG files live in DATA_DIR/images).
 */
import { randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import type { Db } from '../db/database.js';

export interface StoredImage {
  id: string;
  sessionId: string;
  fileName: string;
  scene: string;
  prompt: string;
  seed: number;
  createdAt: string;
}

interface ImageRow {
  id: string;
  session_id: string;
  file_name: string;
  scene: string;
  prompt: string;
  seed: number;
  created_at: string;
}

const toImage = (r: ImageRow): StoredImage => ({
  id: r.id,
  sessionId: r.session_id,
  fileName: r.file_name,
  scene: r.scene,
  prompt: r.prompt,
  seed: r.seed,
  createdAt: r.created_at,
});

export class ImageStore {
  private readonly stmt: Record<string, StatementSync>;

  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stmt = {
      insert: db.prepare(
        'INSERT INTO images (id, session_id, file_name, scene, prompt, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      get: db.prepare('SELECT * FROM images WHERE id = ?'),
      bySession: db.prepare('SELECT * FROM images WHERE session_id = ?'),
      delete: db.prepare('DELETE FROM images WHERE id = ?'),
    };
  }

  /** @param id pre-generated so the file can be written before the row. */
  add(image: {
    id?: string;
    sessionId: string;
    fileName: string;
    scene: string;
    prompt: string;
    seed: number;
  }): StoredImage {
    const id = image.id ?? randomUUID();
    this.stmt.insert!.run(
      id,
      image.sessionId,
      image.fileName,
      image.scene,
      image.prompt,
      image.seed,
      this.now().toISOString(),
    );
    return this.get(id)!;
  }

  get(id: string): StoredImage | undefined {
    const row = this.stmt.get!.get(id) as ImageRow | undefined;
    return row ? toImage(row) : undefined;
  }

  /** Remove a row (retaken photo); messages showing it lose it (ON DELETE SET NULL). */
  delete(id: string): void {
    this.stmt.delete!.run(id);
  }

  /** Images of a session (used to delete their files with the chat). */
  listBySession(sessionId: string): StoredImage[] {
    return (this.stmt.bySession!.all(sessionId) as unknown as ImageRow[]).map(toImage);
  }
}
