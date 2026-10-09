# Security and privacy

girllm is built to run on your own PC and keep everything there. This page lists what protects it and what you
should know.

- [Network](#network)
- [Phone listener](#phone-listener)
- [Input validation](#input-validation)
- [Photos and voices of adults only](#photos-and-voices-of-adults-only)
- [Real people: consent](#real-people-consent)
- [Downloads and installs](#downloads-and-installs)
- [Your data](#your-data)
- [Dependencies](#dependencies)

## Network

- The PC page listens on **`127.0.0.1` only** by default and has no login: it is for your own browser on your own
  PC. Setting another `HOST` prints a warning. For your phone, use the [phone listener](#phone-listener) instead of
  changing `HOST`.
- **Host allow-list**: requests whose `Host` header isn't the app's own address are rejected (`421`), which blocks
  DNS-rebinding attacks from malicious websites.
- **Origin check**: cross-site requests from other websites are rejected (`403`).
- Strict **CSP** (`default-src 'self'`, no inline scripts). Model output is rendered with `textContent`, never as
  HTML.
- Nothing is loaded from the internet at runtime: the UI font (Bricolage Grotesque, SIL OFL) is served from the
  installed npm package, no CDN, so the app works offline. The only network traffic is to your LLM backend and
  ComfyUI, both on `127.0.0.1` by default.

## Phone listener

Off by default (`LAN_ENABLED=false`). When on, a second listener on `LAN_PORT` serves the
[phone app](mobile-app.md) only:

- **HTTPS** with a self-signed ECDSA P-256 certificate made on first start (`data/lan/`, private key readable by your
  account only). Phones pin its SHA-256 from the pairing QR code, so another machine on the Wi-Fi can't impersonate
  the PC.
- Answers **private addresses only** (10/8, 172.16/12, 192.168/16, link-local, loopback; not CGNAT/VPN overlays):
  anything else is refused (`403`).
- **Every route needs a phone token** (`Authorization: Bearer`), except pairing. Tokens are 32 random bytes; only
  their SHA-256 is stored (`devices` table), so a copy of the database can't be used to connect. Remove a phone in
  Settings → _Phone app_ and its token stops working at once.
- **Pairing**: a one-time code inside the QR code (120 bits), valid 5 minutes, 5 attempts, one at a time; it is
  only shown on the PC itself. Pairing, phone management and app settings routes exist on `127.0.0.1` only.
- **No browsers**: requests carrying an `Origin` header are refused, so a website opened on a phone can't call it,
  and no web page is served on it.
- Same validation, limits and safety checks as the PC page: the phone uses the same API.
- The Windows firewall rule suggested in [Phone app → Setup](mobile-app.md#1-turn-phone-access-on-on-the-pc) opens
  only that port, only to your local subnet, only on Private networks.

## Input validation

- Every input is validated with zod. Body limit 64 KB for JSON, messages ≤ 8000 characters, audio ≤ 4 MB, card
  files ≤ 20 MB, face images ≤ 10 MB, voice clips ≤ 8 MB, voice descriptions ≤ 500 characters.
- All SQL uses bound parameters.
- Text produced by the model (summary, memories) is inserted in the prompt as clearly delimited data under the
  instructions.
- Card files are written atomically (temporary file + rename) and validated by re-reading them before they replace
  anything. Files are always named after the character id, never after an uploaded file name.
- Generated images are served by id only, with the file path taken from the database and never from the URL.

## Photos and voices of adults only

This rule is enforced in code and can't be configured:

- **Characters must be adults**: creating, editing or importing a card that states an age under 18, or whose
  appearance describes a minor, is refused (`422`).
- **Photos never depict minors**:
  - the photo request, the scene written by the LLM and the final prompt are checked for minor-related terms and
    under-18 ages, in English and French, and the request is refused before anything is generated;
  - a card that states an age under 18 can't receive photos;
  - every prompt starts with `adult`, and child-related terms are always added to the negative prompt;
  - FLUX.2 [klein] has no negative prompt, so its prompts also refuse young-look words ("pigtails", "baby face"…);
  - anime pictures always state an adult (`adult, mature female/male`) with extra youth-related negative tags.

  The check is deliberately strict: an occasional false positive just means rephrasing the request.

- **Her voice is always an adult's**: voice descriptions go through the same minor and young-look checks as photos
  plus child-voice words (EN/FR), designed voices are always described as an adult's, and a card stating an age
  under 18 gets no voice (`422`).

## Real people: consent

- **Uploaded faces** need an explicit confirmation that the picture is AI-generated, of yourself, or of an adult
  who agreed (the API refuses an upload without it: `428`). The file must be a real PNG or JPEG (checked from the
  bytes, not the file name) between 64 and 4096 px, and is re-written keeping only the image data: EXIF (GPS,
  camera), text and comments are dropped.
- **A real person's voice** (recorded or uploaded) needs a confirmation that it is your own voice or that of an
  adult who agreed; the API refuses the clip without that attestation (`428`) and stores when it was given next to
  the clip. Clips are decoded in the browser (or on the phone) and sent as raw PCM (4–30 s of speech after
  trimming), and stored as WAV recognised by its bytes, never by the uploaded file's name.

## Downloads and installs

- `npm run setup:images` and `setup:voice` clone ComfyUI node packs at **pinned, reviewed commits** and download
  model files **checked against a pinned SHA-256** (Whisper archives are checked before extraction).
- **Qwen3-TTS**: its `LoadSpeaker` node, which unpickles files, is never used; model URLs are pinned to a Hugging
  Face commit, the weights also to a SHA-256; an empty `Qwen3-TTS-Tokenizer-12Hz` folder stops the nodes from
  downloading anything unpinned; only missing Python packages are installed, at exact versions (never the pack's
  `requirements.txt`).
- Only download **`.gguf`** / **`.safetensors`** models, never pickle (`.bin`, `.pt`) files from unknown sources.

## Your data

- Conversations, memories, settings and paired phones are stored **unencrypted** in `data/girllm.db`; photos,
  faces, backgrounds and voices in `data/`. The folder is git-ignored and as private as your Windows account:
  don't put it in a synced or shared directory if that matters to you.
- Deleting a chat deletes its photos; deleting a character deletes her chats, photos, memories, face, background
  and voice.
- The phone keeps only its connection (in the Android Keystore, excluded from backups) and an in-memory picture
  cache.

## Dependencies

`npm audit` should report 0 vulnerabilities; CI runs on Node 22 and 24 for every push. When an advisory appears,
update the package (`npm install <package>@<fixed version>`) and run `npm run check` before committing.
