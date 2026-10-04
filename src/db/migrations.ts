/**
 * Schema migrations, applied in order. NEVER edit a migration that has been
 * released: add a new one instead (databases in the wild already ran it).
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — conversations + long-term memory
  `
  CREATE TABLE sessions (
    id                    TEXT PRIMARY KEY,
    character_id          TEXT NOT NULL,
    title                 TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    -- Running summary of the messages with seq <= summarized_until.
    summary               TEXT NOT NULL DEFAULT '',
    summarized_until      INTEGER NOT NULL DEFAULT 0,
    -- Messages with seq <= facts_extracted_until were already mined for facts.
    facts_extracted_until INTEGER NOT NULL DEFAULT 0,
    mood                  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_sessions_character ON sessions (character_id, updated_at DESC);

  CREATE TABLE messages (
    -- Monotonic sequence: gives a total order and cheap "everything after X" pointers.
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_session ON messages (session_id, seq);

  -- Long-term memories are per CHARACTER, shared by all of its chats.
  CREATE TABLE memories (
    id                TEXT PRIMARY KEY,
    character_id      TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN ('user', 'character', 'relationship', 'event')),
    content           TEXT NOT NULL,
    -- L2-normalised float32 vector (little-endian). NULL if embedding failed.
    embedding         BLOB,
    embedding_model   TEXT,
    source_session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX idx_memories_character ON memories (character_id, updated_at DESC);
  `,

  // v2 — generated images ("photos" the character sends)
  `
  CREATE TABLE images (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- File name inside DATA_DIR/images (never a user-supplied path).
    file_name  TEXT NOT NULL,
    -- What the photo shows (fed back to the LLM so she knows what she sent).
    scene      TEXT NOT NULL,
    -- Full positive prompt + seed: enough to reproduce the image.
    prompt     TEXT NOT NULL,
    seed       INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_images_session ON images (session_id);

  ALTER TABLE messages ADD COLUMN image_id TEXT REFERENCES images (id) ON DELETE SET NULL;
  `,

  // v3 — settings changed from the app (override .env defaults)
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL, -- JSON
    updated_at TEXT NOT NULL
  );
  `,

  // v4 — messages she wrote on her own ("she writes first")
  `
  -- NULL = a normal reply; 'opening' = first message she generated for a chat
  -- without a fixed greeting; 'nudge' = she wrote after a silence.
  ALTER TABLE messages ADD COLUMN kind TEXT CHECK (kind IN ('opening', 'nudge'));
  `,
];
