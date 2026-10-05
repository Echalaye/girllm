/**
 * Recommended settings for the image models girllm knows (step 6), matched
 * by checkpoint file name. Used by the test bench and offered by the
 * settings panel when such a model is picked; any other model keeps the
 * user's own settings.
 */
import { ANIME_MODEL } from './artStyle.js';
import { FLUX2_KLEIN_BASE_FILES, FLUX2_KLEIN_FILES } from './flux2Workflow.js';
import type { ComfyModelFile } from './ipAdapter.js';

export interface ModelPreset {
  /** Human name, for the bench and the settings panel. */
  name: string;
  /** Matched against the checkpoint file name. */
  match: RegExp;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  // The authors recommend DPM++ SDE Karras; CFG low for natural skin.
  { name: 'RealVisXL', match: /realvis/i, sampler: 'dpmpp_sde', scheduler: 'karras', steps: 30, cfg: 4 },
  // "DPM++ 2M Karras, 30–40 steps, CFG 3–7 (lower = more realistic)".
  { name: 'Juggernaut XL', match: /juggernaut/i, sampler: 'dpmpp_2m', scheduler: 'karras', steps: 35, cfg: 4.5 },
  // "Euler a, 25–28 steps, CFG 4–7 (5 recommended)".
  { name: 'Animagine XL', match: /animagine/i, sampler: 'euler_ancestral', scheduler: 'normal', steps: 28, cfg: 5 },
];

/** The preset of a checkpoint, if it is a model girllm knows. */
export function presetFor(checkpoint: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.match.test(checkpoint));
}

/**
 * Juggernaut XI by RunDiffusion (CC BY-NC-ND 4.0: personal, non-commercial
 * use), the most versatile realistic SDXL model for full bodies and hands.
 * Installed by `npm run setup:images -- --juggernaut`.
 */
export const JUGGERNAUT_MODEL: ComfyModelFile = {
  folder: 'checkpoints',
  file: 'Juggernaut-XI-byRunDiffusion.safetensors',
  url: 'https://huggingface.co/RunDiffusion/Juggernaut-XI-v11/resolve/main/Juggernaut-XI-byRunDiffusion.safetensors',
  sha256: '33e58e86686f6b386c526682b5da9228ead4f91d994abd4b053442dc5b42719e',
  sizeMb: 7105,
};

/**
 * Every optional model setup:images can download, by command-line flag
 * (FLUX.2 [klein] is three files: model, text encoder, VAE).
 */
export const OPTIONAL_MODELS: Readonly<Record<string, readonly ComfyModelFile[]>> = {
  '--anime': [ANIME_MODEL],
  '--juggernaut': [JUGGERNAUT_MODEL],
  '--flux2-klein': FLUX2_KLEIN_FILES,
  '--flux2-klein-base': FLUX2_KLEIN_BASE_FILES,
};
