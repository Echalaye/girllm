/**
 * Builds a standard SDXL text-to-image workflow in ComfyUI's API format
 * (the same graph as ComfyUI's default workflow).
 */

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface WorkflowParams {
  checkpoint: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
}

/**
 * Node ids are numeric strings, like workflows exported from ComfyUI:
 * 1 checkpoint · 2 empty latent · 3/4 positive/negative prompts · 5 sampler · 6 VAE decode · 7 save.
 */
export function buildTxt2ImgWorkflow(p: WorkflowParams): ComfyWorkflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: p.positive, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['1', 1] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        denoise: 1,
        model: ['1', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['2', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'girllm', images: ['6', 0] } },
  };
}
