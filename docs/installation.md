# Installation

Everything girllm needs, step by step, on Windows (PowerShell). Only steps 1 and 2 are required: photos, voice
and the phone app are optional and can be added at any time.

- [Requirements](#requirements)
- [1. Ollama and a chat model](#1-ollama-and-a-chat-model)
- [2. girllm itself](#2-girllm-itself)
- [3. Optional: photos (ComfyUI)](#3-optional-photos-comfyui)
- [4. Optional: voice](#4-optional-voice)
- [5. Optional: the phone app](#5-optional-the-phone-app)
- [Running it every day](#running-it-every-day)
- [Check the model is really on the GPU](#check-the-model-is-really-on-the-gpu)

## Requirements

| What    | Version        | Notes                                                                                                       |
| ------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js | **≥ 22.13**    | `node -v`. Needed for the built-in `node:sqlite` module (no native build tools needed)                      |
| Ollama  | recent release | **Required for the RTX 5060 (Blackwell)**: old builds lack CUDA 12.8 / `sm_120` and silently run on the CPU |
| GPU     | 8 GB VRAM      | Tested target: RTX 5060 8 GB                                                                                |
| Disk    | ~10–40 GB      | Chat model ~7 GB; photos add 4–25 GB depending on the models; voice ~9 GB                                   |
| git     | any            | Only for `npm run setup:images` / `setup:voice` (they clone ComfyUI nodes at a pinned commit)               |

Optional: ComfyUI portable for photos and her voice, Flutter for building the phone app.

## 1. Ollama and a chat model

Install [Ollama](https://ollama.com), then set these **user environment variables** (Settings → System → About →
Advanced system settings → Environment Variables) and **restart Ollama** (quit it from the tray icon and relaunch):

| Variable                 | Value  | Why                                                           |
| ------------------------ | ------ | ------------------------------------------------------------- |
| `OLLAMA_FLASH_ATTENTION` | `1`    | Less VRAM, faster                                             |
| `OLLAMA_KV_CACHE_TYPE`   | `q8_0` | Halves the context's VRAM cost with a negligible quality loss |

You don't need `OLLAMA_CONTEXT_LENGTH`: with `LLM_PROVIDER=ollama` (the default) the app sends the context size
(`CONTEXT_TOKENS`) with every request.

Pull a chat model and the embedding model used by memory:

```powershell
ollama pull mistral-nemo:12b-instruct-2407-q4_K_M
ollama pull paraphrase-multilingual     # embedding model for memory search (~0.6 GB, French OK)
```

Other chat models worth trying, and how to compare them: [Choosing a chat model](models.md). girllm also works
with any OpenAI-compatible server (llama.cpp, KoboldCpp, LM Studio): see `LLM_PROVIDER` in
[Configuration](configuration.md).

## 2. girllm itself

```powershell
cd C:\Users\etien\Desktop\girllm
npm install
copy .env.example .env      # then edit USER_NAME, REPLY_LANGUAGE, LLM_MODEL…
npm run dev                 # hot reload; or: npm run build ; npm start
```

Open **http://127.0.0.1:3210**. A few characters ship in `characters/`; create your own with **New character**
(see [Characters](characters.md)).

Every `.env` value is described in [Configuration](configuration.md). Most of them can also be changed later from
⚙ **Settings** in the app.

## 3. Optional: photos (ComfyUI)

1. Download the latest **ComfyUI portable for Windows (NVIDIA)** from the ComfyUI GitHub releases and extract it.
   Recent builds ship PyTorch with CUDA 12.8, which the **RTX 5060 (Blackwell) requires**. Older builds won't use
   the GPU.
2. Put an **SDXL checkpoint** (`.safetensors` only) in `ComfyUI\models\checkpoints\`. The official SDXL base 1.0
   works, but a photorealistic fine-tune gives much more natural people: see
   [Getting better photos](photos.md#getting-better-photos).
3. In `.env`, set `COMFYUI_DIR=C:\path\to\ComfyUI_windows_portable` (so `start.bat` can start it) and
   `IMAGE_CHECKPOINT=` to the file name exactly as ComfyUI lists it.
4. **Recommended: the same face in every photo, and the better models.** Run once:

   ```powershell
   npm run setup:images                   # IP-Adapter nodes (pinned commit) + 2 models (~3.4 GB, checksum-verified)
   npm run setup:images -- --flux2-klein  # + FLUX.2 [klein] 4B, the realistic photo model (+12.5 GB, recent ComfyUI)
   npm run setup:images -- --anime        # + Animagine XL 4.0 for anime characters (+6.9 GB)
   npm run setup:images -- --juggernaut   # + Juggernaut XI, a second realistic SDXL model (+7.1 GB)
   npm run setup:images -- --flux2-klein-base # + Klein's undistilled model, for the test bench only (+4.1 GB)
   ```

   Flags can be combined (`-- --flux2-klein --anime`). It also installs the small face detector used by the face
   detail pass (1.6 MB, into `MODELS_DIR`).

5. Start ComfyUI (`run_nvidia_gpu.bat`, or let `start.bat` do it), then restart girllm. The startup log should say
   `Photos: on`, `Reference faces: on (IP-Adapter)` (and `Anime photos: on`). If not, it says why (ComfyUI not
   reachable, checkpoint not found…).
6. Give each character a reference face in the editor (generated or uploaded).

A photo takes ~15 s with FLUX.2 [klein] and 20–40 s with SDXL on an 8 GB card, mostly spent swapping models
between the chat model and the image model. The first one is slower because ComfyUI loads the model from disk.
How photos work: [Photos](photos.md).

## 4. Optional: voice

```powershell
npm run setup:voice        # Whisper (~200 MB, your speech) + Qwen3-TTS in ComfyUI (~9 GB, her voice)
```

- Your speech is transcribed by **Whisper** on the CPU: no ComfyUI needed for that part.
- Her voice is **Qwen3-TTS** inside ComfyUI, so it needs `COMFYUI_DIR` (step 3) and ComfyUI running. Restart
  ComfyUI after the install.
- `npm run setup:voice -- --list` lists the Whisper models, `-- whisper-small` installs a more accurate one,
  `-- --stt-only` skips her voice.

Details, speed and troubleshooting: [Voice](voice.md).

## 5. Optional: the phone app

An Android app that talks to your PC over your own Wi-Fi only. Set `LAN_ENABLED=true`, build the app with Flutter
and pair it with a QR code: the whole procedure is in [Phone app](mobile-app.md).

## Running it 

**Double-click `start.bat`.** It:

1. starts **Ollama** if it isn't running yet;
2. starts **ComfyUI** if photos are configured and `COMFYUI_DIR` is set (its log goes to `data\logs\comfyui.log`);
3. rebuilds girllm if the code changed, starts it, and opens the browser.

`Ctrl+C` in its window stops everything **it** started; services that were already running are left alone.
`start.bat --no-browser` skips opening the browser. On another OS: `npm run launch` (`-- --no-browser`).

## Check the model is really on the GPU

While a reply is being generated, run:

```powershell
ollama ps        # PROCESSOR column must say "100% GPU"
nvidia-smi       # VRAM usage should be ~7 GB
```

If you see a `CPU/GPU` split, the model + context don't fit in 8 GB (Windows itself uses ~0.5 GB). Lower
`CONTEXT_TOKENS` (e.g. 6144), use a smaller quantization (IQ4_XS), or switch to a 7–8B model.
