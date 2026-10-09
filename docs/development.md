# Development

girllm is a Node 22 / TypeScript (strict) server with a vanilla-JS page, and a Flutter app for the phone. The
internals (modules, request flow, database schema, API, design decisions) are in [Architecture](ARCHITECTURE.md).

## Project layout

```
src/            the server: HTTP API (Fastify), chat, memory, prompt, images, voice, phone listener (lan/)
public/         the PC page: plain HTML/CSS/JS modules, no build step
scripts/        launcher, setup of photos and voice, model and image comparison tools
tests/          Vitest unit and HTTP tests (no GPU, no model: the LLM, ComfyUI and voice engines are mocked)
characters/     the shipped character cards (also tested)
mobile/         the Android app (Flutter): see Phone app
docs/           this documentation
data/, models/  your data and downloaded models (git-ignored)
```

## Scripts

| Command                           | Description                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start.bat`                       | One-click launcher: Ollama + ComfyUI + girllm + browser (Windows)                                                                                                                                                                                                                                          |
| `npm run launch`                  | Same launcher, any OS (`-- --no-browser` to skip the browser)                                                                                                                                                                                                                                              |
| `npm run dev`                     | Start with hot reload (tsx)                                                                                                                                                                                                                                                                                |
| `npm run setup:voice`             | Whisper (`STT_MODEL`) into `MODELS_DIR`, and her voice into `COMFYUI_DIR`: Qwen3-TTS nodes at a pinned commit, models pinned by commit and SHA-256, missing Python packages at exact versions. `-- --list`, `-- whisper-small`, `-- --stt-only`                                                            |
| `npm run setup:images`            | Install IP-Adapter (consistent face) into `COMFYUI_DIR`: nodes at a pinned commit, models checked by SHA-256 (needs git), and the face detector. `-- --anime` adds Animagine XL 4.0, `-- --juggernaut` Juggernaut XI, `-- --flux2-klein` FLUX.2 [klein] 4B (bench), `-- --flux2-klein-base` its base model |
| `npm run compare:images`          | Image test bench: the same test shots through several models, contact sheet in `data/compare-images/` (ComfyUI must be running). See [Comparing image models](photos.md#comparing-image-models)                                                                                                            |
| `npm run build` / `npm start`     | Compile to `dist/` and run                                                                                                                                                                                                                                                                                 |
| `npm run typecheck`               | TypeScript strict check                                                                                                                                                                                                                                                                                    |
| `npm test`                        | Unit + HTTP tests (Vitest), no GPU needed                                                                                                                                                                                                                                                                  |
| `npm run lint` / `lint:fix`       | ESLint (type-aware `typescript-eslint` strict rules)                                                                                                                                                                                                                                                       |
| `npm run format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                                   |
| `npm run check`                   | Everything CI runs: format check, lint, types, tests                                                                                                                                                                                                                                                       |

Phone app: `flutter analyze`, `flutter test` and `flutter build apk --release` in `mobile/`
([Phone app](mobile-app.md#2-build-the-app)).

## Checks and CI

`npm run check` runs everything CI runs except the build: Prettier, ESLint (type-aware `typescript-eslint` strict
rules), the TypeScript type check and the tests. Run it before every commit.

**CI**: GitHub Actions (`.github/workflows/ci.yml`) runs formatting, lint, type check, tests and build on Node 22
and 24 for every push and pull request, with read-only permissions. No GPU or model is needed.

## Conventions

- **Validate at the edges**: every request body, query and `.env` value goes through a zod schema; nothing below
  `src/http` knows about HTTP.
- **Security first**: no new route without validation and a test; anything touching pictures or voices goes through
  the adult-only checks ([Security](security.md)). Downloads are pinned (commit or SHA-256).
- **Comments explain why**, not what. Every module starts with a short description of its role.
- **Documentation is part of the change**: update the matching page of `docs/` (and `ARCHITECTURE.md` for
  internals) in the same commit. New `.env` variables go in `.env.example` and [Configuration](configuration.md).
- Database changes are new, ordered migrations in `src/db/migrations.ts` (never edit an existing one).
- Formatting is Prettier's (`npm run format`); Dart code follows `dart format` and `analysis_options.yaml`.
