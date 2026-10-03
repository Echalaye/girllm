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

Voice (step 3), CPU only:
public/voice.js  (mic, playback queue) ──► /api/stt ──► voice/sherpaVoice.ts  Whisper ┐ sherpa-onnx-node
public/speech.js (sentence splitter)   ──► /api/tts ──► voice/sherpaVoice.ts  Piper   ┘ models/ (setup:voice)
```

## Modules

| Path                              | Responsibility                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`                   | Load `.env` and validate it (zod). Fails fast                                                                     |
| `src/db/database.ts`              | Open SQLite (WAL, foreign keys), run migrations, transaction helper                                               |
| `src/db/migrations.ts`            | Ordered schema migrations, versioned with `PRAGMA user_version`                                                   |
| `src/llm/types.ts`                | `LlmProvider` interface and message types                                                                         |
| `src/llm/sse.ts`                  | Parses the SSE stream coming **from** the backend                                                                 |
| `src/llm/ollamaProvider.ts`       | Native Ollama client (`/api/chat`, `/api/tags`, unload). Sends `num_ctx`, `min_p`, `repeat_penalty`, `keep_alive` |
| `src/llm/ndjson.ts`               | Parses Ollama's newline-delimited JSON stream                                                                     |
| `src/llm/openaiCompatProvider.ts` | Streaming client for `/v1/chat/completions` (llama.cpp, KoboldCpp, LM Studio)                                     |
| `src/llm/createProvider.ts`       | Picks the LLM and embedding providers from `LLM_PROVIDER`                                                         |
| `src/llm/complete.ts`             | Non-streaming helper (used by the background memory tasks)                                                        |
| `src/characters/*`                | Character Card V1/V2/V3 schemas, `.json`/`.png` loader, in-memory registry                                        |
| `src/prompt/tokenEstimator.ts`    | Cheap, conservative token estimate (~3.5 chars/token)                                                             |
| `src/prompt/promptBuilder.ts`     | Card + memory + history → messages, within the token budget                                                       |
| `src/chat/sessionStore.ts`        | `SessionStore` interface and session/message types                                                                |
| `src/chat/sqliteSessionStore.ts`  | SQLite implementation (prepared statements)                                                                       |
| `src/chat/chatService.ts`         | Send, regenerate, abort, list and delete chats. One generation per chat at a time                                 |
| `src/memory/embeddings.ts`        | `EmbeddingProvider`, `/v1/embeddings` client, vector maths and BLOB encoding                                      |
| `src/memory/memoryStore.ts`       | Long-term memories per character, brute-force cosine search                                                       |
| `src/memory/summarizer.ts`        | Which messages to summarize (pure function) and the summary prompt                                                |
| `src/memory/factExtractor.ts`     | Fact + mood extraction prompt and tolerant JSON parsing                                                           |
| `src/memory/memoryService.ts`     | Orchestration: build the memory context, schedule background tasks, de-duplication                                |
| `src/util/serialQueue.ts`         | Runs async tasks one at a time per key (per character)                                                            |
| `src/util/gpuGate.ts`             | Shared/exclusive GPU access: LLM calls are shared, image generation is exclusive and waits for running calls      |
| `src/llm/gated.ts`                | `GatedLlmProvider` / `GatedEmbeddingProvider`: route every LLM and embedding call through the gate                |
| `src/images/safety.ts`            | Code-enforced "no minors" rule: term and age detection (EN/FR, Unicode-aware), forced `adult` tags and negatives  |
| `src/images/photoPrompt.ts`       | Asks the LLM for `{caption, scene}`, with tolerant JSON parsing and a fallback                                    |
| `src/images/workflow.ts`          | Standard SDXL txt2img graph in ComfyUI API format                                                                 |
| `src/images/comfyClient.ts`       | `/prompt`, `/history` polling, `/view` (PNG check), `/free`, cancel on abort, `/object_info` status               |
| `src/images/imageStore.ts`        | Image metadata (file, scene, prompt, seed)                                                                        |
| `src/images/imageService.ts`      | Orchestration: safety → photo idea → exclusive GPU phase → store file and messages                                |
| `src/util/mutex.ts`               | One-at-a-time execution that returns each task's result or error to its own caller (voice engines)                |
| `src/voice/catalog.ts`            | Downloadable STT models and TTS voices: URL, pinned SHA-256, file layout                                          |
| `src/voice/sherpaVoice.ts`        | Whisper and Piper engines, loaded lazily on first use, one request at a time                                      |
| `src/voice/speechText.ts`         | Strips `*actions*`, emojis, markdown and URLs before synthesis                                                    |
| `src/voice/wav.ts`                | 16-bit WAV encoding and float32 PCM decoding                                                                      |
| `scripts/setupVoice.ts`           | `npm run setup:voice`: download, verify the checksum, then extract atomically                                     |
| `public/speech.js`                | `SentenceSplitter`: streamed text → speakable sentences (never cuts inside `*actions*` or before a closing `»`)   |
| `public/voice.js`                 | `Recorder` (mic → 16 kHz mono float32) and `Speaker` (ordered playback queue, can be interrupted)                 |
| `src/http/*`                      | Routes, error mapping, security hooks, SSE to the browser                                                         |
| `src/index.ts`                    | Composition root: wires everything, graceful shutdown                                                             |

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

## Database schema (v1)

| Table                    | Key columns                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`               | `id`, `character_id`, `title`, `summary`, `summarized_until`, `facts_extracted_until`, `mood`                                                                                                   |
| `messages`               | `seq` (autoincrement, used as a cursor), `id` (UUID, public), `session_id` → cascade delete, `role`, `content`                                                                                  |
| `images` (v2)            | `id`, `session_id` → cascade delete, `file_name`, `scene` (fed back to the LLM), `prompt`, `seed`                                                                                               |
| `messages.image_id` (v2) | Links a photo message to its image (set NULL if the image row is gone)                                                                                                                          |
| `memories`               | `id`, `character_id`, `category` (`user`/`character`/`relationship`/`event`), `content`, `embedding` (float32 BLOB, L2-normalised), `embedding_model`, `source_session_id` → set NULL on delete |

Vectors are only compared with vectors from the same `embedding_model`, so changing the model never mixes
incompatible spaces. Old memories then rank by recency until they are re-learned.

## SSE protocol (server → browser)

| Event   | Data                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| `token` | `{ "text": string }`                                                                                              |
| `done`  | `{ "messageId": string \| null, "aborted": boolean, "estimatedPromptTokens": number, "droppedMessages": number }` |
| `error` | `{ "message": string }`                                                                                           |

## HTTP API

| Method | Path                           | Body                                                               | Response                                                                    |
| ------ | ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| GET    | `/api/health`                  | —                                                                  | `{ status, llm: { ok, models?, error? } }`                                  |
| GET    | `/api/config`                  | —                                                                  | `{ userName, memoryEnabled }`                                               |
| GET    | `/api/characters`              | —                                                                  | `[{ id, name, creatorNotes, tags }]`                                        |
| GET    | `/api/characters/:id/sessions` | —                                                                  | `[{ id, title, createdAt, updatedAt, messageCount }]` (newest first)        |
| POST   | `/api/sessions`                | `{ characterId }`                                                  | `201 { session, character }`                                                |
| GET    | `/api/sessions/:id`            | —                                                                  | `{ session (with summary, mood), character }`                               |
| DELETE | `/api/sessions/:id`            | —                                                                  | `204` (memories are kept)                                                   |
| POST   | `/api/sessions/:id/messages`   | `{ text }` (1–8000 chars)                                          | SSE stream                                                                  |
| POST   | `/api/sessions/:id/regenerate` | —                                                                  | SSE stream                                                                  |
| GET    | `/api/characters/:id/memories` | —                                                                  | `[{ id, category, content, createdAt, updatedAt }]`                         |
| POST   | `/api/characters/:id/memories` | `{ category, content }` (3–300 chars)                              | `201`, or `409` if it duplicates an existing memory                         |
| DELETE | `/api/memories/:id`            | —                                                                  | `204`                                                                       |
| GET    | `/api/images/status`           | —                                                                  | `{ available, checkpoint?, reason? }`                                       |
| POST   | `/api/sessions/:id/photo`      | `{ request? }` (≤ 300 chars)                                       | `{ message }` with `imageId` (20–60 s; cancelled if the client disconnects) |
| GET    | `/api/images/:id`              | —                                                                  | `image/png`                                                                 |
| GET    | `/api/voice`                   | —                                                                  | `{ stt: { available, model, reason? }, tts: {…} }`                          |
| POST   | `/api/stt`                     | `application/octet-stream`: float32 LE mono 16 kHz, ≤ 4 MB (~60 s) | `{ text }` (empty if under 0.3 s)                                           |
| POST   | `/api/tts`                     | `{ text }` (1–1000 chars)                                          | `audio/wav`, or `204` if nothing is speakable                               |

Error statuses: `400` invalid input · `403` cross-origin · `404` not found · `409` already generating or duplicate ·
`413` prompt or upload too large · `415` wrong content type · `421` wrong Host · `422` photo refused (safety) ·
`502` LLM backend or ComfyUI error · `503` voice/photos not installed or disabled.

## Tooling

| Path                                                  | Role                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `eslint.config.js`                                    | Flat config: `typescript-eslint` strict type-checked rules, browser globals for `public/`, Prettier compatibility              |
| `.prettierrc.json`, `.editorconfig`, `.gitattributes` | One formatting style, LF line endings (CRLF for `.bat`)                                                                        |
| `.github/workflows/ci.yml`                            | Format, lint, type check, tests and build on Node 22 and 24 (read-only permissions, cancels outdated runs)                     |
| `scripts/launch.ts` + `start.bat`                     | Launcher: start Ollama and ComfyUI if needed, rebuild if stale, start girllm, open the browser, stop on Ctrl+C what it started |
| `scripts/launcherLib.ts`                              | Testable launcher helpers (ComfyUI layout detection, staleness, readiness polling)                                             |

## Design decisions

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
- **Voice on the CPU**: a 12B model already fills 8 GB of VRAM, and Whisper base and Piper are fast enough on a
  6-core CPU.
- **Sentence splitting in the browser**: the SSE protocol stays unchanged and TTS remains optional. The browser sends
  each sentence as soon as it's complete and plays the clips in order, while the server synthesizes one at a time.
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
