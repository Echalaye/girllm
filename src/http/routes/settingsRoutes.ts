/**
 * /api/settings — read and change the live settings from the app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ImageService } from '../../images/imageService.js';
import type { LlmProvider } from '../../llm/types.js';
import { SETTING_KEYS, type SettingKey } from '../../settings/settingsSchema.js';
import type { SettingsService } from '../../settings/settingsService.js';
import { TTS_VOICES, type TtsVoiceId } from '../../voice/catalog.js';
import { MODEL_PRESETS } from '../../images/presets.js';
import { isTtsVoiceInstalled } from '../../voice/sherpaVoice.js';

export interface SettingsRoutesDeps {
  settings: SettingsService;
  llm: LlmProvider;
  images?: ImageService | undefined;
  /** MODELS_DIR, to tell which voices are downloaded. */
  voiceModelsDir: string;
}

const ResetBody = z.object({ keys: z.array(z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]])).optional() });

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  const view = () => ({
    values: deps.settings.get(),
    defaults: deps.settings.getDefaults(),
    overridden: deps.settings.overriddenKeys(),
  });

  /** Current values + what the UI can offer in its drop-downs. */
  app.get('/api/settings', async () => {
    const [llm, checkpoints] = await Promise.all([deps.llm.ping(), deps.images?.listCheckpoints()]);
    return {
      ...view(),
      options: {
        models: llm.models ?? [],
        checkpoints: checkpoints ?? [],
        // Recommended sampler settings of known image models (filled in when one is picked).
        presets: MODEL_PRESETS.map(({ match, ...rest }) => ({ ...rest, pattern: match.source })),
        voices: (Object.keys(TTS_VOICES) as TtsVoiceId[]).map((id) => ({
          id,
          description: TTS_VOICES[id].description,
          installed: isTtsVoiceInstalled(deps.voiceModelsDir, id),
        })),
      },
    };
  });

  /** Partial update; unknown keys and invalid values are rejected (400). */
  app.put('/api/settings', async (request) => {
    deps.settings.update(request.body);
    return view();
  });

  /** Back to the .env defaults (all settings, or the listed keys). */
  app.post('/api/settings/reset', async (request) => {
    const { keys } = ResetBody.parse(request.body ?? {});
    deps.settings.reset(keys);
    return view();
  });
}
