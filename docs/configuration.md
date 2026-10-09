# Configuration

girllm reads its settings from `.env` (copy `.env.example` to start). Invalid values stop the app at startup
with an explicit message.

## `.env` or the Settings panel?

Most values (your name, reply language, chat model and sampling, the language you speak, image parameters, chat
background) can also be changed from ⚙ **Settings** in the app. Values saved there are stored in the database and
take precedence over `.env` until you click **Restore .env values**; they apply to the next message, no restart.

Ports, folders, context size, providers and the phone listener stay in `.env`: they need a restart.

## All variables

| Variable                                    | Default                                           | Description                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                                      | `127.0.0.1`                                       | Keep loopback: the API has **no authentication**                                                                                            |
| `PORT`                                      | `3210`                                            |                                                                                                                                             |
| `LAN_ENABLED`                               | `false`                                           | Phone app (step 8): HTTPS listener for paired phones on your local network only                                                             |
| `LAN_PORT`                                  | `3211`                                            | Its port. Allow Node.js on **Private** networks when Windows Firewall asks                                                                  |
| `LLM_PROVIDER`                              | `ollama`                                          | `ollama` = native Ollama API (recommended). `openai` = any OpenAI-compatible server (llama.cpp, KoboldCpp, LM Studio)                       |
| `LLM_BASE_URL`                              | `http://127.0.0.1:11434`                          | Base URL **without** `/v1`                                                                                                                  |
| `LLM_KEEP_ALIVE`                            | `30m`                                             | How long Ollama keeps the model in VRAM after the last request (`2h`, `-1` = forever)                                                       |
| `LLM_MODEL`                                 | `mistral-nemo:12b-instruct-2407-q4_K_M`           | Model name as known by the backend                                                                                                          |
| `LLM_API_KEY`                               | _(empty)_                                         | Only for backends requiring one                                                                                                             |
| `CONTEXT_TOKENS`                            | `8192`                                            | Context window. Applied automatically with `ollama`; with `openai` it must match the backend                                                |
| `MAX_REPLY_TOKENS`                          | `400`                                             | Max reply length                                                                                                                            |
| `TEMPERATURE` / `TOP_P`                     | `0.7` / `0.95`                                    | Sampling. Lower temperature = more coherent                                                                                                 |
| `MIN_P`                                     | `0.05`                                            | Drops very unlikely tokens: the best guard against incoherent tangents                                                                      |
| `REPEAT_PENALTY`                            | `1.1`                                             | `>1` discourages repetition                                                                                                                 |
| `CHARACTERS_DIR`                            | `./characters`                                    |                                                                                                                                             |
| `USER_NAME`                                 | `User`                                            | Your name in the story                                                                                                                      |
| `REPLY_LANGUAGE`                            | _(empty)_                                         | Force the reply language, e.g. `French`. Letters only. Empty = no constraint                                                                |
| `DATA_DIR`                                  | `./data`                                          | Where `girllm.db` (chats, memories, settings), `images/` and `faces/` are stored. Git-ignored                                               |
| `MEMORY_ENABLED`                            | `true`                                            | `false` = step 1 behaviour (chats are still saved)                                                                                          |
| `EMBEDDING_MODEL`                           | `paraphrase-multilingual`                         | Embedding model for memory search. Empty = memories picked by recency only                                                                  |
| `EMBEDDING_BASE_URL`                        | = `LLM_BASE_URL`                                  | Backend serving the embedding model                                                                                                         |
| `MEMORY_TOP_K`                              | `8`                                               | Max memories injected per reply                                                                                                             |
| `MEMORY_EXTRACT_EVERY`                      | `4`                                               | Facts are extracted once this many new messages are pending                                                                                 |
| `VOICE_ENABLED`                             | `true`                                            | Voice buttons only appear for what is installed and running (her voice needs ComfyUI, `COMFYUI_URL`)                                        |
| `MODELS_DIR`                                | `./models`                                        | Where `npm run setup:voice` puts the Whisper models (her voice goes into ComfyUI). Git-ignored                                              |
| `STT_MODEL`                                 | `whisper-base`                                    | `whisper-tiny`, `whisper-base`, `whisper-small` (more accurate, ~3× slower)                                                                 |
| `STT_LANGUAGE`                              | _(empty = auto)_                                  | The language you speak, e.g. `fr`. Setting it avoids misdetections on short sentences                                                       |
| `VOICE_THREADS`                             | `4`                                               | CPU threads of speech recognition (`TTS_VOICE` / `TTS_SPEED` of step 3 are ignored since step 7)                                            |
| `IMAGES_ENABLED`                            | `true`                                            | Shows the 📷 button (it explains why if ComfyUI isn't ready)                                                                                |
| `COMFYUI_DIR`                               | _(empty)_                                         | ComfyUI install folder, so `start.bat` can start it. Only used by the launcher                                                              |
| `COMFYUI_URL`                               | `http://127.0.0.1:8188`                           |                                                                                                                                             |
| `IMAGE_CHECKPOINT`                          | _(empty = no photos)_                             | SDXL checkpoint file name, as listed by ComfyUI                                                                                             |
| `IMAGE_WIDTH` / `IMAGE_HEIGHT`              | `832` / `1216`                                    | Multiples of 8. SDXL works best around 1 megapixel                                                                                          |
| `IMAGE_STEPS` / `IMAGE_CFG`                 | `25` / `5.5`                                      | See [Getting better photos](photos.md#getting-better-photos) for per-checkpoint values                                                      |
| `IMAGE_SAMPLER` / `IMAGE_SCHEDULER`         | `dpmpp_2m` / `karras`                             | ComfyUI names                                                                                                                               |
| `IMAGE_STYLE`                               | `candid smartphone photo, RAW photo, …`           | Tags added to every photo. For an anime look: `anime style, cel shading, vibrant colors` (and remove `anime` from the negative)             |
| `IMAGE_NEGATIVE_PROMPT`                     | `cgi, 3d render, plastic skin, …`                 | Child-related terms are always added on top, whatever you set                                                                               |
| `IMAGE_HIRES_SCALE`                         | `1.25`                                            | Second refinement pass: sharper face and skin, ~1.6× slower. `1` = off                                                                      |
| `IMAGE_HIRES_DENOISE` / `IMAGE_HIRES_STEPS` | `0.35` / `15`                                     | How much the second pass may change the image / its steps                                                                                   |
| `IMAGE_FACE_WEIGHT`                         | `0.7`                                             | Reference face strength (IP-Adapter). `0` = off; 0.6–0.8 keeps her face while leaving the scene free                                        |
| `IMAGE_DETAIL_STRENGTH`                     | `0.35`                                            | Face detail pass: how much a small face is redrawn (0–0.7). `0` = off; above 0.45 the face may change                                       |
| `PHOTO_FREQUENCY`                           | `rare`                                            | Photos she sends on her own: `off`, `rare` (≥ 12 of her messages apart), `often` (≥ 5 apart). Asking for one lifts the limit                |
| `REALISTIC_ENGINE`                          | `flux2-klein`                                     | Photo model of realistic characters: `flux2-klein` (FLUX.2 [klein] 4B) or `sdxl` (`IMAGE_CHECKPOINT`). Falls back to `sdxl` until installed |
| `PROACTIVE_AFTER_MINUTES`                   | `60`                                              | She writes first after this many minutes of silence. `0` = never                                                                            |
| `ANIME_CHECKPOINT`                          | `animagine-xl-4.0-opt.safetensors`                | Image model for anime characters (installed by `npm run setup:images -- --anime`)                                                           |
| `ANIME_STEPS` / `ANIME_CFG`                 | `28` / `5`                                        | Animagine's recommended values                                                                                                              |
| `ANIME_SAMPLER` / `ANIME_SCHEDULER`         | `euler_ancestral` / `normal`                      | "Euler a", as recommended                                                                                                                   |
| `ANIME_STYLE`                               | `masterpiece, high score, great score, absurdres` | Quality tags, placed last in anime prompts                                                                                                  |
| `ANIME_NEGATIVE_PROMPT`                     | `lowres, bad anatomy, … low score, …`             | Youth-related tags are always added on top                                                                                                  |
| `ANIME_HIRES_SCALE`                         | `1`                                               | Detail pass for anime (off: the model is already sharp)                                                                                     |
| `ANIME_FACE_WEIGHT`                         | `0`                                               | Reference face for anime (the face model is trained on photos: try 0.3–0.5)                                                                 |
| `ANIME_DETAIL_STRENGTH`                     | `0.3`                                             | Face detail pass for anime characters (0–0.7, `0` = off)                                                                                    |
| `CHAT_BACKGROUND`                           | `subtle`                                          | Her picture behind the chat: `subtle` (blurred, dimmed), `clear` or `off`                                                                   |
| `LOG_LEVEL`                                 | `info`                                            | `debug`, `info`, `warn`…                                                                                                                    |

## Notes

- **Keep `HOST=127.0.0.1`.** The PC page has no login: it is meant for your own browser on your own PC. To use
  girllm from your phone, turn on the phone listener (`LAN_ENABLED=true`) instead: it is encrypted and paired, see
  [Phone app](mobile-app.md). Setting another `HOST` prints a warning at startup.
- **An anime look for every photo** (all characters) is possible with `IMAGE_STYLE=anime style, cel shading,
vibrant colors` (and remove `anime` from `IMAGE_NEGATIVE_PROMPT`), but per-character anime with Animagine
  (`artStyle` in the editor) gives much better results: see [Photos](photos.md).
- **OpenAI-compatible backends** (`LLM_PROVIDER=openai`): llama.cpp (`http://127.0.0.1:8080`), KoboldCpp
  (`http://127.0.0.1:5001`), LM Studio… Set `CONTEXT_TOKENS` to the backend's own context size. girllm can't unload
  the model from those backends before a photo or a voice, so free VRAM yourself or use a smaller model.
- **Data** lives in `DATA_DIR` (`./data`, git-ignored): `girllm.db` (chats, memories, settings, paired phones),
  `images/` (chat photos), `faces/`, `backgrounds/`, `voices/`, `speech-cache/`, `lan/` (the phone listener's
  certificate) and `logs/` (ComfyUI's log when `start.bat` starts it).
