import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { defaultsFromConfig } from '../src/settings/settingsSchema.js';
import { SettingsService, SettingsValidationError } from '../src/settings/settingsService.js';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { ChatService } from '../src/chat/chatService.js';
import { FakeLlm, makeCharacter, makeStore } from './helpers.js';

const defaults = defaultsFromConfig(parseConfig({ USER_NAME: 'Etienne', REPLY_LANGUAGE: 'French' }));
const make = (db = openDatabase(':memory:')) => ({ db, settings: new SettingsService(db, defaults, 1024) });

describe('SettingsService', () => {
  it('starts from the .env defaults', () => {
    const { settings } = make();
    expect(settings.get()).toMatchObject({ userName: 'Etienne', replyLanguage: 'French', temperature: 0.7 });
    expect(settings.overriddenKeys()).toEqual([]);
  });

  it('validates, persists and reloads overrides', () => {
    const { db, settings } = make();
    settings.update({ temperature: 0.85, sttLanguage: 'fr', replyLanguage: '' });
    expect(settings.overriddenKeys().sort()).toEqual(['replyLanguage', 'sttLanguage', 'temperature']);
    const reloaded = new SettingsService(db, defaults, 4096);
    expect(reloaded.get()).toMatchObject({ temperature: 0.85, sttLanguage: 'fr', replyLanguage: '' });
  });

  it('rejects unknown keys, bad values and too-long replies, leaving settings untouched', () => {
    const { settings } = make();
    expect(() => settings.update({ temprature: 1 })).toThrow(SettingsValidationError);
    expect(() => settings.update({ temperature: 5 })).toThrow(/temperature/);
    expect(() => settings.update({ llmModel: 'x; rm -rf /' })).toThrow(/llmModel/);
    expect(() => settings.update({ sttLanguage: 'french' })).toThrow(/sttLanguage/);
    // Removed in step 7 (Piper voices): no longer a setting.
    expect(() => settings.update({ ttsVoice: 'fr-tom' })).toThrow(SettingsValidationError);
    expect(() => settings.update({ maxReplyTokens: 2000 })).toThrow(/less than 1024/);
    expect(settings.get().temperature).toBe(0.7);
  });

  it('does not store values equal to the default, and resets', () => {
    const { db, settings } = make();
    settings.update({ temperature: 0.9 });
    settings.update({ temperature: 0.7 }); // back to default -> no override stored
    expect((db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n).toBe(0);
    settings.update({ topP: 0.8, minP: 0.1 });
    settings.reset(['topP']);
    expect(settings.overriddenKeys()).toEqual(['minP']);
    settings.reset();
    expect(settings.overriddenKeys()).toEqual([]);
  });

  it('notifies listeners with the previous values', () => {
    const { settings } = make();
    const seen: string[] = [];
    settings.onChange((cur, prev) => seen.push(`${prev.llmModel} -> ${cur.llmModel}`));
    settings.update({ llmModel: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS' });
    expect(seen).toEqual([`${defaults.llmModel} -> hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS`]);
  });

  it('ignores corrupted or obsolete stored values', () => {
    const { db } = make();
    db.prepare(
      "INSERT INTO settings VALUES ('temperature', '\"hot\"', 'x'), ('removedKey', '1', 'x'), ('topP', '{bad', 'x')",
    ).run();
    expect(new SettingsService(db, defaults, 4096).get()).toMatchObject({ temperature: 0.7, topP: 0.95 });
  });
});

describe('live settings reach the services', () => {
  it('ChatService uses the values current at each message', async () => {
    const { settings } = make();
    const { store } = makeStore();
    const llm = new FakeLlm(['ok']);
    const chat = new ChatService(CharacterRepository.fromCharacters([makeCharacter()]), store, llm, () => ({
      userName: settings.get().userName,
      budget: { contextTokens: 8192, maxReplyTokens: settings.get().maxReplyTokens },
      temperature: settings.get().temperature,
      topP: settings.get().topP,
    }));
    const { session } = chat.createSession('aria');
    await chat.sendMessage(session.id, 'one', () => {});
    expect(llm.lastOptions).toMatchObject({ temperature: 0.7, maxTokens: 400 });

    settings.update({ temperature: 0.9, maxReplyTokens: 200, userName: 'Tim' });
    await chat.sendMessage(session.id, 'two', () => {});
    expect(llm.lastOptions).toMatchObject({
      temperature: 0.9,
      maxTokens: 200,
      stop: expect.arrayContaining(['\nTim:']),
    });
  });
});
