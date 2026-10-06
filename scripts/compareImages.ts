/**
 * Image test bench (step 6): the same test shots, with the same seeds,
 * through several image models, then a contact sheet to compare them.
 *
 *   npm run compare:images
 *   npm run compare:images -- --character magi      (her appearance, gender, style and face)
 *   npm run compare:images -- --shots desk,cup,sofa --seeds 2
 *   npm run compare:images -- --seed-list 84370200426139,108282413766794
 *   npm run compare:images -- --models RealVisXL_V5.0_fp16.safetensors,flux2-klein-4b-8steps
 *   npm run compare:images -- --style anime
 *
 * Defaults, realistic characters: the FLUX.2 [klein] columns
 * (FLUX2_DEFAULT_VARIANTS) when installed, otherwise your SDXL model and the
 * other known SDXL models installed. Anime: your model and Animagine.
 * Always the same seeds (BENCH_SEEDS, 4 by default), so two runs are
 * comparable; all 10 shots. --models takes checkpoint file names and FLUX.2
 * variant ids.
 * Output: DATA_DIR/compare-images/<date>/index.html (+ the PNGs and
 * results.json). Uses the real pipeline of the app (prompt building, adult
 * safety terms, face detail pass), so what you see is what she sends.
 *
 * Ollama's model is unloaded first (the GPU is needed); don't chat during
 * the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CharacterRepository } from '../src/characters/characterRepository.js';
import { FaceStore } from '../src/characters/faceStore.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  buildNegativePrompt,
  buildPositivePrompt,
  frameForScene,
  type ArtStyle,
  type Gender,
} from '../src/images/artStyle.js';
import { ComfyClient } from '../src/images/comfyClient.js';
import { FaceDetector, faceDetectorPath } from '../src/images/faceDetector.js';
import {
  buildFlux2FacePrompt,
  buildFlux2Prompt,
  buildFlux2Workflow,
  flux2Variant,
  FLUX2_DEFAULT_VARIANTS,
  FLUX2_FACE_PASS,
  FLUX2_KLEIN_BASE_MODEL,
  FLUX2_KLEIN_MODEL,
  FLUX2_KLEIN_TEXT_ENCODER,
  FLUX2_NEGATIVE,
  FLUX2_SAMPLER,
  FLUX2_VAE,
  referenceCrop,
  type Flux2Variant,
} from '../src/images/flux2Workflow.js';
import type { CropBox } from '../src/images/detailWorkflow.js';
import type { FaceParams } from '../src/images/ipAdapter.js';
import { presetFor, type ModelPreset } from '../src/images/presets.js';
import { pngSize, renderPicture, type RenderJob } from '../src/images/renderPipeline.js';
import { assertSafe } from '../src/images/safety.js';
import { buildTxt2ImgWorkflow } from '../src/images/workflow.js';
import { defaultsFromConfig } from '../src/settings/settingsSchema.js';
import { SettingsService } from '../src/settings/settingsService.js';
import {
  chooseSeeds,
  planBench,
  renderBenchHtml,
  selectShots,
  type BenchModel,
  type BenchResult,
} from './imageBenchLib.js';

const DEFAULT_APPEARANCE: Record<ArtStyle, Record<Gender, string>> = {
  realistic: {
    female: 'woman, 30 years old, long wavy brown hair, brown eyes, light freckles, slim',
    male: 'man, 30 years old, short brown hair, brown eyes, light stubble, athletic',
  },
  anime: {
    female: 'long hair, brown hair, brown eyes, slim',
    male: 'short hair, brown hair, brown eyes',
  },
};

interface Args {
  models?: string[];
  style?: ArtStyle;
  shots?: string[];
  seeds?: number;
  seedList?: string[];
  character?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--models') args.models = list(argv[++i]);
    else if (a === '--shots') args.shots = list(argv[++i]);
    else if (a === '--seeds') args.seeds = Number(argv[++i]) || undefined;
    else if (a === '--seed-list') args.seedList = list(argv[++i]);
    else if (a === '--character') args.character = argv[++i];
    else if (a === '--style') {
      const v = argv[++i];
      if (v !== 'realistic' && v !== 'anime') throw new Error('--style must be realistic or anime');
      args.style = v;
    } else throw new Error(`Unknown argument "${a}"`);
  }
  return args;
}

const log = {
  warn: (obj: unknown, msg?: string) => {
    console.warn(`  ! ${msg ?? ''}`, obj instanceof Error ? obj.message : '');
  },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // The app's live settings (what you changed in the Settings panel).
  const db = openDatabase(config.databasePath);
  const s = new SettingsService(db, defaultsFromConfig(config), 2048).get();
  db.close();

  const comfy = new ComfyClient({ baseUrl: config.images.comfyUrl, timeoutMs: 600_000 });
  const status = await comfy.status();
  if (!status.ok)
    throw new Error(`ComfyUI is not reachable at ${config.images.comfyUrl} (${status.error}). Start it first.`);
  const installed = status.checkpoints ?? [];
  // FLUX.2 [klein]: which of its two models (distilled, base) ComfyUI can run.
  const fluxReady = async (model: string) =>
    comfy.flux2Support({ model, textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file, vae: FLUX2_VAE.file });
  const fluxSupport = new Map([
    [FLUX2_KLEIN_MODEL.file, await fluxReady(FLUX2_KLEIN_MODEL.file)],
    [FLUX2_KLEIN_BASE_MODEL.file, await fluxReady(FLUX2_KLEIN_BASE_MODEL.file)],
  ]);
  const fluxInstalled = (v: Flux2Variant) => fluxSupport.get(v.model.file)?.ready === true;

  // Who to draw: a character of yours, or a neutral adult test subject.
  const character = args.character
    ? (await CharacterRepository.loadFromDirectory(config.charactersDir, { info: () => {}, warn: () => {} })).get(
        args.character,
      )
    : undefined;
  if (args.character && !character) throw new Error(`Character "${args.character}" not found`);
  const style: ArtStyle = args.style ?? character?.artStyle ?? 'realistic';
  const gender: Gender = character?.gender ?? 'female';
  const appearance = character?.appearance || DEFAULT_APPEARANCE[style][gender];
  assertSafe(appearance);

  // Profile of the style (your settings), and which models to compare.
  const profile =
    style === 'anime'
      ? {
          checkpoint: s.animeCheckpoint,
          sampler: s.animeSampler,
          scheduler: s.animeScheduler,
          steps: s.animeSteps,
          cfg: s.animeCfg,
          styleTags: s.animeStyle,
          negative: s.animeNegative,
          hires: s.animeHiresScale,
          face: s.animeFaceWeight,
          detail: s.animeDetailStrength,
        }
      : {
          checkpoint: s.imageCheckpoint,
          sampler: s.imageSampler,
          scheduler: s.imageScheduler,
          steps: s.imageSteps,
          cfg: s.imageCfg,
          styleTags: s.imageStyle,
          negative: s.imageNegative,
          hires: s.imageHiresScale,
          face: s.imageFaceWeight,
          detail: s.imageDetailStrength,
        };
  // Realistic: FLUX.2 [klein] replaced the SDXL photo models (bench of
  // 2026-10-05), so only its columns are compared once it is installed.
  const fluxDefaults =
    style === 'realistic' ? FLUX2_DEFAULT_VARIANTS.filter((id) => fluxInstalled(flux2Variant(id)!)) : [];
  const sdxlDefaults = [
    profile.checkpoint,
    // Every other known SDXL model of this style that is installed.
    ...installed.filter((c) => {
      const p = presetFor(c);
      return p && (style === 'anime') === /animagine/i.test(p.name) && c !== profile.checkpoint;
    }),
  ].filter(Boolean);
  const wanted = args.models ?? (fluxDefaults.length ? fluxDefaults : sdxlDefaults);
  const isFlux = (m: string) => flux2Variant(m) !== undefined;
  const missing = wanted.filter((m) => !isFlux(m) && !installed.includes(m));
  if (missing.length) throw new Error(`Not found in ComfyUI: ${missing.join(', ')}`);
  for (const v of wanted.map(flux2Variant)) {
    if (v && !fluxInstalled(v)) {
      const flag = v.model === FLUX2_KLEIN_BASE_MODEL ? '--flux2-klein-base' : '--flux2-klein';
      const reason = fluxSupport.get(v.model.file)?.reason ?? 'not installed';
      throw new Error(`${v.label}: ${reason.replace('--flux2-klein)', `${flag})`)}`);
    }
  }
  if (!wanted.length) throw new Error('No model to test: set one in the settings or pass --models');

  const models: BenchModel[] = wanted.map((checkpoint) => {
    const v = flux2Variant(checkpoint);
    if (v) {
      return {
        checkpoint,
        label: v.label,
        family: 'flux2',
        sampler: FLUX2_SAMPLER,
        scheduler: 'flux2',
        steps: v.steps,
        cfg: v.cfg,
      };
    }
    const preset = checkpoint === profile.checkpoint ? undefined : presetFor(checkpoint);
    return preset
      ? { checkpoint, label: `${preset.name} (recommended settings)`, ...pick(preset) }
      : {
          checkpoint,
          label: 'Your settings',
          sampler: profile.sampler,
          scheduler: profile.scheduler,
          steps: profile.steps,
          cfg: profile.cfg,
        };
  });

  const shots = selectShots(args.shots);
  const seeds = chooseSeeds({ count: args.seeds, list: args.seedList });
  const runs = planBench(shots, models, seeds);

  // The GPU is needed: unload Ollama's chat model (it reloads on the next message).
  if (config.llm.provider === 'ollama') {
    await fetch(`${config.llm.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.llmModel, keep_alive: 0 }),
    }).catch(() => undefined);
  }

  // Her face, when testing one of your characters: IP-Adapter for SDXL
  // models (when installed), a reference picture for FLUX.2.
  let face: FaceParams | undefined;
  let reference: string | undefined;
  let crop: CropBox | undefined;
  const detector = new FaceDetector(faceDetectorPath(config.voice.modelsDir));
  if (!detector.available()) console.log('Face detector not installed: no face detail pass (npm run setup:images).');
  const faceFile = character ? new FaceStore(config.facesDir).get(character.id) : undefined;
  // Anime profiles have no face weight by default: FLUX.2 gets her face as long as one exists.
  if (faceFile && (profile.face > 0 || wanted.some(isFlux))) {
    const bytes = await readFile(faceFile.path);
    const name = `girllm_bench_face.${faceFile.type === 'png' ? 'png' : 'jpg'}`;
    reference = await comfy.uploadImage(bytes, name, faceFile.type === 'png' ? 'image/png' : 'image/jpeg');
    if (profile.face > 0 && (await comfy.faceSupport()).ready) face = { image: reference, weight: profile.face };
    // FLUX.2 copies whatever the reference shows: keep only her face (PNG faces; JPEG ones are used whole).
    if (faceFile.type === 'png' && detector.available()) {
      const box = await detector.detect(bytes).catch(() => undefined);
      if (box) {
        const { width, height } = pngSize(bytes);
        crop = referenceCrop(box, width, height);
      }
    }
    if (wanted.some(isFlux) && !crop) console.log('FLUX.2: her whole face picture is used (face not cropped).');
  }

  // Pose guides (FLUX.2 "-pose" column): DATA_DIR/poses/<shot id>.png, a
  // picture whose body and hands are right, chosen on an earlier bench.
  // Uploaded once per shot; a shot without one is drawn without a guide.
  const poses = new Map<string, string>();
  const posesDir = join(resolve(config.databasePath, '..'), 'poses');
  if (wanted.some((m) => flux2Variant(m)?.pose)) {
    if (!reference) console.log('Pose guides need her face (--character with a face): no pose guide this run.');
    else {
      for (const shot of shots) {
        const file = join(posesDir, `${shot.id}.png`);
        if (!existsSync(file)) continue;
        poses.set(
          shot.id,
          await comfy.uploadImage(await readFile(file), `girllm_bench_pose_${shot.id}.png`, 'image/png'),
        );
      }
      console.log(
        `Pose guides (${posesDir}): ${poses.size ? [...poses.keys()].join(', ') : 'none found'}` +
          (poses.size < shots.length ? ' (other shots: no guide)' : ''),
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = resolve(join(resolve(config.databasePath, '..'), 'compare-images', stamp));
  mkdirSync(outDir, { recursive: true });
  console.log(
    `${runs.length} pictures (${shots.length} shots × ${seeds.length} seed(s) × ${models.length} model(s)) → ${outDir}\n`,
  );

  const results: BenchResult[] = [];
  const total = performance.now();
  try {
    for (const [i, run] of runs.entries()) {
      const positive = buildPositivePrompt({
        style,
        gender,
        styleTags: profile.styleTags,
        appearance,
        scene: run.shot.scene[style],
      });
      const negative = buildNegativePrompt(style, profile.negative);
      // FLUX.2 gets sentences and its own photo style (see flux2Workflow.ts).
      const fluxRef = (bm: BenchModel) => reference !== undefined && flux2Variant(bm.checkpoint)?.reference === true;
      const fluxPose = (bm: BenchModel) =>
        fluxRef(bm) && flux2Variant(bm.checkpoint)?.pose === true ? poses.get(run.shot.id) : undefined;
      const fluxPositive = (withFace: boolean, pose: boolean) => {
        const text = buildFlux2Prompt({
          style,
          gender,
          appearance,
          scene: run.shot.scene[style],
          reference: withFace,
          pose,
        });
        assertSafe(text);
        return text;
      };
      const fluxFacePositive = () => {
        const text = buildFlux2FacePrompt({ style, gender, appearance });
        assertSafe(text);
        return text;
      };
      const m = run.model;
      const base = `${run.shot.id}_${run.seed}_${run.modelIndex}`;
      process.stdout.write(`[${i + 1}/${runs.length}] ${run.shot.id} · ${m.checkpoint} … `);
      const start = performance.now();
      try {
        const size = frameForScene(run.shot.scene[style], run.shot.width, run.shot.height);
        const job: RenderJob =
          m.family === 'flux2'
            ? {
                // Same face pass as the app (step 6c) when her face is given.
                workflow: buildFlux2Workflow({
                  positive: fluxPositive(fluxRef(m), fluxPose(m) !== undefined),
                  seed: run.seed,
                  ...size,
                  steps: m.steps,
                  cfg: m.cfg,
                  sampler: m.sampler,
                  referenceImage: fluxRef(m) ? reference : undefined,
                  referenceCrop: crop,
                  poseImage: fluxPose(m),
                  files: {
                    model: flux2Variant(m.checkpoint)!.model.file,
                    textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file,
                    vae: FLUX2_VAE.file,
                  },
                  // Base model only: a real negative prompt, with the youth terms.
                  negative: flux2Variant(m.checkpoint)!.negative
                    ? buildNegativePrompt(style, FLUX2_NEGATIVE)
                    : undefined,
                }),
                detail:
                  fluxRef(m) && reference !== undefined && profile.detail > 0
                    ? {
                        kind: 'flux2',
                        positive: fluxFacePositive(),
                        seed: run.seed,
                        face: { image: reference, crop },
                        ...FLUX2_FACE_PASS,
                        files: {
                          model: flux2Variant(m.checkpoint)!.model.file,
                          textEncoder: FLUX2_KLEIN_TEXT_ENCODER.file,
                          vae: FLUX2_VAE.file,
                        },
                      }
                    : undefined,
              }
            : {
                workflow: buildTxt2ImgWorkflow({
                  checkpoint: m.checkpoint,
                  positive,
                  negative,
                  seed: run.seed,
                  // Same framing rule as the app (taller frame for full bodies).
                  ...size,
                  steps: m.steps,
                  cfg: m.cfg,
                  sampler: m.sampler,
                  scheduler: m.scheduler,
                  hires: { scale: profile.hires, denoise: s.imageHiresDenoise, steps: s.imageHiresSteps },
                  face,
                }),
                detail:
                  profile.detail > 0
                    ? {
                        checkpoint: m.checkpoint,
                        positive,
                        negative,
                        seed: run.seed,
                        steps: m.steps,
                        cfg: m.cfg,
                        sampler: m.sampler,
                        scheduler: m.scheduler,
                        denoise: profile.detail,
                        face,
                      }
                    : undefined,
              };
        const result = await renderPicture(comfy, detector, job, log);
        const seconds = (performance.now() - start) / 1000;
        writeFileSync(join(outDir, `${base}.png`), result.png);
        let baseFile: string | undefined;
        if (result.detail === 'done') {
          baseFile = `${base}_before.png`;
          writeFileSync(join(outDir, baseFile), result.base);
        }
        const detail =
          m.family !== 'flux2' || result.detail !== 'off'
            ? result.detail
            : flux2Variant(m.checkpoint)?.pose
              ? fluxPose(m)
                ? 'flux2-pose'
                : 'flux2-no-pose'
              : 'flux2';
        results.push({ ...run, file: `${base}.png`, baseFile, seconds, detail });
        console.log(`${seconds.toFixed(1)} s (${detail})`);
      } catch (err) {
        results.push({ ...run, file: '', seconds: 0, detail: 'failed', error: (err as Error).message });
        console.log(`✗ ${(err as Error).message}`);
      }
      // Keep the sheet usable even if the run is interrupted.
      writeSheet(outDir, { style, appearance, models, results });
    }
  } finally {
    await comfy.free().catch(() => undefined);
  }
  console.log(
    `\nDone in ${((performance.now() - total) / 60_000).toFixed(1)} min. Open:\n  ${join(outDir, 'index.html')}`,
  );
}

function pick(p: ModelPreset) {
  return { sampler: p.sampler, scheduler: p.scheduler, steps: p.steps, cfg: p.cfg };
}

function writeSheet(
  outDir: string,
  data: { style: ArtStyle; appearance: string; models: BenchModel[]; results: BenchResult[] },
): void {
  const sheet = { title: 'girllm — image test bench', createdAt: new Date().toLocaleString(), ...data };
  writeFileSync(join(outDir, 'index.html'), renderBenchHtml(sheet));
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(sheet, null, 2)}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
