# girllm

![node](https://img.shields.io/badge/Node-22%20%7C%2024-339933) ![ts](https://img.shields.io/badge/TypeScript-strict-3178c6)
![flutter](https://img.shields.io/badge/Flutter-Android-02569B)

A **local, private AI companion and roleplay chat** that runs entirely on your own PC.

## Purpose

Companion and roleplay chat apps usually run in the cloud: your conversations, photos and voice go to someone
else's servers. girllm does the same job **on your own machine**:

- the chat model runs on your GPU through [Ollama](https://ollama.com) (or any OpenAI-compatible server);
- her photos and her voice are generated locally by [ComfyUI](https://github.com/comfyanonymous/ComfyUI);
- your speech is transcribed locally by Whisper;
- everything is stored in a local database, and the app only listens on `127.0.0.1`;
- the optional phone app talks only to your PC, over your own Wi-Fi.

Nothing leaves your PC, nothing needs an account, and it works offline once installed. It targets a single
mid-range GPU (tested on an RTX 5060 with 8 GB of VRAM). Characters are adults only, and that rule is enforced in
code.

## What it does

- **Characters** with their own personality, writing style (text messages or roleplay) and look. Cards from
  SillyTavern / chub.ai work as they are; an in-app editor creates and edits them.
- **A chat that feels alive**: replies stream as she writes, she knows the time of day, avoids repeating herself,
  writes first after a silence, and remembers you across chats (summary, long-term memories, mood).
- **Photos of herself**, with the same face every time (FLUX.2 [klein] or SDXL for realistic characters, Animagine
  for anime ones), sent when you ask or on her own, and her picture behind the chat.
- **Her own voice**, designed from a description or recorded from a real voice (with consent), for 🔊 on any
  message, replies read aloud, and hands-free calls. Talk to her with the microphone.
- **A phone app** (Android) for the chat, photos, voice and editor, paired with a QR code and limited to your
  local network.
- **Settings in the app**, a one-click launcher, a model comparison tool and an image test bench.

## Requirements

| What                                  | Notes                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows, an NVIDIA GPU                | 8 GB of VRAM (tested: RTX 5060). Windows is the tested platform; elsewhere, `npm run launch` replaces `start.bat` |
| [Node.js](https://nodejs.org) ≥ 22.13 | For the built-in `node:sqlite` module                                                                             |
| [Ollama](https://ollama.com), recent  | Old builds don't support the RTX 50 series and silently run on the CPU                                            |
| Optional: ComfyUI portable            | For photos and her voice                                                                                          |
| Optional: Flutter                     | To build the phone app                                                                                            |

## Setup

**1. Ollama and a chat model.** Install Ollama, set the user environment variables `OLLAMA_FLASH_ATTENTION=1` and
`OLLAMA_KV_CACHE_TYPE=q8_0`, restart Ollama, then:

```powershell
ollama pull mistral-nemo:12b-instruct-2407-q4_K_M
ollama pull paraphrase-multilingual        # memory search
```

**2. girllm.**

```powershell
git clone https://github.com/Echalaye/girllm.git
cd girllm
npm install
copy .env.example .env                     # then set USER_NAME, REPLY_LANGUAGE, LLM_MODEL…
```

**3. Optional extras**, each documented step by step:

- **Photos**: install ComfyUI portable, set `COMFYUI_DIR` and `IMAGE_CHECKPOINT` in `.env`, then
  `npm run setup:images -- --flux2-klein` ([Installation → Photos](docs/installation.md#3-optional-photos-comfyui)).
- **Voice**: `npm run setup:voice` ([Installation → Voice](docs/installation.md#4-optional-voice)).
- **Phone app**: `LAN_ENABLED=true`, build with Flutter, pair with a QR code ([Phone app](docs/mobile-app.md)).

The full guide, with every option: [docs/installation.md](docs/installation.md). All `.env` values:
[docs/configuration.md](docs/configuration.md).

## Run

**Double-click `start.bat`.** It starts Ollama and ComfyUI if they aren't running, rebuilds girllm if
the code changed, starts it and opens **http://127.0.0.1:3210**. `Ctrl+C` in its window stops what it started.

Other ways:

```powershell
npm run dev        # development, with hot reload
npm run build      # or: compile once…
npm start          # …and run
npm run launch     # the launcher on any OS (-- --no-browser to skip the browser)
```

Then pick a character in the sidebar (or create one with **New character**) and say hello. ⚙ **Settings** (bottom
left) changes your name, the language, the model, photo and voice options without a restart.

## Documentation

| Guide                                      | What's inside                                                       |
| ------------------------------------------ | ------------------------------------------------------------------- |
| [Installation](docs/installation.md)       | Every setup step, the launcher, checking the GPU                    |
| [Configuration](docs/configuration.md)     | All `.env` variables and the Settings panel                         |
| [Choosing a chat model](docs/models.md)    | Models for 8 GB of VRAM and how to compare them                     |
| [Characters](docs/characters.md)           | Editor, card files and fields, reference face, languages, lorebooks |
| [Chat and memory](docs/chat-and-memory.md) | How she writes, writes first, and remembers                         |
| [Photos](docs/photos.md)                   | Photos, image models, background, better photos, image test bench   |
| [Voice](docs/voice.md)                     | Speech to text, her voice, hands-free calls                         |
| [Phone app](docs/mobile-app.md)            | The Android app: build, install, pair, privacy, how it works        |
| [Security and privacy](docs/security.md)   | What protects your data and the adult-only rules                    |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and fixes                                           |
| [Architecture](docs/ARCHITECTURE.md)       | Internals: modules, flows, database, API                            |
| [Development](docs/development.md)         | Layout, scripts, checks, CI, conventions                            |
| [Roadmap](docs/roadmap.md)                 | Steps 1–8 and ideas for later                                       |

## Development

```powershell
npm run check      # formatting, lint, type check and tests: what CI runs (plus the build)
```

The tests need no GPU and no model. CI runs on Node 22 and 24 for every push. See
[docs/development.md](docs/development.md).
