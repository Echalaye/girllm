# Architecture

## Overview

```
Browser (public/)          Node server (src/)                                  LLM backend
──────────────────         ──────────────────────────────────────────────      ─────────────
index.html / app.js  ──►   http/app.ts      routes, validation, security       Ollama
fetch + SSE reader   ◄──   http/sse.ts                                         llama.cpp
                                │                                              KoboldCpp
                                ▼                                                  ▲
                           chat/chatService.ts ──────────► memory/memoryService.ts │
                            │        │       │               │      │       │      │
                            ▼        ▼       ▼               ▼      ▼       ▼      │
              characters/  prompt/   chat/sqliteSessionStore  summarizer  factExtractor
              (cards)      builder         │                  memoryStore embeddings ─┘
                                           ▼                      │
                                     db/database.ts (node:sqlite) ◄┘   data/girllm.db

Photos (step 4):
public/app.js (📷) ──► /api/sessions/:id/photo ──► chat.sendPhoto ──► images/imageService.ts
   safety.ts ─ photoPrompt.ts (LLM) ─ util/gpuGate.ts [unload LLM ─ images/comfyClient.ts ─ /free] ─► ComfyUI :8188
   PNG ─► data/images/<uuid>.png   metadata ─► images table   served by /api/images/:id

Voice: speech-to-text on the CPU (step 3), her voice on the GPU (step 7):
public/voice.js (mic) ──► /api/stt ──► voice/sherpaVoice.ts  Whisper (sherpa-onnx-node, models/)
public/voice.js (🔊, playback queue) ──► /api/tts ──► voice/speechService.ts ─ cache data/speech-cache
   voiceStore.ts (data/voices: her clip) ─ util/gpuGate.ts [unload LLM ─ comfyClient.ts ─ /free] ─► ComfyUI
   (Qwen3-TTS nodes: voice clone; voice design for the editor)
```

## Modules

| Path                                                  | Responsibility                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`                                       | Load `.env` and validate it (zod). Fails fast                                                                                               |
| `src/db/database.ts`                                  | Open SQLite (WAL, foreign keys), run migrations, transaction helper                                                                         |
| `src/db/migrations.ts`                                | Ordered schema migrations, versioned with `PRAGMA user_version`                                                                             |
| `src/llm/types.ts`                                    | `LlmProvider` interface and message types                                                                                                   |
| `src/llm/sse.ts`                                      | Parses the SSE stream coming **from** the backend                                                                                           |
| `src/llm/ollamaProvider.ts`                           | Native Ollama client (`/api/chat`, `/api/tags`, unload). Sends `num_ctx`, `min_p`, `repeat_penalty`, `keep_alive`                           |
| `src/llm/ndjson.ts`                                   | Parses Ollama's newline-delimited JSON stream                                                                                               |
| `src/llm/openaiCompatProvider.ts`                     | Streaming client for `/v1/chat/completions` (llama.cpp, KoboldCpp, LM Studio)                                                               |
| `src/llm/createProvider.ts`                           | Picks the LLM and embedding providers from `LLM_PROVIDER`                                                                                   |
| `src/llm/complete.ts`                                 | Non-streaming helper (used by the background memory tasks)                                                                                  |
| `src/characters/*`                                    | Character Card V1/V2/V3 schemas, `.json`/`.png` loader, in-memory registry                                                                  |
| `src/characters/characterRepository.ts`               | Registry + writes: create/update (atomic V2 JSON, round-trip validated, stable id), import, export, remove; refuses minors                  |
| `src/characters/characterService.ts`                  | Deleting a character cascades to her chats, photos, memories and face (refused while a chat is generating)                                  |
| `src/characters/faceStore.ts`                         | Reference faces (`data/faces/<id>.png\|jpg`) and temporary portrait candidates; paths built from validated ids only                         |
| `src/images/imageSanitizer.ts`                        | Uploaded faces: PNG/JPEG detection from the bytes, size limits, metadata stripped (EXIF, text, comments)                                    |
| `src/settings/settingsSchema.ts`                      | Settings changeable from the app (zod), `.env` defaults                                                                                     |
| `src/settings/settingsService.ts`                     | DB-backed overrides of the `.env` defaults, change listeners; services read them through getters (`Live<T>`)                                |
| `src/util/resolve.ts`                                 | `Live<T>` = a value or a function returning the current one (live settings without restarts)                                                |
| `src/util/atomicWrite.ts`                             | Write to a temporary file, then rename: never a half-written card or face                                                                   |
| `src/prompt/tokenEstimator.ts`                        | Cheap, conservative token estimate (~3.5 chars/token)                                                                                       |
| `src/prompt/promptBuilder.ts`                         | Card + memory + history → messages, within the token budget                                                                                 |
| `src/chat/sessionStore.ts`                            | `SessionStore` interface and session/message types                                                                                          |
| `src/chat/sqliteSessionStore.ts`                      | SQLite implementation (prepared statements)                                                                                                 |
| `src/chat/chatService.ts`                             | Send, regenerate, abort, list and delete chats. One generation per chat at a time                                                           |
| `src/memory/embeddings.ts`                            | `EmbeddingProvider`, `/v1/embeddings` client, vector maths and BLOB encoding                                                                |
| `src/memory/memoryStore.ts`                           | Long-term memories per character, brute-force cosine search                                                                                 |
| `src/memory/summarizer.ts`                            | Which messages to summarize (pure function) and the summary prompt                                                                          |
| `src/memory/factExtractor.ts`                         | Fact + mood extraction prompt and tolerant JSON parsing                                                                                     |
| `src/memory/memoryService.ts`                         | Orchestration: build the memory context, schedule background tasks, de-duplication                                                          |
| `src/util/serialQueue.ts`                             | Runs async tasks one at a time per key (per character)                                                                                      |
| `src/util/gpuGate.ts`                                 | Shared/exclusive GPU access: LLM calls are shared, image generation is exclusive and waits for running calls                                |
| `src/llm/gated.ts`                                    | `GatedLlmProvider` / `GatedEmbeddingProvider`: route every LLM and embedding call through the gate                                          |
| `src/images/safety.ts`                                | Code-enforced "no minors" rule: term and age detection (EN/FR, Unicode-aware), forced `adult` tags and negatives                            |
| `src/images/photoPrompt.ts`                           | Asks the LLM for `{caption, scene}`, with tolerant JSON parsing and a fallback                                                              |
| `src/images/workflow.ts`                              | Standard SDXL txt2img graph in ComfyUI API format                                                                                           |
| `src/images/comfyClient.ts`                           | `/prompt`, `/history` polling, `/view` (PNG check), `/free`, cancel on abort, `/object_info` status                                         |
| `src/images/imageStore.ts`                            | Image metadata (file, scene, prompt, seed)                                                                                                  |
| `src/images/imageService.ts`                          | Orchestration: safety → photo idea → exclusive GPU phase → store file and messages                                                          |
| `src/images/renderPipeline.ts`                        | One picture end to end: generate, then the face detail pass (SDXL or FLUX.2) when the face is small (shared with the test bench)            |
| `src/images/faceDetector.ts`                          | UltraFace RFB-640 (ONNX, onnxruntime-web/WASM, CPU): letterbox → most confident face box; lazy-loaded                                       |
| `src/images/detailWorkflow.ts`                        | Face crop planning (square, context ×2.2, skip close-ups) and the core-node redraw-and-blend ComfyUI graph                                  |
| `src/images/presets.ts`                               | Recommended sampler/scheduler/steps/CFG per known checkpoint; optional downloads (Juggernaut XI)                                            |
| `src/images/flux2Workflow.ts`                         | FLUX.2 [klein] 4B (bench only): pinned files (model fp8, Qwen3 4B encoder, VAE) and the core-node graph, reference face via ReferenceLatent |
| `scripts/compareImages.ts`, `imageBenchLib.ts`        | `npm run compare:images`: same shots and seeds through several models → HTML contact sheet                                                  |
| `src/util/mutex.ts`                                   | One-at-a-time execution that returns each task's result or error to its own caller (voice engines)                                          |
| `src/voice/catalog.ts`                                | Downloadable Whisper models: URL, pinned SHA-256, file layout                                                                               |
| `src/voice/sherpaVoice.ts`                            | Whisper engine, loaded lazily on first use, one request at a time                                                                           |
| `src/voice/speechText.ts`                             | Strips `*actions*`, emojis, markdown and URLs before synthesis; drops Whisper hallucinations                                                |
| `src/voice/wav.ts`                                    | float32 PCM decoding of speech-to-text uploads                                                                                              |
| `src/voice/qwenTts.ts`                                | Qwen3-TTS (step 7): pinned node pack, model files and Python packages; language mapping; voice design and clone graphs                      |
| `src/voice/speechService.ts`                          | Her voice: text cleanup, cache, automatic voice, exclusive GPU phase, voice candidates for the editor                                       |
| `src/voice/voiceStore.ts`                             | Each character's reference clip + transcript (`data/voices`), editor candidates (1 h), atomic writes, validated ids                         |
| `src/voice/voiceSafety.ts`                            | Adult voices only: minor / young-look / child-voice words, card age check, "adult" prefix                                                   |
| `src/http/clientAbort.ts`                             | Cancels a long GPU request (photo, voice) when the browser disconnects                                                                      |
| `scripts/setupVoice.ts`                               | `npm run setup:voice`: Whisper (download, checksum, atomic extract) and Qwen3-TTS into ComfyUI                                              |
| `scripts/comfySetupLib.ts`                            | Shared by the setups: node pack at a pinned commit, verified model files, missing Python packages at exact versions                         |
| `public/voice.js`                                     | `Recorder` (mic → 16 kHz mono float32) and `Speaker` (ordered playback, per-message progress, preparing/playing state, `whenIdle()`)        |
| `public/vad.js`                                       | `Downsampler` (→ 16 kHz) and `VoiceActivityDetector` (adaptive noise floor, hysteresis, pre-roll); pure, unit-tested                        |
| `public/pcm-capture.worklet.js`                       | AudioWorklet forwarding raw microphone samples in batches                                                                                   |
| `public/call.js`                                      | `CallSession`: mic → worklet → VAD → utterances; paused while she thinks and speaks                                                         |
| `public/app.js`, `api.js`, `settings.js`, `editor.js` | UI: chat and sidebar, fetch/SSE helpers, settings drawer, character editor                                                                  |
| `src/http/*`                                          | Routes, error mapping, security hooks, SSE to the browser                                                                                   |
| `src/index.ts`                                        | Composition root: wires everything, graceful shutdown                                                                                       |

Dependencies only point "inwards": `http` → `chat` → `memory` / `prompt` / `characters` / `llm` → `db`.
Nothing below `http` knows about HTTP, so a voice or CLI front-end can reuse it as is.

## Request flow: sending a message

1. `POST /api/sessions/:id/messages {text}` goes through the Host and Origin hooks, zod validation and a session
   existence check. Errors at this stage are normal JSON responses (`400`, `404`…).
2. `streamSse` takes over the raw response and creates an `AbortController` that fires if the browser disconnects.
3. `ChatService.sendMessage`:
   1. takes the per-chat lock (`409` if a reply is already being generated),
   2. stores the user message in SQLite,
   3. `MemoryService.buildContext` collects the running summary, the mood, and the top-k memories by cosine
      similarity to the last user message plus the reply before it. It falls back to the most recent memories,
      then trims to the memory token budget,
   4. `buildPrompt` assembles `[system: instructions + card + examples + memories + story so far + mood]`, then
      only the messages after `summarizedUntil`, then `[system: post-history instructions / language reminder]`,
   5. streams the deltas from the provider as `event: token`,
   6. stores the reply (a partial reply is kept if the user pressed Stop), then
   7. `MemoryService.schedule(sessionId)` queues the background tasks.
4. `event: done` carries the message id and prompt stats. Errors become `event: error` with a safe message.

## Background memory tasks

Queued per character with `SerialQueue`, so they never run concurrently on the same data. Their failures are
logged, never shown to the user.

1. **Summary.** `selectMessagesToSummarize` looks at the messages after `summarizedUntil`. Once they exceed
   `triggerTokens` (~50% of the available context), it picks the oldest ones and keeps at least `keepRecentTokens`
   and 2 messages verbatim. The LLM merges them into the previous summary (temperature 0.3), then `summarizedUntil`
   moves forward. This runs at most 5 rounds per task.
2. **Facts and mood.** Candidates are the messages after `factsExtractedUntil`, minus the last reply, which can
   still be regenerated. Once `extractEvery` of them are pending, the LLM returns
   `{"facts":[{category, content}], "mood"}`, processed in batches of 12. Each fact is skipped if it duplicates an
   existing one, either by exact text (case-insensitive) or by cosine ≥ 0.9; a duplicate just refreshes the
   existing memory's date.

If the embedding backend is down, memories are stored without a vector and retrieval falls back to recency. The
chat keeps working, with a warning logged at most once a minute.

## Database schema (v4)

| Table                    | Key columns                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`               | `id`, `character_id`, `title`, `summary`, `summarized_until`, `facts_extracted_until`, `mood`                                                                                                   |
| `messages`               | `seq` (autoincrement, used as a cursor), `id` (UUID, public), `session_id` → cascade delete, `role`, `content`                                                                                  |
| `images` (v2)            | `id`, `session_id` → cascade delete, `file_name`, `scene` (fed back to the LLM), `prompt`, `seed`                                                                                               |
| `messages.image_id` (v2) | Links a photo message to its image (set NULL if the image row is gone)                                                                                                                          |
| `messages.kind` (v4)     | `NULL` = a reply; `opening` / `nudge` = a message she wrote first (prevents two nudges in a row; "rewrite" keeps the kind)                                                                      |
| `settings` (v3)          | `key`, `value` (JSON), `updated_at`: only the values changed from the app; absent = `.env` default                                                                                              |
| `memories`               | `id`, `character_id`, `category` (`user`/`character`/`relationship`/`event`), `content`, `embedding` (float32 BLOB, L2-normalised), `embedding_model`, `source_session_id` → set NULL on delete |

Vectors are only compared with vectors from the same `embedding_model`, so changing the model never mixes
incompatible spaces. Old memories then rank by recency until they are re-learned.

## SSE protocol (server → browser)

| Event         | Data                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `token`       | `{ "text": string }`                                                                                              |
| `done`        | `{ "messageId": string \| null, "aborted": boolean, "estimatedPromptTokens": number, "droppedMessages": number }` |
| `error`       | `{ "message": string }`                                                                                           |
| `photo_start` | `{}` — she is sending a photo with the message just completed (after `done`)                                      |
| `photo`       | `{ "messageId": string, "imageId": string }` — the photo is attached to that message                              |
| `photo_error` | `{ "message": string }` — the text stays, only the photo failed or was refused                                    |

## HTTP API

| Method | Path                                        | Body                                                                            | Response                                                                      |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/health`                               | —                                                                               | `{ status, llm: { ok, models?, error? } }`                                    |
| GET    | `/api/config`                               | —                                                                               | `{ userName, memoryEnabled }`                                                 |
| GET    | `/api/characters`                           | —                                                                               | `[{ id, name, creatorNotes, tags, style, hasFace }]`                          |
| GET    | `/api/characters/:id/sessions`              | —                                                                               | `[{ id, title, createdAt, updatedAt, messageCount }]` (newest first)          |
| POST   | `/api/sessions`                             | `{ characterId }`                                                               | `201 { session, character }`                                                  |
| GET    | `/api/sessions/:id`                         | —                                                                               | `{ session (with summary, mood), character }`                                 |
| DELETE | `/api/sessions/:id`                         | —                                                                               | `204` (memories are kept)                                                     |
| POST   | `/api/sessions/:id/messages`                | `{ text }` (1–8000 chars)                                                       | SSE stream                                                                    |
| POST   | `/api/sessions/:id/regenerate`              | —                                                                               | SSE stream                                                                    |
| GET    | `/api/characters/:id/memories`              | —                                                                               | `[{ id, category, content, createdAt, updatedAt }]`                           |
| POST   | `/api/characters/:id/memories`              | `{ category, content }` (3–300 chars)                                           | `201`, or `409` if it duplicates an existing memory                           |
| DELETE | `/api/memories/:id`                         | —                                                                               | `204`                                                                         |
| GET    | `/api/images/status`                        | —                                                                               | `{ available, checkpoint?, reason? }`                                         |
| POST   | `/api/sessions/:id/photo`                   | `{ request? }` (≤ 300 chars)                                                    | `{ message }` with `imageId` (20–60 s; cancelled if the client disconnects)   |
| POST   | `/api/sessions/:id/images/:imageId/retake`  | —                                                                               | `{ message }` with its new `imageId` (same scene, new seed; old one deleted)  |
| GET    | `/api/images/:id`                           | —                                                                               | `image/png`                                                                   |
| GET    | `/api/voice`                                | —                                                                               | `{ stt: { available, model, reason? }, tts: {…} }` (tts checks ComfyUI)       |
| POST   | `/api/stt`                                  | `application/octet-stream`: float32 LE mono 16 kHz, ≤ 4 MB (~60 s)              | `{ text }` (empty if under 0.3 s)                                             |
| POST   | `/api/tts`                                  | `{ text, characterId }` (text 1–6000 chars, spoken up to 1500)                  | `audio/flac` in her voice, or `204` if nothing is speakable                   |
| GET    | `/api/settings`                             | —                                                                               | `{ values, defaults, overridden, options: { models, checkpoints, presets } }` |
| PUT    | `/api/settings`                             | partial settings (unknown keys refused)                                         | `{ values, defaults, overridden }`                                            |
| POST   | `/api/settings/reset`                       | `{ keys? }`                                                                     | same; back to `.env` (all, or the listed keys)                                |
| POST   | `/api/characters`                           | card fields (`name` required, `style`, `appearance`…)                           | `201` summary; `422` if she isn't an adult                                    |
| GET    | `/api/characters/:id`                       | —                                                                               | summary + `card` (editable fields) + `voice` (`{ description, createdAt }`)   |
| PUT    | `/api/characters/:id`                       | card fields                                                                     | summary (the id never changes)                                                |
| DELETE | `/api/characters/:id`                       | —                                                                               | `{ deleted, chats, memories }` (cascade); `409` while generating              |
| POST   | `/api/characters/import`                    | `application/octet-stream`: `.json` or `.png` card, ≤ 20 MB                     | `201` summary                                                                 |
| GET    | `/api/characters/:id/export`                | —                                                                               | Character Card V2 JSON (download)                                             |
| GET    | `/api/characters/:id/face`                  | —                                                                               | `image/png` or `image/jpeg`                                                   |
| PUT    | `/api/characters/:id/face`                  | octet-stream PNG/JPEG ≤ 10 MB + header `x-girllm-consent: adult-and-consenting` | `204`; `428` without the consent header                                       |
| DELETE | `/api/characters/:id/face`                  | —                                                                               | `204`                                                                         |
| POST   | `/api/characters/:id/face/candidates`       | — (uses the saved appearance)                                                   | `{ candidates: [uuid ×4] }` (cancelled if the client disconnects)             |
| GET    | `/api/characters/:id/face/candidates/:cid`  | —                                                                               | `image/png` (kept 1 h)                                                        |
| POST   | `/api/characters/:id/face/candidates/:cid`  | —                                                                               | `204`: the candidate becomes her face                                         |
| GET    | `/api/characters/:id/voice`                 | —                                                                               | `audio/flac`: her reference clip; `404` before she has one                    |
| DELETE | `/api/characters/:id/voice`                 | —                                                                               | `204` (a new voice is made the next time she speaks)                          |
| POST   | `/api/characters/:id/voice/candidates`      | `{ description }` (1–500 chars)                                                 | `{ candidate: uuid }` (GPU; cancelled if the client disconnects)              |
| GET    | `/api/characters/:id/voice/candidates/:cid` | —                                                                               | `audio/flac` (kept 1 h)                                                       |
| POST   | `/api/characters/:id/voice/candidates/:cid` | —                                                                               | `204`: the candidate becomes her voice                                        |

Error statuses: `400` invalid input · `403` cross-origin · `404` not found · `409` already generating or duplicate ·
`413` prompt or upload too large · `415` wrong content type · `421` wrong Host · `422` photo, voice or character
refused (safety) · `428` face upload without consent ·
`502` LLM backend or ComfyUI error · `503` voice/photos not installed or disabled.

## Tooling

| Path                                                  | Role                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `eslint.config.js`                                    | Flat config: `typescript-eslint` strict type-checked rules, browser globals for `public/`, Prettier compatibility              |
| `.prettierrc.json`, `.editorconfig`, `.gitattributes` | One formatting style, LF line endings (CRLF for `.bat`)                                                                        |
| `.github/workflows/ci.yml`                            | Format, lint, type check, tests and build on Node 22 and 24 (read-only permissions, cancels outdated runs)                     |
| `scripts/launch.ts` + `start.bat`                     | Launcher: start Ollama and ComfyUI if needed, rebuild if stale, start girllm, open the browser, stop on Ctrl+C what it started |
| `scripts/launcherLib.ts`                              | Testable launcher helpers (ComfyUI layout detection, staleness, readiness polling)                                             |

## Prompt layout (4b)

```
[system]   style instructions (texting | roleplay)  ·  [Character]  ·  [Example dialogue]
           [Story so far]  ·  [What she remembers]  ·  [Right now: date/time, pause, mood]
           [Reminders: recent openings, overused phrases, language, card's post-history notes]
[assistant/user …]  recent history
[user]     the new message   ← ALWAYS last
```

Exactly one system message, and the conversation always ends with the user. Templates differ: Ollama's Mistral
template inserts `$.System` only when the last message is the user's. Before 4b, the `(Reply in French.)`
reminder was sent as a trailing system message, so Mistral Nemo **silently lost the whole system prompt** (card,
memories, summary) whenever `REPLY_LANGUAGE` was set. A regression test (`prompt layout invariants`) now checks
this rule in every configuration.

| Module                                       | Role                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/prompt/styleGuard.ts`                   | Openings of the last replies and phrases repeated across them (4-grams, ignoring stopwords, _actions_ and emojis) |
| `src/prompt/timeContext.ts`                  | Localised date/time, readable durations, thresholds for mentioning a pause                                        |
| `scripts/compareLib.ts` / `compareModels.ts` | `npm run compare`: fixed French scenarios through the real prompt builder, with timing and automatic checks       |

## Design decisions

- **Time and reminders in the system prompt, recomputed each turn**: they cost a few tokens but fix the two most
  "robotic" behaviours of small models (no sense of time, looping on the same openings).
- **Hires pass in pixel space** (Lanczos upscale, then a low-denoise resample) rather than latent upscaling: it keeps
  the composition at low denoise and adds the detail SDXL portraits lack at 1 megapixel.
- **Unloading the LLM for each photo** instead of running both at once: a 12B Q4 model plus SDXL needs more than
  8 GB. The `GpuGate` makes the handover safe, because no LLM call (chat, memory tasks, other chats) can sneak in
  and reload the model in the middle of an image.
- **Polling `/history` instead of ComfyUI's websocket**: no dependency, simpler error handling, negligible overhead.
- **The LLM writes the scene, the card fixes the face**: the scene changes with the conversation, while the identity
  tags never do, which keeps photos consistent without training a LoRA.
- **The photo request is saved only on success**: a refused or failed photo leaves nothing in the chat, the memory
  or the LLM context.
- **Strict, code-level minor protection**: not configurable, applied at every stage (request, LLM output, final
  prompt, card), and with generic refusal messages.

- **Native Ollama API by default**: the OpenAI-compatible endpoint can't set `num_ctx`, so Ollama would use its own
  default and silently drop the _start_ of the prompt (the character card). `num_ctx` is fixed per provider because
  Ollama reloads the model whenever it changes, and the background memory tasks share the same model.
- **sherpa-onnx for voice instead of kokoro-js or transformers.js**: kokoro-js only ships English voices, while
  sherpa-onnx offers Whisper plus several French Piper voices. It's native ONNX Runtime, prebuilt for Windows, with
  async calls that don't block the event loop and no Python.
- **Speech-to-text on the CPU**: a 12B model already fills 8 GB of VRAM, and Whisper base is fast enough on a
  6-core CPU.
- **Her voice on the GPU, through ComfyUI (step 7)**: Piper sounded robotic and had a handful of fixed voices.
  Qwen3-TTS 1.7B (Apache 2.0, French) designs a voice from words and clones it for every message, but needs the GPU:
  it takes the same exclusive phase as photos (LLM unloaded, ComfyUI freed after). Running it as a ComfyUI custom
  node reuses ComfyUI's Python/PyTorch, its job queue and our existing client, instead of a second Python service.
  The cost: whole messages instead of sentence-by-sentence streaming (one GPU swap per message), a cache so a replay
  is free, and an on-demand 🔊 so the GPU is only used when she is listened to.
- **Raw float32 PCM upload for speech-to-text**: the browser already decodes and resamples, so the server needs no
  ffmpeg or audio codec.

- **`node:sqlite`, not better-sqlite3**: no native addon, so `npm install` works on Windows without Visual Studio
  Build Tools. The synchronous API is a good fit for a single-user app.
- **Brute-force vector search, not sqlite-vec**: a few thousand 768-dimension vectors take well under a
  millisecond to scan, and there's no native extension to ship. Revisit at ~100k memories.
- **Memories per character, summary per chat**: what she knows about you persists across chats, while each chat
  keeps its own storyline.
- **The chat model does the summarizing and extraction**: no second LLM to fit in 8 GB of VRAM. These tasks run
  after the reply, so they never add latency to it.
- **A message cursor (`seq`) instead of flags on each message**: "what's new since X" is one indexed range query.
- **Fastify, no LLM SDK, estimated tokens, separate connect and generation timeouts**: unchanged from step 1.
  The OpenAI streaming protocol is around 60 lines with `fetch`, and token estimates are deliberately pessimistic.

## Step 7: her voice (Qwen3-TTS)

**Install.** `setup:voice` (scripts/setupVoice.ts + comfySetupLib.ts) clones flybirdxx/ComfyUI-Qwen-TTS at
`QWEN_TTS_NODES.commit`, downloads `QWEN_TTS_BASE_FILES` and `QWEN_TTS_DESIGN_FILES` into
`ComfyUI/models/qwen-tts/<repo name>/` (the nodes pick the folder whose name contains "1.7B" and the model type),
creates `qwen-tts/Qwen3-TTS-Tokenizer-12Hz` with a README (otherwise the nodes download it, unpinned, although
inference uses each model's `speech_tokenizer/`), and pip-installs into `python_embeded` only the
`QWEN_TTS_PYTHON_PACKAGES` whose module doesn't import, plus `transformers==4.57.3` when older than 4.57. Specs must
be exact (`name==x.y.z`), checked before pip runs. Small config files have `sha256: null`: their URL is pinned to a
Hugging Face commit, and `download()` refuses more than 10 MB without a hash.

**Graphs** (`qwenTts.ts`). Design: `FB_Qwen3TTSVoiceDesign(text = voiceSampleText(language), instruct =
adultVoicePrefix + description)` → `SaveAudio`. Clone: `LoadAudio(her clip)` → `FB_Qwen3TTSVoiceClone(target_text,
ref_audio, ref_text = the clip's words, x_vector_only false)` → `SaveAudio`. Both: 1.7B, bf16, `attention: sdpa` (not `auto`, which prefers a monkeypatched SageAttention),
`unload_model_after_generate: true` (the nodes cache models in a global that ComfyUI's `/free` doesn't clear), random
seed, `max_new_tokens` 2048 (~2.7 min). `ComfyClient.generateAudio` reads the `audio` output of `/history` and
checks the `fLaC` magic and ≤ 50 MB; `uploadFile` sends the clip through `/upload/image` (ComfyUI's own page does
the same for audio); `qwenTtsSupport` checks the two node classes, their expected inputs, `LoadAudio` and
`SaveAudio`.

**SpeechService.speak(characterId, text).** `prepareSpeech` (cleanForSpeech, cut at the last sentence end before
1500 chars) → '' = `204`. Card age check (`assertCardVoiceSafe`). Her clip from `VoiceStore`, or `autoVoice`: design
from `voiceDescription` or `DEFAULT_VOICE_DESCRIPTION[gender]`, saved directly (one at a time per character). Cache
key = sha256(clip hash, language, text) → `data/speech-cache/<key>.flac`; identical concurrent requests share one
job (`inFlight`). `onGpu`: status first (fails fast with `VoiceUnavailableError`, nothing unloaded), then
`gate.runExclusive`: `llm.unload()`, upload `girllm_voice_<id>_<hash16>.flac`, clone, `comfy.free()` in `finally`.
Cache pruned to the newest 300 clips. Status cached 60 s when ready, 5 s when not (ComfyUI often starts after
girllm). Language: `qwenLanguage(replyLanguage)` ("French", "français", "fr" → French; unknown → Auto).

**Editor.** `designCandidate` → `VoiceStore.addCandidate` (FLAC + JSON with the words, description, language);
the page keeps the last 3 to compare; `promote` copies one to `data/voices/<id>.flac/json`. Deleting a character
removes her voice (`CharacterService`). The card keeps only `extensions.girllm.voiceDescription`; the step 3
`voice` id is deleted on save.

**Page.** Every message of hers has a 🔊 (`.speak`, shown when `/api/voice` says tts is available; checked again
every 30 s otherwise). `speakMessage` stops what's playing and enqueues the message's raw text (`data-text`); the
button shows loading / playing; a second click stops. "Voice on", photos and calls call it once the reply is done.
`Speaker` aborts the pending `/api/tts` fetch on `stop()` (the server then cancels the ComfyUI job), reports
`preparing`/`playing` (presence "recording a voice message…", call screen "about to answer…" / "talking").

## Step 4d flows

**She writes first.** `POST /initiate` → `ChatService.canInitiate` (opening: empty chat; nudge: silence ≥
`proactiveAfterMinutes`, last message not already a nudge) → the prompt gets a _stage direction_ as the final user
turn ("Etienne hasn't written for 3 hours…"), which is never stored → her message is saved with `kind`. The page
asks on chat open and once a minute; the server is the only judge.

**Photos she sends.** When allowed (frequency cooldown, or the user's message asks for a photo), a reminder tells
the model it may end with `[photo: …]`. `PhotoTagFilter` hides the tag from the token stream (holding back only a
possible tag prefix) → the text is stored, `done` is sent → `ImageService.attachPhoto` (safety, idea, GPU phase) →
`setMessageImage` → `photo` event. A tag emitted when not allowed is hidden and ignored.

**Reference face.** `ImageService.faceReference`: weight > 0 + a face in `FaceStore` + `ComfyClient.faceSupport()`
(nodes present with the expected inputs, both model files listed; cached 1 min) → upload to ComfyUI's input folder
under a content-hash name (once per process) → workflow nodes 12–15 (`LoadImage`, `IPAdapterModelLoader`,
`CLIPVisionLoader`, `IPAdapterAdvanced`); both samplers use the patched model. Any failure → photo without the face,
logged.

**Lorebook.** `selectLore(character_book, recent messages, 15% of context)` → `[World info]` block placed right after
the character definition.

## Step 5: art styles and backgrounds

**Two image profiles.** `ImageServiceOptions.settings` (realistic) and `.anime`, each a full `ImageSettings`
(checkpoint, sampler, tags, face weight). `ImageService.profile(character.artStyle)` picks one, or throws an
`ImageUnavailableError` that says how to install the missing model. `artStyle.ts` builds the prompts:
realistic = subject, photo style, appearance, scene; anime = `1girl|1boy, solo, adult, mature female|male`,
appearance, scene, quality tags last (Animagine's documented order). The photo-idea prompt asks for Danbooru tags
for anime characters. Negatives always include the youth terms; anime adds a few more.

**Backgrounds.** A second `FaceStore` in `data/backgrounds`; the face and background routes are the same generic set
(`registerPicture`). `generateBackgrounds` asks the LLM for a "wide picture of me in my usual place" from the card,
then renders 1216×832 candidates with her reference face. The page picks the source (`latest` photo → scene → face)
and the look (`chatBackground` setting) in `updateBackground()`; the layer is decorative (`aria-hidden`), blurred
and veiled with the page colour so the text keeps its contrast in both themes.

## Step 6: face detail pass and image test bench

**Face detail pass** (`renderPipeline.ts`), inside the same exclusive GPU phase as the picture:

```
txt2img (ComfyUI) ─► PNG ─► FaceDetector.detect (CPU, ~0.1 s)
  ─► no face / face > 40 % of the height (close-up) ─► keep the picture
  ─► planFaceCrop: square around the face (×2.2 context, multiple of 8, kept inside the picture)
  ─► upload as girllm_detail_source.png ─► ComfyUI: LoadImage ─► ImageCrop ─► ImageScale 1024
       ─► VAEEncode ─► KSampler (denoise = detail strength, same seed/settings, + IP-Adapter face)
       ─► VAEDecode ─► ImageScale back ─► SolidMask + FeatherMask (12 %) ─► ImageCompositeMasked ─► SaveImage
```

- Core ComfyUI nodes only: no custom node pack (Impact Pack would pull ultralytics, SAM2 and pickled `.pt` models).
- The detector is a pinned (SHA-256) 1.6 MB MIT model in `MODELS_DIR/face-detector`, installed by
  `setup:images`. onnxruntime-web runs it in WebAssembly: no native binaries or CUDA downloads (onnxruntime-node
  is 300 MB and fetches CUDA packages at install). Loaded on first use, one thread.
- One fixed upload name: jobs are serialized by the GPU gate and LoadImage re-reads a changed file (hash), so the
  ComfyUI input folder doesn't grow.
- Any failure of the pass (detector, upload, ComfyUI) keeps the generated picture and logs a warning; a cancel
  (abort signal) still propagates. Reference portraits (close-ups by construction) skip the pass.

**Full-body framing.** `frameForScene` (artStyle.ts) switches a portrait-oriented size to 768×1344 when the scene
says "full body", "full-length" or "head to toe": same pixel count, room for natural proportions.

**Presets.** `MODEL_PRESETS` match checkpoint names (RealVis, Juggernaut, Animagine); `/api/settings` sends them
(regex as source string) and the settings panel fills the sampler fields when such a model is picked.

**Test bench.** `compareImages.ts` reads the live settings from the DB, unloads Ollama, renders every
(shot × seed × model) through `renderPicture` with the app's prompt builders and safety check, and rewrites the
contact sheet after each picture (usable if interrupted). The HTML is static and escapes every value.

**FLUX.2 [klein] 4B (6b, bench only).** A second graph family next to SDXL (`BenchModel.family`). The graph copies
ComfyUI's official "Flux.2 Klein 4B Distilled" templates (node and input names checked against the ComfyUI source):
`UNETLoader` + `CLIPLoader(type flux2)` + `VAELoader`, `CLIPTextEncode` → `ConditioningZeroOut` for the negative,
`CFGGuider(cfg 1)`, `Flux2Scheduler(4 steps)`, `KSamplerSelect(euler)`, `RandomNoise`, `SamplerCustomAdvanced`,
`EmptyFlux2LatentImage` (sizes rounded to 16). Her face: `LoadImage` → `ImageCrop` (face ×1.3, from the face
detector) → `ImageScaleToTotalPixels(1 MP)` → `VAEEncode` → `ReferenceLatent` on both conditionings. The prompt
(`buildFlux2Prompt`) is sentences, scene first, with its own photo style and a sentence asking for the face only.
First bench (2026-10-05) without these: the whole portrait as reference was copied (clothes, framing) and
"smartphone photo" put a phone in her hands in most pictures. `ComfyClient.flux2Support` checks the FLUX.2 nodes exist (recent ComfyUI)
and the three files are listed by their loaders. Bench variants (`FLUX2_VARIANTS`): distilled 4 and 8 steps, without
the face, and the undistilled base model (20 steps, CFG 5) whose node 5 is a real negative `CLIPTextEncode`
(`FLUX2_NEGATIVE` + the youth terms) instead of `ConditioningZeroOut`; defaults `FLUX2_DEFAULT_VARIANTS` (8 steps,
with and without a pose guide). Pose guide (nodes 50–54): `LoadImage(data/poses/<shot>.png)` →
`ImageScaleToTotalPixels(1 MP)` → `VAEEncode` → `ReferenceLatent` chained after the face references, so the prompt
can call them "image 1" (face) and "image 2" (pose, `FLUX2_POSE_HINT`); only used with a face reference. Tried and
removed on 2026-10-05: a "correct hands" sentence, an "edit the hands" pass (Klein's edit mode returned a copy:
mean pixel difference 3/255) and a 1.5× refine pass (same fingers, sharper). ComfyUI caches identical nodes, so
bench columns sharing a first pass don't recompute it. The bench uses fixed seeds (`BENCH_SEEDS`, `chooseSeeds`). Since 6b it is also the app's
realistic engine (below); the missing negative prompt is covered by `assertSafeStrict`.

**FLUX.2 [klein] in the app (6b).** `ImageSettings.engine` (`REALISTIC_ENGINE`, setting `realisticEngine`) chooses
the model of realistic characters. `ImageService.engineFor(style)` returns FLUX.2 when it is chosen and
`ComfyClient.flux2Support` says the nodes and files are there (cached a minute), else the SDXL profile (with a
note in `/api/images/status`), else an `ImageUnavailableError` saying what to install. `pictureJob(engine, …)`
builds one job for either engine: FLUX.2 gets `buildFlux2Prompt` (sentences) checked by `assertSafeStrict` (the
usual minor terms plus young-look words: it has no negative prompt to push them away), her face uploaded once
(content hash in the name) and cropped by the face detector (`fluxFaceReference`), and `FLUX2_APP_SETTINGS`
(8 steps, CFG 1, Euler), plus the FLUX.2 face pass below; SDXL keeps IP-Adapter, the hires pass and the SDXL
face detail pass. Chat photos, retakes,
reference portraits (no face reference) and backgrounds all go through it.

**FLUX.2 face pass (6c).** In wide and full-body shots her face is 100–200 px tall: the reference latent can't
carry her features at that size and Klein drew a look-alike. `pictureJob` adds `detail: {kind: 'flux2', …}` when
the job wants a face pass, her face is known and `detailStrength > 0`. `renderPicture` treats it like the SDXL pass
(same detector, same `planFaceCrop` square ×2.2 and close-up skip, same `girllm_detail_source.png` upload) but
builds `buildFlux2FaceDetailWorkflow`: `LoadImage` (30) → `ImageCrop` (31) → `ImageScale` 1024² (32) → `VAEEncode`
(33); `Flux2Scheduler(16 steps, 1024²)` (8) → `SplitSigmas(step 12)` (34), the low half sampled by
`SamplerCustomAdvanced` from the encoded crop (re-noised to sigma ≈ 0.754, 4 steps); prompt `buildFlux2FacePrompt`
(close-up of her face, keep head angle/expression/light/hair/background, her appearance, "image 1" hint, strict
safety check); her cropped profile picture as `ReferenceLatent` (20–25, shared helper `attachFaceReference`);
`VAEDecode` → back to the crop size (35) → `SolidMask` + `FeatherMask` 12 % (36/37) → `ImageCompositeMasked` (38).
Fixed strength `FLUX2_FACE_PASS`: the SDXL denoise scale does not map onto Flux sigmas. Same seed as the picture.
The bench applies it to Klein columns that have her face.

**Retake.** `ChatService.retakePhoto` (session lock, the image must be shown by a message of this chat) →
`ImageService.retakePhoto`: same stored scene, new seed, current engine, `drawAndStore` (file then row), then the
message points to the new image, and the old row and file are deleted. A failed retake changes nothing. In the
page, the ↻ button on each photo calls the route and swaps the picture in place; Stop cancels it.

**Scenes for FLUX.2.** `writePhotoIdea` receives the engine: for FLUX.2, `sceneInstructions('realistic', 'flux2-klein')`
(`FLUX_SCENE_INSTRUCTIONS`) asks for 4–6 sentences in a fixed order (shot and framing, action/pose/expression, outfit,
a specific place from her life with 3–4 objects and the floor, light), up to 1200 characters and 600 tokens; SDXL
keeps the tag list. `BACKGROUND_REQUEST` asks for a place of her everyday life from her card, not a generic landscape.

**Background scene in the user's words.** `extensions.girllm.backgroundScene` (≤ 1000 chars, editor field "Her scene,
in your words"): when set, `generateBackgrounds` skips the LLM and draws it as written
(`backgroundSceneFromUser` adds "Wide shot…" unless a framing is given), through the same safety checks.
