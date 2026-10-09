# Troubleshooting

The girllm window (or `npm run dev`) logs what is on or off at startup, and why: start there.

## Chat

| Problem                                                  | Fix                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The app stops at startup with a configuration error      | A `.env` value is invalid: the message names it. See [Configuration](configuration.md).                                                                                                    |
| Replies are slow                                         | Check the model is fully on the GPU: [Installation → check](installation.md#check-the-model-is-really-on-the-gpu). Lower `CONTEXT_TOKENS`, use an IQ4_XS model, or set `EMBEDDING_MODEL=`. |
| A message waits a few seconds before she answers         | Normal right after a reply: memory tasks run in the background with the same model, or the model is reloading after a photo or a voice.                                                    |
| She answers in the wrong language                        | Set `REPLY_LANGUAGE` (or ⚙ Settings), and prefer a card written in that language: [Characters](characters.md#chatting-in-french-or-another-language).                                      |
| She writes your lines, repeats herself, or rambles       | Try another model with `npm run compare` ([Choosing a chat model](models.md)); lower `TEMPERATURE` to 0.6.                                                                                 |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless: `node:sqlite` is built into Node and stable enough for this use (the npm scripts hide it).                                                                                       |

## Photos

| Problem                                       | Fix                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 📷 button explains photos are unavailable | ComfyUI isn't running, or `IMAGE_CHECKPOINT` doesn't match a file ComfyUI lists. The startup log says which.                                          |
| ComfyUI runs on the CPU / is very slow        | Use a recent ComfyUI portable (PyTorch with CUDA 12.8): older builds don't support the RTX 5060.                                                      |
| Her face changes between photos               | Give her a reference face in the editor and run `npm run setup:images` once (startup log: `Reference faces: on`).                                     |
| Hands or a detail came out wrong              | ↻ retake the photo. For better models and settings: [Getting better photos](photos.md#getting-better-photos).                                         |
| "FLUX.2 … ComfyUI is too old"                 | Update ComfyUI (the portable build has `update\update_comfyui.bat`).                                                                                  |
| A request is refused as unsafe                | The adult-only check is deliberately strict: rephrase without words that suggest youth. See [Security](security.md#photos-and-voices-of-adults-only). |

## Voice

| Problem                                             | Fix                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No 🔊 on her messages                               | ComfyUI isn't running yet (the page checks again every 30 s), or Qwen3-TTS isn't installed (`npm run setup:voice`, then restart ComfyUI). The reason is in the girllm log at startup.                                                     |
| ComfyUI stops with `UnicodeEncodeError … '✅'`      | Start it with `start.bat` (UTF-8 output), or set `PYTHONIOENCODING=utf-8` before starting it yourself. "SoX could not be found!" at startup is harmless.                                                                                  |
| The 🎤 button is greyed out                         | The browser only allows the microphone on `http://127.0.0.1:3210` or `http://localhost:3210`, not on a LAN address over plain HTTP. On the phone, use the [phone app](mobile-app.md).                                                     |
| It misunderstands what you say                      | Set `STT_LANGUAGE=fr` (your language), or install a more accurate model: `STT_MODEL=whisper-small`, then `npm run setup:voice` again.                                                                                                     |
| Her voice doesn't sound like the recording you made | Make sure the voice was **kept**: the editor then shows a player for her voice instead of "No voice yet" (on the phone: "Current voice"). A voice that was only created stays a candidate. See [Voice](voice.md#her-voice-in-the-editor). |

## Phone app

See [Phone app → Troubleshooting](mobile-app.md#troubleshooting): unreachable PC (firewall, Private network),
expired QR codes, re-pairing, building with Flutter.

## Development

| Problem                                     | Fix                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI fails but `npm run check` passes locally | CI runs on a clean checkout: make sure new files are committed (cards in `characters/` are tested too), and that `package-lock.json` is up to date. |
| `npm audit` reports vulnerabilities         | See [Security → Dependencies](security.md#dependencies).                                                                                            |
