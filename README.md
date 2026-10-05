# girllm

A **local, private AI companion / roleplay chat** that runs entirely on your own PC.
Nothing leaves your machine: the model runs on your GPU through [Ollama](https://ollama.com)
(or any OpenAI-compatible server), and the app only listens on `127.0.0.1`.

> **Status: step 6 done.** Streaming chat with characters, long-term memory, voice (push-to-talk or a hands-free
> call), photos she sends with a consistent face and detailed eyes, realistic or anime characters, her picture behind
> the chat, messages she writes first, lorebooks, an image test bench, a character editor and settings you change
> from the app, all offline.
> See the [roadmap](#roadmap).

[![CI](https://github.com/Echalaye/girllm/actions/workflows/ci.yml/badge.svg)](https://github.com/Echalaye/girllm/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/Node-22%20%7C%2024-339933) ![ts](https://img.shields.io/badge/TypeScript-strict-3178c6)

---

## Features

### Better photos and an image test bench (step 6)

- **Realistic photos by FLUX.2 [klein] 4B** (default once installed: `npm run setup:images -- --flux2-klein`, recent
  ComfyUI). It won every comparison on bodies, hands and framing, and is about 5× faster than the SDXL models
  (~15 s per photo on an 8 GB card). Her face goes in as a reference picture (cropped to the face), the prompt is
  written in sentences, 8 steps. Used for chat photos, reference portraits and chat backgrounds of realistic
  characters; anime characters stay on Animagine. Until it is installed, the SDXL checkpoint is used. Settings →
  Photos → "Photo model". Because this model has no negative prompt, its prompts go through a **stricter safety
  check** (young-look words like "pigtails" or "baby face" are refused on top of the usual rules).
- **Retake a photo**: the ↻ button on her photos draws the same scene again with a new picture and replaces it in
  the chat (the old one is deleted). Handy when a hand or a detail came out wrong.
- **Face detail pass** (like "ADetailer"): in a waist-up or full-body photo the face is only ~150 px wide, too few
  pixels for SDXL to draw the eyes properly. girllm now finds the face (a 1.6 MB detector running on the CPU in
  ~0.1 s), redraws that square at 1024 px with the same model, prompt and seed (and her reference face), then blends
  it back with soft edges. Close-up portraits are left alone. Strength: Settings → "Face detail pass" (0.35 for
  realistic, 0.3 for anime, 0 = off). It adds ~5–10 s per photo.
- **More natural bodies**: full-body scenes are drawn in a taller frame (768×1344 instead of 832×1216, same speed),
  and the default style no longer blurs the background (`shallow depth of field` made full bodies look fake), with
  `natural body proportions` added and `overly muscular, unrealistic body proportions, elongated body, doll-like`
  in the negative prompt.
- **Juggernaut XI**, a second realistic model, better at full bodies and hands (`npm run setup:images --
--juggernaut`, 7.1 GB, local like the others; licence CC BY-NC-ND 4.0: personal, non-commercial use).
- **Recommended settings per model**: picking RealVisXL, Juggernaut or Animagine in Settings fills in its sampler,
  scheduler, steps and CFG (click Save to apply).
- **Image test bench**: `npm run compare:images` draws 10 test shots (portrait, selfie, mirror, desk, cup, standing,
  sofa, outdoors, night, from behind) with the same seeds through each installed model, through the app's real
  pipeline, and writes a contact sheet (`data/compare-images/<date>/index.html`) to compare them side by side, with
  the picture before the face pass. See [Comparing image models](#comparing-image-models).
- **FLUX.2 [klein] 4B in the test bench** (step 6b): compared with the SDXL models and with its own variants (steps,
  base model, pose guide…) before it became the realistic photo model.

### Realistic or anime, and her picture behind the chat (step 5)

- **Drawn as Realistic photos or Anime**, per character (editor). Each style has its own image model and settings:
  realistic uses your photo checkpoint (RealVisXL…), anime uses **Animagine XL 4.0** (`npm run setup:images --
--anime`), with prompts written the way each model expects (photo words vs Danbooru tags, quality tags last for
  anime). Settings → "Anime characters".
- **Women and men**: "In pictures: Woman / Man" in the editor (`1girl`/`1boy`, woman/man).
- **Her picture behind the chat**, softly blurred and dimmed so the text stays readable (Settings → Display: subtle,
  clear or off). Per character, in the editor:
  - **Her scene** (default): "Generate 2 scenes" makes a wide picture of her in her usual place, from her card, with
    her reference face; pick the one you like.
  - **Her latest photo**: the background follows the last photo she sent in this chat.
  - Without a scene or a photo, her face is used.
- Anime pictures always state an adult (`adult, mature female/male`) and carry extra youth-related negative tags:
  anime models tend to draw characters young-looking.

### She lives a little more (step 4d)

- **She writes first.** A character without a fixed first message opens each new chat herself, in tune with the
  time of day. And after a silence (`PROACTIVE_AFTER_MINUTES`, 60 by default, 0 = never) she texts you on her own,
  once, never twice in a row. A message that arrives while the tab is in the background shows up in the tab title.
- **She sends photos on her own.** When it fits the moment, she adds a photo to her message (it appears in the
  same bubble). If you ask for one in a message ("envoie-moi une photo"), she can send one right away, or say no
  in character. Frequency: `PHOTO_FREQUENCY` = `off`, `rare` (default) or `often`. The 📷 button still works.
- **The same face in every photo.** The reference face chosen in the editor is applied to her photos with
  IP-Adapter Plus Face (`npm run setup:images`, once). Strength: `IMAGE_FACE_WEIGHT` (0.7 by default, 0 = off).
- **Her own voice.** Each character can have her own voice (character editor); otherwise the one from the settings.
- **Lorebooks.** Background facts (family, job, places, shared memories) with keywords: an entry is added to her
  notes only when the conversation mentions it, so long backstories cost nothing until they matter. Compatible with
  SillyTavern `character_book`.

### In the app (step 4c)

- **Settings panel** (gear icon, bottom left): your name, reply language, chat model, creativity, her voice and
  speaking speed, the image model and its parameters. Changes apply to the next message, no restart. `.env` still
  holds the defaults; "Restore .env values" goes back to them.
- **Character editor** (pencil icon, or "New character"): name, how she writes (text messages or roleplay), who she
  is, personality, situation, first message, appearance in photos, plus the advanced card fields. "Import a card"
  accepts SillyTavern / chub.ai `.json` and `.png` cards; "Export card" downloads a compatible V2 JSON. Deleting a
  character also deletes her chats, photos and memories (after a confirmation).
- **Reference face**: generate 4 portraits from her appearance and pick one, or upload a photo after confirming it
  is AI-generated, of yourself, or of an adult who agreed. Uploads are re-written without their metadata (EXIF, GPS,
  text). The face is her avatar, and step 4d keeps it in her photos.
- **Hands-free call** (phone icon): talk naturally, she hears when you stop, answers out loud, then listens again.
  Needs both voice engines installed (`npm run setup:voice`).
- **New interface**: sidebar with characters and chats, her portrait in the header, light and dark themes,
  keyboard- and screen-reader-friendly, usable on a phone-sized window.

### Human-like conversation (step 4b)

- **Two writing styles** per character: `texting` (short, natural phone messages: Aria) or `roleplay` (narrative
  with _actions_: the default for community cards).
- **She knows what time it is**: day, hour, and how long since your last message. No more "good morning" at
  11 pm, and a three-day silence gets noticed.
- **Less repetition**: the prompt points out how her last replies started and the phrases she keeps reusing.
- **Model comparison**: `npm run compare -- <model> <model>` runs the same French conversations through each model
  and writes a report, so you can choose on evidence.

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

| What    | Version        | Notes                                                                                                       |
| ------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js | **≥ 22.13**    | `node -v`. Needed for the built-in `node:sqlite` module (no native build tools needed)                      |
| Ollama  | recent release | **Required for the RTX 5060 (Blackwell)**: old builds lack CUDA 12.8 / `sm_120` and silently run on the CPU |
| GPU     | 8 GB VRAM      | Tested target: RTX 5060 8 GB                                                                                |

---

## Quick start (Windows / PowerShell)

### 1. Install and configure Ollama

Set these **user environment variables** (Settings → System → About → Advanced system settings →
Environment Variables), then **restart Ollama** (quit it from the tray icon and relaunch):

| Variable                 | Value  | Why                                                           |
| ------------------------ | ------ | ------------------------------------------------------------- |
| `OLLAMA_FLASH_ATTENTION` | `1`    | Less VRAM, faster                                             |
| `OLLAMA_KV_CACHE_TYPE`   | `q8_0` | Halves the context's VRAM cost with a negligible quality loss |

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

**Every day after that: double-click `start.bat`.** It:

1. starts **Ollama** if it isn't running yet;
2. starts **ComfyUI** if photos are configured and `COMFYUI_DIR` is set (its log goes to `data\logs\comfyui.log`);
3. rebuilds girllm if the code changed, starts it, and opens the browser.

`Ctrl+C` in its window stops everything **it** started. Services that were already running are left alone.
`start.bat --no-browser` skips opening the browser.

### 2b. Optional: photos with ComfyUI

1. Download the latest **ComfyUI portable for Windows (NVIDIA)** from the ComfyUI GitHub releases and extract it.
   Recent builds ship PyTorch with CUDA 12.8, which the **RTX 5060 (Blackwell) requires**. Older builds won't use
   the GPU.
2. Put an **SDXL checkpoint** (`.safetensors` only) in `ComfyUI\models\checkpoints\`. The official SDXL base 1.0
   works, but a photorealistic fine-tune gives much more natural people. See
   [Getting better photos](#getting-better-photos).
3. Start ComfyUI with `run_nvidia_gpu.bat`. It listens on `http://127.0.0.1:8188`. Or let `start.bat` do it: set
   `COMFYUI_DIR=C:\path\to\ComfyUI_windows_portable` in `.env`.
4. In `.env`, set `IMAGE_CHECKPOINT=` to the file name exactly as it appears in ComfyUI, then restart girllm.
   The startup log should say `Photos: on`. If not, it says why (ComfyUI not reachable, checkpoint not found…).

5. **Optional, recommended: the same face in every photo.** With `COMFYUI_DIR` set, run once:

   ```powershell
   npm run setup:images            # IP-Adapter nodes (pinned commit) + 2 models (~3.4 GB, checksum-verified)
   npm run setup:images -- --anime # the same + Animagine XL 4.0 for anime characters (+6.9 GB)
   npm run setup:images -- --juggernaut  # the same + Juggernaut XI, a second realistic model (+7.1 GB)
   npm run setup:images -- --flux2-klein # the same + FLUX.2 [klein] 4B, for the test bench (+12.5 GB)
   npm run setup:images -- --flux2-klein-base # + its undistilled model, slower, with a negative prompt (+4.1 GB)
   ```

   It also installs the small face detector used by the face detail pass (1.6 MB, into `MODELS_DIR`). Flags can
   be combined (`-- --anime --juggernaut`).

   Restart ComfyUI. The startup log should say `Reference faces: on (IP-Adapter)` (and `Anime photos: on`). Then
   give each character a reference face in the editor (generated or uploaded).

   Going from a realistic character to an anime one makes ComfyUI load the other model: the first picture after the
   switch takes 10–20 s longer.

A photo typically takes 20–40 s on an 8 GB card, mostly spent swapping models between the LLM and SDXL. The
first one is slower because ComfyUI loads the checkpoint from disk. The reference face adds a few seconds.

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

12B models in 4-bit are the sweet spot for 8 GB. Candidates worth comparing:

| Model                               | Pull command                                                 | Notes                                                                       |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Mistral Nemo 12B Instruct           | `ollama pull mistral-nemo:12b-instruct-2407-q4_K_M`          | Good French (Mistral AI is French). General-purpose, a bit "assistant-like" |
| Mag-Mell R1 (Nemo 12B fine-tune)    | `ollama pull hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS` | Roleplay/creative fine-tune: more personality. Check its French             |
| Rocinante v1.1 (Nemo 12B fine-tune) | `ollama pull hf.co/bartowski/Rocinante-12B-v1.1-GGUF:IQ4_XS` | Roleplay/creative fine-tune. Check its French                               |

`IQ4_XS` (~6.7 GB) leaves more room for the context than `Q4_K_M` (7.5 GB) with almost the same quality.
Roleplay fine-tunes are mostly trained on English, so their French can be weaker than the base model's. Don't
guess, compare:

```powershell
npm run compare -- mistral-nemo:12b-instruct-2407-q4_K_M hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS
```

The report (in `data\model-comparison-….md`) shows every reply side by side, the speed, and automatic flags:
assistant-like phrases, writing your lines, not French. Read the replies themselves: the flags catch problems,
not charm. Then set the winner in `LLM_MODEL`.

**Sampling**: `TEMPERATURE=0.7` and `MIN_P=0.05` are good defaults. Go up to `0.8`–`0.9` for more surprise, and
down to `0.6` if she loses the thread.

Only download **`.gguf`** / **`.safetensors`** files, never pickle (`.bin`, `.pt`) files from unknown sources.

---

## Characters

Create characters in the app (**New character**), import a `.json` / `.png` card from the sidebar, or drop card
files into `characters/` and restart. An example card, **Aria**, is included.

Cards created or edited in the app are saved as `characters/<id>.json` (Character Card V2, SillyTavern-compatible).
Editing a `.png` card (or a `.json` with another file name) saves the new `.json` and moves the original to
`characters/.originals/`, so nothing is lost and it isn't loaded twice. Reference faces live in `data/faces/`.

Supported macros in card fields: `{{char}}`, `{{user}}` (and the legacy `<BOT>` / `<USER>`).
Your name comes from `USER_NAME` in `.env`.

| Card field                               | Used for                                                                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system_prompt`                          | Replaces the default instructions (if not empty)                                                                                                                                                                             |
| `description`, `personality`, `scenario` | Character definition in the system prompt                                                                                                                                                                                    |
| `mes_example`                            | Example dialogue (style reference). Blocks separated by `<START>`                                                                                                                                                            |
| `first_mes`                              | Greeting that opens every new chat                                                                                                                                                                                           |
| `post_history_instructions`              | Reminder added at the end of the system prompt (strong steering)                                                                                                                                                             |
| `extensions.girllm.style`                | `"texting"` (short natural messages) or `"roleplay"` (narrative, default). Ignored if the card has its own `system_prompt`                                                                                                   |
| `extensions.girllm.artStyle`             | `"realistic"` (default) or `"anime"`: which image model and prompt conventions draw her                                                                                                                                      |
| `extensions.girllm.gender`               | `"female"` (default) or `"male"`: `1girl`/`1boy`, woman/man in pictures                                                                                                                                                      |
| `extensions.girllm.background`           | `"scene"` (default: her generated scene) or `"latest"` (her latest photo in the chat) behind the chat                                                                                                                        |
| `extensions.girllm.voice`                | Her own voice id (e.g. `"fr-jessica"`); absent = the voice from the settings                                                                                                                                                 |
| `extensions.girllm.appearance`           | Fixed look used for **every photo** (image-prompt tags): `"woman, 26 years old, shoulder-length wavy auburn hair, green eyes, …"`. Without it, the LLM improvises the look from the description, which varies between photos |

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

| Variable                                    | Default                                           | Description                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                                      | `127.0.0.1`                                       | Keep loopback: the API has **no authentication**                                                                                            |
| `PORT`                                      | `3210`                                            |                                                                                                                                             |
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
| `VOICE_ENABLED`                             | `true`                                            | Voice buttons only appear for the models that are installed                                                                                 |
| `MODELS_DIR`                                | `./models`                                        | Where `npm run setup:voice` puts the voice models. Git-ignored                                                                              |
| `STT_MODEL`                                 | `whisper-base`                                    | `whisper-tiny`, `whisper-base`, `whisper-small` (more accurate, ~3× slower)                                                                 |
| `STT_LANGUAGE`                              | _(empty = auto)_                                  | The language you speak, e.g. `fr`. Setting it avoids misdetections on short sentences                                                       |
| `TTS_VOICE`                                 | `fr-siwis`                                        | `fr-siwis`, `fr-jessica` (female), `fr-pierre`, `fr-tom` (male), `en-amy`                                                                   |
| `TTS_SPEED`                                 | `1`                                               | `0.5`–`2`                                                                                                                                   |
| `VOICE_THREADS`                             | `4`                                               | CPU threads per voice engine                                                                                                                |
| `IMAGES_ENABLED`                            | `true`                                            | Shows the 📷 button (it explains why if ComfyUI isn't ready)                                                                                |
| `COMFYUI_DIR`                               | _(empty)_                                         | ComfyUI install folder, so `start.bat` can start it. Only used by the launcher                                                              |
| `COMFYUI_URL`                               | `http://127.0.0.1:8188`                           |                                                                                                                                             |
| `IMAGE_CHECKPOINT`                          | _(empty = no photos)_                             | SDXL checkpoint file name, as listed by ComfyUI                                                                                             |
| `IMAGE_WIDTH` / `IMAGE_HEIGHT`              | `832` / `1216`                                    | Multiples of 8. SDXL works best around 1 megapixel                                                                                          |
| `IMAGE_STEPS` / `IMAGE_CFG`                 | `25` / `5.5`                                      | See [Getting better photos](#getting-better-photos) for per-checkpoint values                                                               |
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

Invalid values stop the app at startup with an explicit message.

Most of these (name, language, model and sampling, voice, image parameters) can also be changed from the **Settings**
panel. Values saved there are stored in the database and take precedence over `.env` until you click "Restore .env
values". Ports, folders, context size and providers stay in `.env` (they need a restart).

---

## Scripts

| Command                           | Description                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start.bat`                       | One-click launcher: Ollama + ComfyUI + girllm + browser (Windows)                                                                                                                                                                                                                                          |
| `npm run launch`                  | Same launcher, any OS (`-- --no-browser` to skip the browser)                                                                                                                                                                                                                                              |
| `npm run dev`                     | Start with hot reload (tsx)                                                                                                                                                                                                                                                                                |
| `npm run setup:voice`             | Download the voice models chosen in `.env`. `-- --list` shows all of them, `-- fr-tom whisper-small` installs specific ones                                                                                                                                                                                |
| `npm run setup:images`            | Install IP-Adapter (consistent face) into `COMFYUI_DIR`: nodes at a pinned commit, models checked by SHA-256 (needs git), and the face detector. `-- --anime` adds Animagine XL 4.0, `-- --juggernaut` Juggernaut XI, `-- --flux2-klein` FLUX.2 [klein] 4B (bench), `-- --flux2-klein-base` its base model |
| `npm run compare:images`          | Image test bench: the same test shots through several models, contact sheet in `data/compare-images/` (ComfyUI must be running). See [Comparing image models](#comparing-image-models)                                                                                                                     |
| `npm run build` / `npm start`     | Compile to `dist/` and run                                                                                                                                                                                                                                                                                 |
| `npm run typecheck`               | TypeScript strict check                                                                                                                                                                                                                                                                                    |
| `npm test`                        | Unit + HTTP tests (Vitest), no GPU needed                                                                                                                                                                                                                                                                  |
| `npm run lint` / `lint:fix`       | ESLint (type-aware `typescript-eslint` strict rules)                                                                                                                                                                                                                                                       |
| `npm run format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                                   |
| `npm run check`                   | Everything CI runs: format check, lint, types, tests                                                                                                                                                                                                                                                       |

**CI**: GitHub Actions (`.github/workflows/ci.yml`) runs formatting, lint, type check, tests and build on Node 22 and 24
for every push and pull request. No GPU or model is needed: the LLM, ComfyUI and voice engines are mocked in the tests.

---

## Security

- Listens on `127.0.0.1` only by default. Exposing it on your LAN prints a warning. For phone access, prefer **Tailscale**
  over opening a port.
- **Host allow-list**: requests whose `Host` header isn't the app's own address are rejected (`421`), which blocks
  DNS-rebinding attacks from malicious websites.
- **Origin check**: cross-site requests from other websites are rejected (`403`).
- Strict **CSP** (`default-src 'self'`, no inline scripts). Model output is rendered with `textContent`, never as HTML.
- Inputs validated with zod. Body limit 64 KB for JSON, messages ≤ 8000 characters, audio ≤ 4 MB, card files
  ≤ 20 MB, face images ≤ 10 MB.
- **Uploaded faces** need an explicit consent confirmation (the API refuses an upload without it: `428`), must be a
  real PNG or JPEG (checked from the bytes, not the file name) between 64 and 4096 px, and are re-written keeping
  only the image data: EXIF (GPS, camera), text and comments are dropped. Files are named after the character id,
  never after the uploaded name.
- **Characters must be adults**: creating, editing or importing a card that states an age under 18, or whose
  appearance describes a minor, is refused (`422`).
- Card files are written atomically (temporary file + rename) and validated by re-reading them before they replace
  anything.
- The UI font (Bricolage Grotesque, SIL OFL) is served from the installed npm package: no CDN, the app works offline.
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

### Hands-free call

```
mic ─► AudioWorklet (raw samples) ─► downsampled to 16 kHz ─► voice activity detection (vad.js)
    ─► you stop talking for ~0.9 s ─► the utterance goes to /api/stt ─► sent as a message
    ─► her reply is spoken sentence by sentence ─► when she's done, listening resumes
```

- The detector compares each 30 ms frame with an **adaptive estimate of the background noise**, with a higher
  threshold to start than to continue, a short pre-roll so the first syllable isn't clipped, and a 30 s cap.
- Listening is **paused while she thinks and speaks**, so she never answers herself. Use headphones if your speakers
  are loud: the browser's echo cancellation helps but isn't perfect.
- Whisper sometimes "hears" subtitle credits in background noise ("Sous-titres réalisés par…"). Those known phantom
  sentences are dropped on the server and never sent to her.
- Hang up with the button or <kbd>Esc</kbd>. The microphone is released as soon as the call ends.

---

## Photos

```
📷 + optional request   (or: she ends a message with [photo: …], hidden from the chat)
  ─► safety checks (request, card)
  ─► the chat model writes {caption (chat language), scene (English tags)}         normal GPU use
  ─► final prompt = "adult" + IMAGE_STYLE + card appearance + scene  ─► safety check
  ─► her reference face uploaded to ComfyUI (once per face, if IP-Adapter is installed)
  ─► EXCLUSIVE GPU PHASE                          (other LLM calls wait, in every chat)
       unload the Ollama model ─► ComfyUI: FLUX.2 [klein] 8 steps (her face as a reference picture)
                                  or SDXL txt2img (+ IP-Adapter face)
       ─► SDXL only: face detail pass: find the face (CPU) ─► small? redraw it at 1024 px, blend it back
       ─► ComfyUI /free
  ─► PNG saved in data/images, "📷 request" + photo message added to the chat
  ↻ retake: same scene, new seed, the new picture replaces the old one in its message
```

- The "GPU gate" ensures nothing uses the LLM during generation, including background memory tasks and other
  chats. The next message reloads the model automatically (a few seconds).
- The embedding model (~0.6 GB) stays loaded; ComfyUI manages the rest of the VRAM.
- With `LLM_PROVIDER=openai`, the app can't unload the model, so free VRAM yourself or use a smaller model.
- Click a photo to open it full size. Pressing Stop cancels the generation in ComfyUI.
- **Photos she decides to send**: the model is told it may end a message with `[photo: what it shows]` only when
  she is allowed to (frequency setting, or you asked). The tag is removed from the text as it streams, her message
  is shown and spoken right away, and the photo is added to the same bubble when it's ready. If the photo fails or
  is refused, her text stays.
- **Reference face**: IP-Adapter Plus Face (SDXL) with the CLIP-ViT-H image encoder, no insightface needed. If the
  nodes or models are missing, photos are made without the face and the startup log and the editor say why.

### Lorebooks

In the character editor, **Lorebook** → "Add an entry": keywords (comma separated) and what she knows. During the
chat, the last 4 messages are scanned; every entry with a matching keyword (whole word, any case, accents
respected) is added to her notes under `[World info]`, within 15% of the context. "Always included" entries are
always there. Keywords are plain text, never regular expressions. Imported SillyTavern cards keep their lorebook.

---

## Getting better photos

1. **Use a photorealistic checkpoint.** SDXL base is generic. For example **RealVisXL V5.0** (openrail++ licence):
   download `RealVisXL_V5.0_fp16.safetensors` (6.94 GB) from
   [huggingface.co/SG161222/RealVisXL_V5.0](https://huggingface.co/SG161222/RealVisXL_V5.0/tree/main) (download
   arrow next to the file), put it in `ComfyUI\models\checkpoints\`, then in `.env`:

   ```
   IMAGE_CHECKPOINT=RealVisXL_V5.0_fp16.safetensors
   IMAGE_SAMPLER=dpmpp_sde
   IMAGE_SCHEDULER=karras
   IMAGE_STEPS=30
   IMAGE_CFG=4
   ```

   (The model page recommends DPM++ SDE Karras with 30+ steps. CFG 3–5 avoids the "over-cooked" look.)

2. **Keep the hires pass on** (`IMAGE_HIRES_SCALE=1.25`, the default). It's what sharpens eyes and skin. On 8 GB,
   don't go above `1.5`.
3. **Write a precise `appearance`** in the card: hair (length, colour, texture), eyes, skin, build, distinctive
   details (freckles, glasses…). A _descriptive_ age ("in her mid-twenties") gives more natural results than a
   number.
4. **Describe the photo you want**: "mirror selfie in the elevator, gym clothes" beats "a photo". Without a
   request, she picks something that fits the time of day and the conversation.

5. **Leave the face detail pass on** (Settings → "Face detail pass", 0.35). If her face changes too much between
   the photo and the redraw, lower it to 0.25; if eyes are still odd, try 0.45.
6. **Full bodies**: ask for "full body" (or "head to toe") and the photo is drawn in a taller frame. If bodies still
   look wrong with RealVisXL, try Juggernaut XI and compare (below).

### Comparing image models

```powershell
npm run setup:images -- --flux2-klein  # once: FLUX.2 [klein] 4B
npm run compare:images -- --character magi                     # Klein columns, 10 shots, 4 fixed seeds
npm run compare:images -- --character magi --shots desk,cup,sofa --seeds 2
npm run compare:images -- --seed-list 84370200426139,108282413766794
npm run compare:images -- --models flux2-klein-4b-8steps,RealVisXL_V5.0_fp16.safetensors
npm run compare:images -- --style anime
```

- ComfyUI must be running. Ollama's model is unloaded first: don't chat during the run.
- Realistic characters: once FLUX.2 [klein] is installed, only its columns are compared (it replaced the SDXL photo
  models). Without it: your SDXL model and the other known SDXL models installed. Anime: your model and Animagine.
- **Always the same seeds** (4 by default, `--seeds 1` to `8`, or your own with `--seed-list`): two runs draw the
  same pictures, so a change is judged on identical cases. Hands vary a lot from one seed to another.
- Every model gets the same shots and seeds, its recommended settings (yours for the model currently selected),
  and the app's real pipeline (adult safety terms, face detail pass for SDXL, full-body framing).
- `--character <id>` uses her appearance, gender, style and reference face. Without it, a neutral adult subject.
- `--shots` takes ids among `portrait, selfie, mirror, desk, cup, standing, sofa, outdoor, night, back`.
- **FLUX.2 [klein] 4B** is three files (the model in fp8, the Qwen3 4B text encoder and the FLUX.2 VAE, in ComfyUI's
  `diffusion_models`, `text_encoders` and `vae` folders). Its columns, by id for `--models`:

  | Id                           | What                                                                           | Default |
  | ---------------------------- | ------------------------------------------------------------------------------ | ------- |
  | `flux2-klein-4b-8steps`      | Distilled model, 8 steps, CFG 1, ~14 s: same picture as 4 steps, cleaner       | yes     |
  | `flux2-klein-4b-8steps-pose` | Same + a pose guide (see below), for the shots that have one                   | yes     |
  | `flux2-klein-4b`             | Distilled model, 4 steps (official setting), ~12 s                             | no      |
  | `flux2-klein-4b-base`        | Undistilled model, 20 steps, CFG 5, real negative prompt: too saturated, ~70 s | no      |
  | `flux2-klein-4b-noref`       | Distilled model without her face, to see what the reference does               | no      |

  **Pose guides** (experimental): `data/poses/<shot id>.png` is a picture of that shot whose body and hands are right,
  chosen on an earlier sheet (for example `cup.png`, `desk.png`, `mirror.png`, `standing.png`, `sofa.png`). With
  `--character`, the `-pose` column gives it to Klein as a second reference picture ("image 2", after her face),
  with the instruction to copy only the pose and the way her hands hold things, not the face, hair, clothes or
  background. Shots without a guide are drawn without one. Words don't fix anatomy: a "correct hands" sentence, an
  "edit the hands" second pass and a 1.5× refine pass were tried and removed (no visible change).

  Its prompt is written in sentences (scene first) with its own photo style: the SDXL tag list and "smartphone photo" style made it draw a phone in most pictures.
  Her face is given as a reference picture, cropped to the face so that it doesn't copy the clothes and framing of
  her portrait. The distilled model **ignores negative prompts** (the adult terms of the prompt and the text safety
  check still apply); the base model uses one: bad hands, extra fingers or limbs, and the youth terms. No face detail
  pass for FLUX.2. ComfyUI's guide lists ~8.4 GB of VRAM for it: on an 8 GB card part of it is kept in RAM. If the
  bench says ComfyUI is too old, update ComfyUI (the portable build has `update\update_comfyui.bat`).

- Open `data/compare-images/<date>/index.html`: one row per shot, one column per model, timing, and "before the face
  pass" to see what the detail pass changed. `results.json` holds the same data.

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
4. ✅ **Photos on demand**: ComfyUI SDXL, with GPU handover between the LLM and the image model
   - 4a ✅ Lint, formatting, CI, one-click launcher
   - 4b ✅ More human text (styles, time awareness, anti-repetition, model comparison) and better photos
   - 4c ✅ Settings in the app, character editor with a reference face, hands-free call, new interface
   - 4d ✅ She writes first, sends photos on her own, keeps the same face (IP-Adapter), has her own voice, and
     lorebooks
5. ✅ **Art styles and backgrounds**: realistic or anime characters (Animagine XL 4.0), women and men, her picture
   behind the chat (generated scene, latest photo, or face)
6. ✅ **Better photos**: face detail pass, more natural full bodies, Juggernaut XI, recommended settings per model,
   and an image test bench to compare models
   - 6b ✅ FLUX.2 [klein] 4B: compared on the test bench, then the realistic photo model of the app, with a stricter
     safety check and a "retake" button on photos

Ideas for later: a LoRA for an even more consistent face (especially for anime characters), voice cloning (option B: a Python XTTS service),
interrupting her by talking during a call, and phone access through Tailscale.

Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
