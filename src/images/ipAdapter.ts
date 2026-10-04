/**
 * IP-Adapter "Plus Face" (SDXL): keeps the character's face consistent from
 * one photo to the next by conditioning generation on her reference face
 * (data/faces/<id>.png). No insightface needed: the face is encoded with
 * the CLIP-ViT-H vision model.
 *
 * Everything here is pinned: the ComfyUI custom nodes by git commit, the
 * model files by SHA-256 (verified by `npm run setup:images` before they
 * are moved into place).
 */

/** cubiq/ComfyUI_IPAdapter_plus (GPL-3.0), installed into ComfyUI/custom_nodes. */
export const IPADAPTER_NODES = {
  repo: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus.git',
  /** 2025-04-14 — the repository is in maintenance mode since then. */
  commit: 'a0f451a5113cf9becb0847b92884cb10cbdec0ef',
  folder: 'ComfyUI_IPAdapter_plus',
} as const;

export interface ComfyModelFile {
  /** Sub-folder of ComfyUI/models. */
  folder: string;
  /** File name ComfyUI will list (the CLIP model is renamed, as the nodes' README asks). */
  file: string;
  url: string;
  sha256: string;
  sizeMb: number;
}

const HF = 'https://huggingface.co/h94/IP-Adapter/resolve/main';

export const CLIP_VISION_MODEL: ComfyModelFile = {
  folder: 'clip_vision',
  file: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
  url: `${HF}/models/image_encoder/model.safetensors`,
  sha256: '6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030',
  sizeMb: 2528,
};

export const FACE_IPADAPTER_MODEL: ComfyModelFile = {
  folder: 'ipadapter',
  file: 'ip-adapter-plus-face_sdxl_vit-h.safetensors',
  url: `${HF}/sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors`,
  sha256: '677ad8860204f7d0bfba12d29e6c31ded9beefdf3e4bbd102518357d31a292c1',
  sizeMb: 848,
};

export const IPADAPTER_MODELS: readonly ComfyModelFile[] = [CLIP_VISION_MODEL, FACE_IPADAPTER_MODEL];

/** Face conditioning added to a workflow. */
export interface FaceParams {
  /** Image name in ComfyUI's input folder (uploaded by girllm). */
  image: string;
  /** 0–1: how strongly the reference face is imposed (0.6–0.8 keeps the scene free). */
  weight: number;
}
