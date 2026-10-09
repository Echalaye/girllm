# Voice

Two separate engines, both on your PC:

- **Your speech → text**: Whisper (sherpa-onnx) on the **CPU**. No audio ever leaves your PC.
- **Her voice**: Qwen3-TTS 1.7B inside ComfyUI, on the **GPU**, with a voice made for each character.

Install both with `npm run setup:voice` ([Installation → Voice](installation.md#4-optional-voice)).

## In the chat

- **🎤 Talk instead of typing**: click 🎤, speak, click again. Your voice is transcribed and sent as a message.
  Talking (or pressing Stop) interrupts her, like a real conversation.
- **🔊 on each of her messages**: click to hear it, click again to stop her. Her voice is made on the GPU like her
  photos (the chat model is unloaded for a few seconds, then reloads for the next reply), so a message takes a while
  to prepare the first time (~10–30 s); replaying it is instant (spoken messages are kept in `data/speech-cache/`,
  the newest 300).
- **Voice on**: she reads every reply aloud once it is written. Stage directions like `*smiles*` and emojis are not
  read.
- **Hands-free call** (phone icon): talk naturally, she hears when you stop, answers out loud, then listens again
  ([below](#hands-free-call)). Expect a pause before she answers: each reply is a GPU swap.
- **Languages**: French and 9 others (English, German, Spanish, Italian, Portuguese, Russian, Japanese, Korean,
  Chinese), following the reply language in the settings. Set `STT_LANGUAGE=fr` (the language _you_ speak) to avoid
  misdetections on short sentences.

## Her voice in the editor

- **A voice made for her.** In the character editor ("Her voice"), describe how she sounds ("woman in her late
  twenties, warm and slightly husky, calm, a little playful") and click **Create her voice**: Qwen3-TTS makes a short
  sample. Listen, keep it, or create another one (the last 3 stay on screen to compare). That sample becomes her
  reference, and **every message she speaks is said with that exact voice** (voice cloning), so she always sounds
  like the same person. Closing the editor with a voice you didn't keep asks whether to keep the latest.
- **Or a real voice**: **Record a voice** (you read a short text aloud, 10–30 s) or **Use a recording** (WAV, MP3,
  M4A, OGG… of 4–30 s of clear speech). It must be **your own voice, or that of an adult who agreed** to it being
  used: the editor asks you to confirm first, and the server refuses a clip sent without that confirmation. The
  clip is trimmed, its level evened out, and Whisper writes down what it says (the cloning model needs the words);
  it then becomes the character's voice right away.
- A character without a voice gets one automatically the first time she speaks, from her description or a natural
  default for her gender.
- **Adult voices only**: a description asking for a child's voice is refused, every designed voice is described as
  an adult's, and a card stating an age under 18 gets no voice.
- Voices stay on your PC (`data/voices/`). The section says "His voice" for a male character.

The [phone app](mobile-app.md) can do all of this too (recording uses the phone's microphone).

## Hands-free call

Click the phone icon and talk naturally. It needs both engines (`npm run setup:voice`) and ComfyUI running.

```
mic ─► AudioWorklet (raw samples) ─► downsampled to 16 kHz ─► voice activity detection (vad.js)
    ─► you stop talking for ~0.9 s ─► the utterance goes to /api/stt ─► sent as a message
    ─► her whole reply is spoken with her voice (GPU, a few seconds) ─► when she's done, listening resumes
```

- The detector compares each 30 ms frame with an **adaptive estimate of the background noise**, with a higher
  threshold to start than to continue, a short pre-roll so the first syllable isn't clipped, and a 30 s cap.
- Listening is **paused while she thinks and speaks**, so she never answers herself. Use headphones if your speakers
  are loud: the browser's echo cancellation helps but isn't perfect.
- Whisper sometimes "hears" subtitle credits in background noise ("Sous-titres réalisés par…"). Those known phantom
  sentences are dropped on the server and never sent to her.
- Hang up with the button or <kbd>Esc</kbd>. The microphone is released as soon as the call ends.

## How it works

```
🎤 mic ─► browser records (webm/opus) ─► decodes + resamples to 16 kHz mono ─► POST /api/stt
        ─► Whisper (sherpa-onnx, CPU) ─► text ─► sent as a normal message

🔊 / Voice on / call ─► her whole message ─► POST /api/tts {text, characterId}
        ─► *actions* / emojis removed, cut at a sentence end after 1500 characters ─► already spoken? cached FLAC
        ─► her voice clip (data/voices/<id>.flac; made from her description the first time)
        ─► EXCLUSIVE GPU PHASE: unload the chat model ─► ComfyUI: Qwen3-TTS voice clone (her clip + its words)
           ─► FLAC ─► ComfyUI /free ─► cached in data/speech-cache ─► played

editor "Create her voice" ─► description (adult checks) ─► same GPU phase: Qwen3-TTS VoiceDesign says a sample
        sentence in the chat language ─► candidate ─► "Keep this voice" ─► her clip
```

## Setup

- **What it installs**: `npm run setup:voice` installs Whisper from the official sherpa-onnx GitHub releases (each archive
  checked against a pinned SHA-256 before extraction) and, when `COMFYUI_DIR` is set, Qwen3-TTS into ComfyUI:
  the [ComfyUI-Qwen-TTS](https://github.com/flybirdxx/ComfyUI-Qwen-TTS) nodes (Apache 2.0) at a pinned commit, the
  1.7B voice-clone and voice-design models (~9 GB, Apache 2.0), and the few Python packages ComfyUI lacks
  (`librosa`, `soundfile`, `einops`, `sox`, `onnxruntime`, `accelerate`, at exact versions; only the missing ones).
  Restart ComfyUI afterwards. A manual (non-portable) ComfyUI gets the pip command printed instead.
- **Speed** (estimate for an RTX 5060 8 GB, to be confirmed): the model loads in a few seconds, then generates at
  roughly real time, so a 10 s message should take ~10–25 s the first time, and nothing when replayed. Your chat
  model reloads by itself for the next reply.
  Transcription stays on the CPU and takes well under the length of what you said with `whisper-base`.

## Troubleshooting

- **ComfyUI stops at startup with `UnicodeEncodeError … '\u2705'`**: its output was written in the Windows code
  page and the Qwen3-TTS nodes print an emoji. `start.bat` runs ComfyUI with UTF-8 output since step 7; if you start
  ComfyUI yourself into a file, set `PYTHONIOENCODING=utf-8` first. The "SoX could not be found!" warning at startup
  is harmless (that part of the nodes is not used).
- **Her voice is unavailable** (no 🔊): ComfyUI isn't running yet (the page checks again every 30 s), or the nodes
  aren't installed (`npm run setup:voice`, then restart ComfyUI). The reason is in the girllm log at startup.
- **Accuracy**: `whisper-base` is good for everyday French but can stumble on names. Try `STT_MODEL=whisper-small`
  if it misunderstands you too often (then run `npm run setup:voice` again).
- **Microphone access** requires a "secure context": `http://127.0.0.1:3210` and `http://localhost:3210` work. A LAN
  or Tailscale IP over plain HTTP doesn't: the mic button is greyed out there.
- Speech recognition handles one request at a time; voice generations wait for the GPU like photos, one at a time.
