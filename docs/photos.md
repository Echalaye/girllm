# Photos

She sends photos of herself, drawn on your GPU by **ComfyUI**, with the same face every time. Nothing is sent to
an online service. Installation: [Installation → Photos](installation.md#3-optional-photos-comfyui).

- [What she can do](#what-she-can-do)
- [Her picture behind the chat](#her-picture-behind-the-chat)
- [Image models](#image-models)
- [How a photo is made](#how-a-photo-is-made)
- [Getting better photos](#getting-better-photos)
- [Comparing image models](#comparing-image-models)

## What she can do

- **📷 Ask for a photo**: type what you'd like ("a selfie at the climbing gym") and click 📷, or leave the box empty
  and she picks something that fits the moment. She sends it with a caption, in the chat language.
- **She sends photos on her own** when it fits the moment: the photo appears in the same bubble as her message.
  If you ask for one in a message ("envoie-moi une photo"), she can send one right away, or say no in character.
  Frequency: `PHOTO_FREQUENCY` = `off`, `rare` (default) or `often`.
- **The same face in every photo**: the reference face chosen in the editor is applied to every photo.
- **She remembers what she sent**: the next replies know what the photo showed.
- **↻ Retake**: draws the same scene again with a new picture and replaces it in the chat (the old one is deleted).
  Handy when a hand or a detail came out wrong.
- Click a photo to open it full size. Pressing **Stop** cancels the generation in ComfyUI.
- **Adults only, enforced in code**: requests, generated prompts and cards are checked, and anything suggesting a
  minor is refused before it reaches the image model (see [Security](security.md#photos-and-voices-of-adults-only)).

## Her picture behind the chat

Softly blurred and dimmed so the text stays readable. The look is a setting (⚙ Settings → Display, or
`CHAT_BACKGROUND`): **subtle** (blurred), **clear** or **off**. What is shown is chosen per character, in the editor:

- **Her scene** (default): "Generate 2 scenes" makes a wide picture of her in her usual place, from her card, with
  her reference face; pick the one you like. To choose the scene yourself, write it in "Her scene, in your words"
  (the place, what she does, her outfit, the light): it is drawn as written, as a wide shot.
- **Her latest photo**: the background follows the last photo she sent in this chat.
- Without a scene or a photo, her face is used.

The [phone app](mobile-app.md) follows the same rules.

## Image models

| Characters | Model                                                 | Install                                 |
| ---------- | ----------------------------------------------------- | --------------------------------------- |
| Realistic  | **FLUX.2 [klein] 4B** (default once installed), ~15 s | `npm run setup:images -- --flux2-klein` |
| Realistic  | Your SDXL checkpoint (`IMAGE_CHECKPOINT`), until then | Put it in `ComfyUI\models\checkpoints\` |
| Realistic  | Juggernaut XI, a second SDXL model (CC BY-NC-ND 4.0)  | `npm run setup:images -- --juggernaut`  |
| Anime      | **Animagine XL 4.0**                                  | `npm run setup:images -- --anime`       |

- **FLUX.2 [klein] 4B** won every comparison on bodies, hands and framing, and is about 5× faster than the SDXL
  models. Her face goes in as a reference picture (cropped to the face), and the chat model writes Klein a precise
  scene in 4–6 sentences (the shot, what she does, her outfit, a place from her life with concrete objects, the
  light): Klein invents whatever is missing. Choose it in ⚙ Settings → Photos → "Photo model" (`REALISTIC_ENGINE`).
  It has no negative prompt, so its prompts go through a **stricter safety check** (young-look words like
  "pigtails" or "baby face" are refused on top of the usual rules).
- **SDXL** models get her face through **IP-Adapter Plus Face** (`IMAGE_FACE_WEIGHT`, 0.7 by default). Picking
  RealVisXL, Juggernaut or Animagine in Settings fills in its recommended sampler, scheduler, steps and CFG (click
  Save to apply).
- **Anime** prompts are written the way Animagine expects (Danbooru tags, quality tags last), always state an adult
  (`adult, mature female/male`) and carry extra youth-related negative tags: anime models tend to draw characters
  young-looking. Going from a realistic character to an anime one makes ComfyUI load the other model: the first
  picture after the switch takes 10–20 s longer.
- **Face detail pass** (like "ADetailer"): in a waist-up or full-body photo her face is only ~100–200 px tall, too
  small for her features. girllm finds the face (a 1.6 MB detector on the CPU, ~0.1 s), redraws that square at
  1024 px and blends it back with soft edges. With FLUX.2 it is redrawn from her profile picture, so it is _her_
  face; with SDXL, with the same prompt, seed and reference face. Close-ups are left alone. Strength: ⚙ Settings →
  "Face detail pass" (0.35 realistic, 0.3 anime, 0 = off).
- **Full bodies** are drawn in a taller frame (768×1344 instead of 832×1216, same speed), with natural body
  proportions in the prompt.

## How a photo is made

```
📷 + optional request   (or: she ends a message with [photo: …], hidden from the chat)
  ─► safety checks (request, card)
  ─► the chat model writes {caption (chat language), scene (English tags)}         normal GPU use
  ─► final prompt = "adult" + IMAGE_STYLE + card appearance + scene  ─► safety check
  ─► her reference face uploaded to ComfyUI (once per face, if IP-Adapter is installed)
  ─► EXCLUSIVE GPU PHASE                          (other LLM calls wait, in every chat)
       unload the Ollama model ─► ComfyUI: FLUX.2 [klein] 8 steps (her face as a reference picture)
                                  or SDXL txt2img (+ IP-Adapter face)
       ─► face detail pass: find the face (CPU) ─► small? redraw it at 1024 px, blend it back
          (FLUX.2: from her profile picture, so it is HER face; SDXL: same prompt + IP-Adapter)
       ─► ComfyUI /free
  ─► PNG saved in data/images, "📷 request" + photo message added to the chat
  ↻ retake: same scene, new seed, the new picture replaces the old one in its message
```

- The "GPU gate" ensures nothing uses the LLM during generation, including background memory tasks and other
  chats. The next message reloads the model automatically (a few seconds).
- The embedding model (~0.6 GB) stays loaded; ComfyUI manages the rest of the VRAM.
- With `LLM_PROVIDER=openai`, the app can't unload the model, so free VRAM yourself or use a smaller model.
- **Photos she decides to send**: the model is told it may end a message with `[photo: what it shows]` only when
  she is allowed to (frequency setting, or you asked). The tag is removed from the text as it streams, her message
  is shown and spoken right away, and the photo is added to the same bubble when it's ready. If the photo fails or
  is refused, her text stays.
- **Reference face**: IP-Adapter Plus Face (SDXL) with the CLIP-ViT-H image encoder, no insightface needed. If the
  nodes or models are missing, photos are made without the face and the startup log and the editor say why.

## Getting better photos

For realistic characters, installing FLUX.2 [klein] (`npm run setup:images -- --flux2-klein`) is the biggest
improvement. Points 1 and 2 are for the SDXL models; the others apply to every model.

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

## Comparing image models

`npm run compare:images` draws 10 test shots (portrait, selfie, mirror, desk, cup, standing, sofa, outdoors, night,
from behind) with the same seeds through each installed model, through the app's real pipeline, and writes a
contact sheet to compare them side by side.

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
  check still apply); the base model uses one: bad hands, extra fingers or limbs, and the youth terms. Klein columns
  with her face get the app's FLUX.2 face pass ("face redrawn", with the "before" picture). ComfyUI's guide lists ~8.4 GB of VRAM for it: on an 8 GB card part of it is kept in RAM. If the
  bench says ComfyUI is too old, update ComfyUI (the portable build has `update\update_comfyui.bat`).

- Open `data/compare-images/<date>/index.html`: one row per shot, one column per model, timing, and "before the face
  pass" to see what the detail pass changed. `results.json` holds the same data.
