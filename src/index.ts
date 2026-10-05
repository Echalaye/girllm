/**
 * Entry point: load config, wire dependencies, start the HTTP server.
 */
import { CharacterRepository } from './characters/characterRepository.js';
import { CharacterService } from './characters/characterService.js';
import { FaceStore } from './characters/faceStore.js';
import { ChatService } from './chat/chatService.js';
import { SqliteSessionStore } from './chat/sqliteSessionStore.js';
import { isLoopbackHost, loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { buildApp } from './http/app.js';
import { createEmbeddingProvider, createLlmProvider } from './llm/createProvider.js';
import { MemoryService } from './memory/memoryService.js';
import { MemoryStore } from './memory/memoryStore.js';
import { defaultSummaryPolicy } from './memory/summarizer.js';
import { SherpaSpeechToText, SherpaTextToSpeech } from './voice/sherpaVoice.js';
import type { VoiceServices } from './voice/types.js';
import { ComfyClient } from './images/comfyClient.js';
import { ImageService } from './images/imageService.js';
import { ImageStore } from './images/imageStore.js';
import { GatedEmbeddingProvider, GatedLlmProvider } from './llm/gated.js';
import { GpuGate } from './util/gpuGate.js';
import { defaultsFromConfig } from './settings/settingsSchema.js';
import { SettingsService } from './settings/settingsService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { contextTokens, maxReplyTokens } = config.generation;

  const db = openDatabase(config.databasePath);
  const sessions = new SqliteSessionStore(db);

  // Live settings: .env gives the defaults, the settings panel overrides
  // them. Services call S() when they need a value, so changes apply to the
  // next message without a restart.
  const settings = new SettingsService(db, defaultsFromConfig(config), Math.floor(contextTokens / 2));
  const S = () => settings.get();
  const language = () => S().replyLanguage || undefined;

  // Every LLM/embedding call goes through the GPU gate, so they pause while
  // an image is generated (the LLM is unloaded during that time).
  const gpu = new GpuGate();
  const llm = new GatedLlmProvider(
    createLlmProvider(config, () => S().llmModel),
    gpu,
  );
  const rawEmbeddings = createEmbeddingProvider(config);
  const embeddings = rawEmbeddings ? new GatedEmbeddingProvider(rawEmbeddings, gpu) : undefined;

  // Temporary console logger until Fastify's (pino) logger exists.
  const bootLog = {
    info: (m: string) => {
      console.log(m);
    },
    warn: (m: string) => {
      console.warn(`WARN ${m}`);
    },
  };
  const characters = await CharacterRepository.loadFromDirectory(config.charactersDir, bootLog);

  // Host header allow-list (anti DNS-rebinding). Add the LAN host when
  // deliberately exposing the app (e.g. through Tailscale).
  const allowedHosts = isLoopbackHost(config.host)
    ? [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]
    : [`${config.host}:${config.port}`, `127.0.0.1:${config.port}`, `localhost:${config.port}`];

  // The memory service is created before Fastify (which owns the real
  // logger), so it gets a late-bound proxy that switches to app.log below.
  let log: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void } = {
    warn: (o, m) => {
      console.warn(m ?? '', o);
    },
    info: (o, m) => {
      console.log(m ?? '', o);
    },
  };
  const memoryLog = {
    warn: (o: unknown, m?: string) => {
      log.warn(o, m);
    },
    info: (o: unknown, m?: string) => {
      log.info(o, m);
    },
  };

  const memoryStore = new MemoryStore(db);
  const memory = config.memory.enabled
    ? new MemoryService(sessions, characters, memoryStore, llm, embeddings, memoryLog, () => ({
        userName: S().userName,
        replyLanguage: language(),
        summaryPolicy: defaultSummaryPolicy(contextTokens, maxReplyTokens),
        topK: config.memory.topK,
        memoryTokenBudget: Math.floor(contextTokens * 0.1),
        extractEvery: config.memory.extractEvery,
        duplicateThreshold: 0.9,
        minRelevance: 0.3,
      }))
    : undefined;

  // Reference faces: avatars in the app, and IP-Adapter input for photos.
  const faces = new FaceStore(config.facesDir);
  const backgrounds = new FaceStore(config.backgroundsDir);

  const { images: img } = config;
  const images = img.enabled
    ? new ImageService(
        sessions,
        characters,
        new ImageStore(db),
        llm,
        new ComfyClient({ baseUrl: img.comfyUrl }),
        gpu,
        memoryLog,
        () => {
          const s = S();
          return {
            userName: s.userName,
            replyLanguage: language(),
            imagesDir: img.dir,
            settings: {
              checkpoint: s.imageCheckpoint || undefined,
              width: img.width,
              height: img.height,
              steps: s.imageSteps,
              cfg: s.imageCfg,
              sampler: s.imageSampler,
              scheduler: s.imageScheduler,
              style: s.imageStyle,
              negative: s.imageNegative,
              hires: { scale: s.imageHiresScale, denoise: s.imageHiresDenoise, steps: s.imageHiresSteps },
              faceWeight: s.imageFaceWeight,
            },
            anime: {
              checkpoint: s.animeCheckpoint || undefined,
              width: img.width,
              height: img.height,
              steps: s.animeSteps,
              cfg: s.animeCfg,
              sampler: s.animeSampler,
              scheduler: s.animeScheduler,
              style: s.animeStyle,
              negative: s.animeNegative,
              // Same detail-pass strength/steps as realistic; only the scale differs.
              hires: { scale: s.animeHiresScale, denoise: s.imageHiresDenoise, steps: s.imageHiresSteps },
              faceWeight: s.animeFaceWeight,
            },
          };
        },
        faces,
      )
    : undefined;

  const chat = new ChatService(
    characters,
    sessions,
    llm,
    () => {
      const s = S();
      return {
        userName: s.userName,
        budget: { contextTokens, maxReplyTokens: s.maxReplyTokens },
        temperature: s.temperature,
        topP: s.topP,
        minP: s.minP,
        repeatPenalty: s.repeatPenalty,
        replyLanguage: language(),
        photoFrequency: s.photoFrequency,
        proactiveAfterMinutes: s.proactiveAfterMinutes,
      };
    },
    memory,
    images,
  );

  // Character editor: deleting a character cascades to its chats, photos,
  // memories and reference face.
  const characterService = new CharacterService(characters, chat, sessions, memoryStore, faces, backgrounds);

  const { voice: v } = config;
  const voice: VoiceServices | undefined = v.enabled
    ? {
        stt: new SherpaSpeechToText(() => ({
          modelsDir: v.modelsDir,
          model: v.sttModel,
          language: S().sttLanguage,
          numThreads: v.threads,
        })),
        tts: new SherpaTextToSpeech(() => ({
          modelsDir: v.modelsDir,
          voice: S().ttsVoice,
          speed: S().ttsSpeed,
          numThreads: v.threads,
        })),
      }
    : undefined;

  const app = await buildApp({
    chat,
    characters,
    llm,
    memory,
    memoryStore,
    voice,
    images,
    characterService,
    faces,
    backgrounds,
    settings,
    voiceModelsDir: v.modelsDir,
    allowedHosts,
    userName: () => S().userName,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });
  log = app.log;

  // Switching models from the settings: free the old one's VRAM right away.
  settings.onChange((current, previous) => {
    if (current.llmModel !== previous.llmModel) {
      app.log.info(`Model changed: ${previous.llmModel} → ${current.llmModel}`);
      llm.unload(previous.llmModel).catch((err: unknown) => {
        app.log.warn({ err }, 'could not unload the previous model');
      });
    }
  });
  if (settings.overriddenKeys().length) {
    app.log.info(`Settings changed from the app (override .env): ${settings.overriddenKeys().join(', ')}`);
  }

  if (!isLoopbackHost(config.host)) {
    app.log.warn(`Listening on ${config.host}: the API has NO authentication. Only do this on a trusted network.`);
  }
  app.log.info(
    `LLM: ${S().llmModel} via ${config.llm.provider} (${config.llm.baseUrl}), context ${contextTokens} tokens`,
  );
  app.log.info(`Database: ${config.databasePath}`);
  app.log.info(`Reply language: ${S().replyLanguage || 'not forced'}`);
  app.log.info(
    config.memory.enabled
      ? `Memory: on (embeddings: ${config.memory.embeddingModel ?? 'off, recency only'})`
      : 'Memory: off',
  );

  if (voice) {
    const describe = (s: { available: boolean; model: string; reason?: string }) =>
      s.available ? s.model : `${s.model} — ${s.reason}`;
    app.log.info(
      `Voice: speech-to-text ${describe(voice.stt.status())}, text-to-speech ${describe(voice.tts.status())}`,
    );
  } else {
    app.log.info('Voice: off');
  }

  if (images) {
    const st = await images.status();
    if (st.available) {
      app.log.info(`Photos: on (ComfyUI ${img.comfyUrl}, checkpoint ${st.checkpoint})`);
      app.log.info(st.face?.ready ? 'Reference faces: on (IP-Adapter)' : `Reference faces: off — ${st.face?.reason}`);
    } else app.log.warn(`Photos: unavailable for now — ${st.reason}`);
    app.log.info(
      st.anime.available
        ? `Anime photos: on (checkpoint ${st.anime.checkpoint})`
        : `Anime photos: off — ${st.anime.reason}`,
    );
    if (config.llm.provider !== 'ollama') {
      app.log.warn('Photos with LLM_PROVIDER=openai: the LLM cannot be unloaded automatically, VRAM may run out.');
    }
  } else {
    app.log.info('Photos: off');
  }

  const health = await llm.ping();
  if (!health.ok) {
    app.log.warn(
      `LLM backend not reachable at ${config.llm.baseUrl} (${health.error}). Start Ollama, the app will keep running.`,
    );
  } else if (health.models) {
    // Ollama lists models as "name:tag"; accept an implicit ":latest".
    const has = (name: string) => health.models!.some((m) => m === name || m === `${name}:latest`);
    if (!has(S().llmModel)) {
      app.log.warn(`Model "${S().llmModel}" not found on the backend. Run: ollama pull ${S().llmModel}`);
    }
    if (config.memory.enabled && config.memory.embeddingModel && !has(config.memory.embeddingModel)) {
      app.log.warn(
        `Embedding model "${config.memory.embeddingModel}" not found. Run: ollama pull ${config.memory.embeddingModel}`,
      );
    }
  }

  // Graceful shutdown (Ctrl+C): stop accepting requests, let background
  // memory jobs finish (bounded), then close the database.
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      app.log.info(`${signal} received, shutting down`);
      const timeout = new Promise((r) => setTimeout(r, 5000));
      app
        .close()
        .then(() => Promise.race([memory?.idle(), timeout]))
        .then(() => {
          db.close();
        })
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`girllm ready on http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
