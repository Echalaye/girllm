/**
 * Live settings: `.env` defaults + overrides saved from the app.
 *
 * Services never copy settings at startup; they call `get()` when they need
 * a value, so a change applies to the next message without a restart.
 * Listeners are notified after each change (e.g. to unload the old model).
 */
import type { StatementSync } from 'node:sqlite';
import { transaction, type Db } from '../db/database.js';
import { SETTING_KEYS, SettingsPatchSchema, SettingsSchema, type SettingKey, type Settings } from './settingsSchema.js';

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export type SettingsListener = (current: Settings, previous: Settings) => void;

export class SettingsService {
  private readonly stmt: Record<string, StatementSync>;
  private current: Settings;
  private readonly listeners: SettingsListener[] = [];

  /**
   * @param maxReplyLimit replies must stay below half the context window
   *        (CONTEXT_TOKENS lives in .env and can't change at runtime).
   */
  constructor(
    private readonly db: Db,
    private readonly defaults: Settings,
    private readonly maxReplyLimit: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stmt = {
      all: db.prepare('SELECT key, value FROM settings'),
      upsert: db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ),
      delete: db.prepare('DELETE FROM settings WHERE key = ?'),
    };
    this.current = this.load();
  }

  /** Effective settings (defaults + overrides). Cheap: cached in memory. */
  get(): Settings {
    return this.current;
  }

  getDefaults(): Settings {
    return this.defaults;
  }

  /** Keys currently overridden from the app. */
  overriddenKeys(): SettingKey[] {
    return SETTING_KEYS.filter((k) => this.current[k] !== this.defaults[k]);
  }

  /**
   * Validate and save a partial update.
   * @throws SettingsValidationError with a readable message.
   */
  update(patch: unknown): Settings {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new SettingsValidationError(formatIssues(parsed.error.issues));
    const next = { ...this.current, ...parsed.data };
    this.check(next);

    const ts = this.now().toISOString();
    transaction(this.db, () => {
      for (const key of Object.keys(parsed.data) as SettingKey[]) {
        // A value equal to the default isn't an override: forget it, so a
        // later .env change still applies.
        if (next[key] === this.defaults[key]) this.stmt.delete!.run(key);
        else this.stmt.upsert!.run(key, JSON.stringify(next[key]), ts);
      }
    });
    return this.apply(next);
  }

  /** Forget overrides (all of them, or the given keys). */
  reset(keys: readonly SettingKey[] = SETTING_KEYS): Settings {
    const next = { ...this.current };
    transaction(this.db, () => {
      for (const key of keys) {
        if (!SETTING_KEYS.includes(key)) continue;
        this.stmt.delete!.run(key);
        (next as Record<string, unknown>)[key] = this.defaults[key];
      }
    });
    return this.apply(next);
  }

  onChange(listener: SettingsListener): void {
    this.listeners.push(listener);
  }

  private apply(next: Settings): Settings {
    const previous = this.current;
    this.current = Object.freeze(next);
    for (const listener of this.listeners) listener(this.current, previous);
    return this.current;
  }

  private check(s: Settings): void {
    const full = SettingsSchema.safeParse(s);
    if (!full.success) throw new SettingsValidationError(formatIssues(full.error.issues));
    if (s.maxReplyTokens >= this.maxReplyLimit) {
      throw new SettingsValidationError(
        `maxReplyTokens must be less than ${this.maxReplyLimit} (half of CONTEXT_TOKENS)`,
      );
    }
  }

  /** Defaults + stored overrides; invalid stored values are ignored (and logged by the caller if needed). */
  private load(): Settings {
    const merged: Record<string, unknown> = { ...this.defaults };
    for (const row of this.stmt.all!.all() as Array<{ key: string; value: string }>) {
      if (!(SETTING_KEYS as string[]).includes(row.key)) continue; // removed in a newer version
      try {
        const candidate = { ...merged, [row.key]: JSON.parse(row.value) as unknown };
        if (SettingsSchema.safeParse(candidate).success) Object.assign(merged, candidate);
      } catch {
        /* corrupted value: keep the default */
      }
    }
    return Object.freeze(merged as Settings);
  }
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join('.') || 'settings'}: ${i.message}`).join('; ');
}
