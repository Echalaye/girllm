# Roadmap

girllm was built in steps; each one is complete and tested. The guides describe the current behaviour; this page is
the history.

1. ✅ **Streaming chat + character persona**
2. ✅ **Memory**: SQLite persistence, running summary, long-term memories with semantic search, mood
3. ✅ **Voice**: Whisper speech-to-text and Piper French voices, on the CPU via sherpa-onnx (Piper replaced in step 7)
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
   - 6c ✅ FLUX.2 face pass: her small face redrawn from her profile picture in wide and full-body photos
7. ✅ **Her own voice**: Qwen3-TTS 1.7B in ComfyUI, a voice designed from a description in the editor and cloned for
   every message, 🔊 on each message, used by "Voice on" and calls
   - 7b ✅ Her voice from a real recording (your own, or a consenting adult's): microphone or file, with consent
8. ✅ **On your phone**: an Android app (Flutter) for the chat, photos, voice and editor, paired by QR code and limited
   to your local network (pinned HTTPS certificate, revocable token per phone)

## Changes worth knowing

- **Step 7 replaced the Piper voices of step 3** with Qwen3-TTS (her voice, on the GPU in ComfyUI). Their settings
  (`TTS_VOICE`, `TTS_SPEED`) are ignored, and the card field `voice` is dropped when a card is saved. Your speech is
  still transcribed by Whisper on the CPU.
- **Voice on and calls** speak her whole reply once it is written (no longer sentence by sentence): each GPU swap
  costs a few seconds.
- **FLUX.2 [klein] 4B** became the realistic photo model in step 6b; SDXL is used until it is installed, and anime
  characters stay on Animagine XL 4.0.
- **Step 8** added the phone listener (`LAN_ENABLED`, off by default) and the `devices` table (migration 5).

## Ideas for later

- A LoRA for an even more consistent face (especially for anime characters).
- Emotions in her voice (Qwen3-TTS takes an instruction like "whispering" or "laughing").
- Interrupting her by talking during a call.
