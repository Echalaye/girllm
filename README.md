# girllm

A **local, private AI companion / roleplay chat** that runs entirely on your own PC.
Nothing leaves your machine: the model runs on your GPU through [Ollama](https://ollama.com)
(or any OpenAI-compatible server), and the app only listens on `127.0.0.1`.

> **Status: all 4 steps done.** Streaming chat with characters, long-term memory, voice (talk and hear her
> answer), and photos generated on demand, all offline. See the [roadmap](#roadmap).

![stack](https://img.shields.io/badge/Node-22-339933) ![ts](https://img.shields.io/badge/TypeScript-strict-3178c6)

---

## Features

### Photos (step 4)

- **📷 Ask for a photo**: type what you'd like ("a selfie at the climbing gym") and click 📷, or leave the box empty
  and she picks something that fits the moment. She sends it with a caption, in the chat language.
- **She looks the same in every photo**: each card can define a fixed `appearance` (see [Characters](#characters)).
- **She remembers what she sent**: the next replies know what the photo showed.
- Generated locally by **ComfyUI** (SDXL). The chat model is unloaded from the GPU during generation and reloads
  automatically afterwards.
- **Adults only, enforced in code**: requests, generated prompts and cards are checked, and anything suggesting a
  minor is refused before it reaches the image model (see [Security](#security)).

### Voice (step 3)

- **Talk instead of typing**: click 🎤, speak, click Stop. Your voice is transcribed locally by Whisper and sent.
- **Hear her answer** (🔊 Voice on): replies are spoken **sentence by sentence while they're being written**, so she
  starts talking within a second or two. Stage directions like `*smiles*` are not read aloud.
- Talking (or pressing Stop) interrupts her, like a real conversation.
- Several French voices (female and male) plus English. Everything runs **on the CPU**, so the GPU stays free for the
  LLM, and no audio ever leaves your PC.

### Memory (step 2)

- **Saved chats** (SQLite): reopen any previous chat from the chat list. Everything survives a restart.
- **Running summary ("story so far")**: when the chat gets long, older messages are folded into a summary that
  stays in the prompt, instead of being silently forgotten.
- **Long-term memories**: facts about you, her, your relationship and events are extracted automatically and
  shared by **every chat with that character**. The most relevant ones are found by semantic search for each reply.
- **Mood**: the character's current mood is tracked and carried into the next replies.
- **Memory panel**: see the summary and mood, add memories by hand, and make her forget wrong ones.

### Chat (step 1)

- Replies stream in token by token (SSE), with **Stop** and **Regenerate** ("swipe") buttons.
- **Character Card V2/V3 support** (`.json` or `.png`). Cards from SillyTavern / chub.ai work as-is.
- **Token-budgeted prompt**: the character definition is always kept, and the oldest messages are dropped first when the context is full.
- Stop sequences so the model doesn't write your lines for you.
- Backend-agnostic: Ollama, llama.cpp server, KoboldCpp, LM Studio… (change one URL).
- Hardened for local use: Host-header allow-list (anti DNS-rebinding), Origin check, strict CSP, input validation.

---

## Requirements

| What | Version | Notes |
|---|---|---|
| Node.js | **≥ 22.13** | `node -v`. Needed for the built-in `node:sqlite` module (no native build tools needed) |
| Ollama | recent release | **Required for the RTX 5060 (Blackwell)**: old builds lack CUDA 12.8 / `sm_120` and silently run on the CPU |
| GPU | 8 GB VRAM | Tested target: RTX 5060 8 GB |

---

## Quick start (Windows / PowerShell)

### 1. Install and configure Ollama

Set these **user environment variables** (Settings → System → About → Advanced system settings →
Environment Variables), then **restart Ollama** (quit it from the tray icon and relaunch):

| Variable | Value | Why |
|---|---|---|
| `OLLAMA_FLASH_ATTENTION` | `1` | Less VRAM, faster |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | Halves the context's VRAM cost with a negligible quality loss |

You don't need `OLLAMA_CONTEXT_LENGTH`: with `LLM_PROVIDER=ollama` (the default) the app sends the context size
(`CONTEXT_TOKENS`) with every request.

Then pull a model:

```powershell
ollama pull mistral-nemo:12b-instruct-2407-q4_K_M
ollama pull paraphrase-multilingual     # embedding model for memory search (~0.6 GB, French OK)
```

### 2. Run the app

```powershell
cd C:\Users\etien\Desktop\girllm
npm install
copy .env.example .env      # then edit USER_NAME, model, etc.
npm run setup:voice         # optional: downloads the voice models (~265 MB, checksum-verified)
npm run dev                 # hot reload, or: npm run build ; npm start
```

Open **http://127.0.0.1:3210**.

### 2b. Optional: photos with ComfyUI

1. Download the latest **ComfyUI portable for Windows (NVIDIA)** from the ComfyUI GitHub releases and extract it.
   Recent builds ship PyTorch with CUDA 12.8, which the **RTX 5060 (Blackwell) requires**. Older builds won't use
   the GPU.
2. Put an **SDXL checkpoint** (`.safetensors` only) in `ComfyUI\models\checkpoints\`: the official SDXL base 1.0,
   or a realistic SDXL fine-tune for more natural photos.
3. Start ComfyUI with `run_nvidia_gpu.bat`. It listens on `http://127.0.0.1:8188`.
4. In `.env`, set `IMAGE_CHECKPOINT=` to the file name exactly as it appears in ComfyUI, then restart girllm.
   The startup log should say `Photos: on`. If not, it says why (ComfyUI not reachable, checkpoint not found…).

A photo typically takes 20–40 s on an 8 GB card, mostly spent swapping models between the LLM and SDXL. The
first one is slower because ComfyUI loads the checkpoint from disk.

### 3. Check the model is really on the GPU

While a reply is being generated, run:

```powershell
ollama ps        # PROCESSOR column must say "100% GPU"
nvidia-smi       # VRAM usage should be ~7 GB
```

If you see `CPU/GPU` split, the model + context don't fit in 8 GB (Windows itself uses ~0.5 GB).
In that case, lower `CONTEXT_TOKENS` (e.g. 6144), use a smaller quantization
(IQ4_XS), or switch to a 7–8B model.

---

## Choosing a model (8 GB VRAM)

| Size | Quantization | Context | Notes |
|---|---|---|---|
| 12B (Mistral Nemo family) | Q4_K_M / IQ4_XS | 6–8k | Best quality for roleplay. Fits tightly |
| 7–8B (Llama 3.1, Qwen) | Q5_K_M / Q6_K | 12–16k | Faster, longer context, decent French |

Roleplay fine-tunes of these models (on Hugging Face, in GGUF format) are usually much better than the
base instruct models. Ollama can pull them directly:

```powershell
ollama pull hf.co/<user>/<repo>-GGUF:Q4_K_M
```

Only download **`.gguf`** / **`.safetensors`** files, never pickle (`.bin`, `.pt`) files from unknown sources.

---

## Characters

Drop `.json` or `.png` character cards into `characters/` and restart. An example card, **Aria**, is included.

Supported macros in card fields: `{{char}}`, `{{user}}` (and the legacy `<BOT>` / `<USER>`).
Your name comes from `USER_NAME` in `.env`.

| Card field | Used for |
|---|---|
| `system_prompt` | Replaces the default instructions (if not empty) |
| `description`, `personality`, `scenario` | Character definition in the system prompt |
| `mes_example` | Example dialogue (style reference). Blocks separated by `<START>` |
| `first_mes` | Greeting that opens every new chat |
| `post_history_instructions` | Reminder injected after the history (strong steering) |
| `extensions.girllm.appearance` | Fixed look used for **every photo** (image-prompt tags): `"woman, 26 years old, shoulder-length wavy auburn hair, green eyes, …"`. Without it, the LLM improvises the look from the description, which varies between photos |

All characters must be adults. The default system prompt states it explicitly, and photos are refused for a card
that states an age under 18.

### Chatting in French (or another language)

1. Set `REPLY_LANGUAGE=French` in `.env`. The instruction is added to the system prompt **and** repeated right
   before each reply, because small models tend to drift back to the card's language.
2. For the most natural result, use a card **written in that language**. Models copy the language and style of the
   greeting (`first_mes`) and the example dialogue. `characters/aria-fr.json` is a French version of Aria.
   It shows up in the character list as a second "Aria".

Mistral Nemo-based models (Mistral AI is French) and Qwen models handle French well. Llama 3.1 8B is weaker.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Keep loopback: the API has **no authentication** |
| `PORT` | `3210` | |
| `LLM_PROVIDER` | `ollama` | `ollama` = native Ollama API (recommended). `openai` = any OpenAI-compatible server (llama.cpp, KoboldCpp, LM Studio) |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` | Base URL **without** `/v1` |
| `LLM_KEEP_ALIVE` | `30m` | How long Ollama keeps the model in VRAM after the last request (`2h`, `-1` = forever) |
| `LLM_MODEL` | `mistral-nemo:12b-instruct-2407-q4_K_M` | Model name as known by the backend |
| `LLM_API_KEY` | *(empty)* | Only for backends requiring one |
| `CONTEXT_TOKENS` | `8192` | Context window. Applied automatically with `ollama`; with `openai` it must match the backend |
| `MAX_REPLY_TOKENS` | `400` | Max reply length |
| `TEMPERATURE` / `TOP_P` | `0.7` / `0.95` | Sampling. Lower temperature = more coherent |
| `MIN_P` | `0.05` | Drops very unlikely tokens: the best guard against incoherent tangents |
| `REPEAT_PENALTY` | `1.1` | `>1` discourages repetition |
| `CHARACTERS_DIR` | `./characters` | |
| `USER_NAME` | `User` | Your name in the story |
| `REPLY_LANGUAGE` | *(empty)* | Force the reply language, e.g. `French`. Letters only. Empty = no constraint |
| `DATA_DIR` | `./data` | Where `girllm.db` (chats + memories) is stored. Git-ignored |
| `MEMORY_ENABLED` | `true` | `false` = step 1 behaviour (chats are still saved) |
| `EMBEDDING_MODEL` | `paraphrase-multilingual` | Embedding model for memory search. Empty = memories picked by recency only |
| `EMBEDDING_BASE_URL` | = `LLM_BASE_URL` | Backend serving the embedding model |
| `MEMORY_TOP_K` | `8` | Max memories injected per reply |
| `MEMORY_EXTRACT_EVERY` | `4` | Facts are extracted once this many new messages are pending |
| `VOICE_ENABLED` | `true` | Voice buttons only appear for the models that are installed |
| `MODELS_DIR` | `./models` | Where `npm run setup:voice` puts the voice models. Git-ignored |
| `STT_MODEL` | `whisper-base` | `whisper-tiny`, `whisper-base`, `whisper-small` (more accurate, ~3× slower) |
| `STT_LANGUAGE` | *(empty = auto)* | The language you speak, e.g. `fr`. Setting it avoids misdetections on short sentences |
| `TTS_VOICE` | `fr-siwis` | `fr-siwis`, `fr-jessica` (female), `fr-pierre`, `fr-tom` (male), `en-amy` |
| `TTS_SPEED` | `1` | `0.5`–`2` |
| `VOICE_THREADS` | `4` | CPU threads per voice engine |
| `IMAGES_ENABLED` | `true` | Shows the 📷 button (it explains why if ComfyUI isn't ready) |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | |
| `IMAGE_CHECKPOINT` | *(empty = no photos)* | SDXL checkpoint file name, as listed by ComfyUI |
| `IMAGE_WIDTH` / `IMAGE_HEIGHT` | `832` / `1216` | Multiples of 8. SDXL works best around 1 megapixel |
| `IMAGE_STEPS` / `IMAGE_CFG` | `25` / `5.5` | |
| `IMAGE_SAMPLER` / `IMAGE_SCHEDULER` | `dpmpp_2m` / `karras` | ComfyUI names |
| `IMAGE_STYLE` | `photograph, realistic, …` | Tags added to every photo, e.g. `anime style, cel shading` |
| `IMAGE_NEGATIVE_PROMPT` | `lowres, blurry, …` | Child-related terms are always added on top, whatever you set |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`… |

Invalid values stop the app at startup with an explicit message.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with hot reload (tsx) |
| `npm run setup:voice` | Download the voice models chosen in `.env`. `-- --list` shows all of them, `-- fr-tom whisper-small` installs specific ones |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit + HTTP tests (Vitest), no GPU needed |

---

## Security

- Listens on `127.0.0.1` only by default. Exposing it on your LAN prints a warning. For phone access, prefer **Tailscale**
  over opening a port.
- **Host allow-list**: requests whose `Host` header isn't the app's own address are rejected (`421`), which blocks
  DNS-rebinding attacks from malicious websites.
- **Origin check**: cross-site requests from other websites are rejected (`403`).
- Strict **CSP** (`default-src 'self'`, no inline scripts). Model output is rendered with `textContent`, never as HTML.
- Inputs validated with zod. Body limit 64 KB, messages ≤ 8000 characters, card files ≤ 20 MB.
- Conversations and memories are stored **unencrypted** in `data/girllm.db`, which is git-ignored. They are as
  private as your Windows account: don't put the folder in a synced/shared directory if that matters to you.
- All SQL uses bound parameters. Text produced by the model (summary, memories) is inserted in the prompt as clearly
  delimited data under the instructions.
- **Photos never depict minors**. This rule is enforced in code and can't be configured:
  - the photo request, the scene written by the LLM and the final prompt are checked for minor-related terms and
    under-18 ages, in English and French, and the request is refused before anything is generated;
  - a card that states an age under 18 can't receive photos;
  - every prompt starts with `adult`, and child-related terms are always added to the negative prompt.

  The check is deliberately strict: an occasional false positive just means rephrasing the request.
- Generated images are stored in `data/images/` (git-ignored) and deleted along with their chat. They're served by
  id only, with the file path taken from the database and never from the URL.

---

## Voice

```
🎤 mic ─► browser records (webm/opus) ─► decodes + resamples to 16 kHz mono ─► POST /api/stt
        ─► Whisper (sherpa-onnx, CPU) ─► text ─► sent as a normal message

reply tokens ─► SentenceSplitter (in the browser) ─► each complete sentence ─► POST /api/tts
        ─► *actions* / emojis removed ─► Piper voice (sherpa-onnx, CPU) ─► WAV ─► played in order
```

- **Setup**: `npm run setup:voice` downloads only from the official sherpa-onnx GitHub releases, and checks each
  archive against a pinned SHA-256 before extracting it.
- **Speed** (6-core CPU): transcription takes well under the length of what you said with `whisper-base`; a sentence
  of speech is synthesized in a fraction of a second.
- **Accuracy**: `whisper-base` is good for everyday French but can stumble on names. Try `STT_MODEL=whisper-small`
  if it misunderstands you too often (then run `npm run setup:voice` again).
- **Microphone access** requires a "secure context": `http://127.0.0.1:3210` and `http://localhost:3210` work. A LAN
  or Tailscale IP over plain HTTP doesn't: the mic button is greyed out there.
- Speech recognition and synthesis each handle one request at a time; extra requests wait their turn.

---

## Photos

```
📷 + optional request
  ─► safety checks (request, card)
  ─► the chat model writes {caption (chat language), scene (English tags)}         normal GPU use
  ─► final prompt = "adult" + IMAGE_STYLE + card appearance + scene  ─► safety check
  ─► EXCLUSIVE GPU PHASE                          (other LLM calls wait, in every chat)
       unload the Ollama model ─► ComfyUI SDXL txt2img ─► ComfyUI /free
  ─► PNG saved in data/images, "📷 request" + photo message added to the chat
```

- The "GPU gate" ensures nothing uses the LLM during generation, including background memory tasks and other
  chats. The next message reloads the model automatically (a few seconds).
- The embedding model (~0.6 GB) stays loaded; ComfyUI manages the rest of the VRAM.
- With `LLM_PROVIDER=openai`, the app can't unload the model, so free VRAM yourself or use a smaller model.
- Click a photo to open it full size. Pressing Stop cancels the generation in ComfyUI.

---

## How memory works

```
each reply ─► prompt = character card
                     + relevant long-term memories (semantic search on your last message)
                     + story so far (running summary)
                     + current mood
                     + recent messages, verbatim
           ─► after the reply, in the background (never blocks the chat):
                1. if the verbatim history is above ~50% of the context: summarize its oldest part
                2. every few messages: extract new facts + mood (JSON), de-duplicate, store
```

- These background tasks use **your chat model**, so right after a reply Ollama may be busy for a few seconds.
  A message sent meanwhile simply waits its turn.
- The latest reply is only mined for facts once you answer it, so regenerating a reply never leaves "ghost" memories behind.
- Memories belong to a **character**, so a new chat with Aria still knows what she learned before. Deleting a chat
  keeps its memories. Use the Memory panel to remove them.
- **VRAM**: the embedding model is small (~0.6 GB), but with a 12B model already filling 8 GB, Ollama may swap models.
  If replies get slow, set `EMBEDDING_MODEL=` (recency-only memories) or use a 7–8B chat model.
- At startup Node prints `ExperimentalWarning: SQLite is an experimental feature`. It's harmless: `node:sqlite`
  is built into Node and stable enough for this use.

---

## Roadmap

1. ✅ **Streaming chat + character persona**
2. ✅ **Memory**: SQLite persistence, running summary, long-term memories with semantic search, mood
3. ✅ **Voice**: Whisper speech-to-text and Piper French voices, on the CPU via sherpa-onnx
4. ✅ **Photos on demand** (this step): ComfyUI SDXL, with GPU handover between the LLM and the image model

Ideas for later: a LoRA or IP-Adapter for an even more consistent face, voice cloning (option B: a Python
XTTS service), and per-character voices.

Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
