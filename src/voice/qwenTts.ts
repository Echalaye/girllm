/**
 * Qwen3-TTS 1.7B (Alibaba Qwen, Apache 2.0) run inside ComfyUI (step 7):
 * her voice, generated on the GPU like her photos.
 *
 * Two models, two jobs:
 *   - VoiceDesign: makes a voice from a written description ("a woman in her
 *     late twenties, warm, slightly husky…") by saying a sample sentence;
 *     that sample becomes her REFERENCE clip (character editor);
 *   - Base (voice clone): says any text with the voice of a reference clip
 *     and its transcript, so every message sounds like the same person.
 *
 * The ComfyUI nodes come from flybirdxx/ComfyUI-Qwen-TTS (Apache 2.0),
 * pinned to a reviewed commit. Graphs use only these two nodes plus core
 * LoadAudio / SaveAudio. Not used, on purpose: its LoadSpeaker node, which
 * unpickles files with `torch.load(weights_only=False)`.
 *
 * The model weights are pinned twice: every URL points at a fixed Hugging
 * Face commit (git content cannot change under it), and the large weight
 * files are also checked against their SHA-256 by `npm run setup:voice`.
 */
import type { ComfyWorkflow } from '../images/workflow.js';

/** flybirdxx/ComfyUI-Qwen-TTS (Apache 2.0), installed into ComfyUI/custom_nodes. */
export const QWEN_TTS_NODES = {
  repo: 'https://github.com/flybirdxx/ComfyUI-Qwen-TTS.git',
  /** 2026-09-22, reviewed: no network access besides the model download we pre-empt. */
  commit: 'a1328c8a731eff82cf4c205b31bdfb7f29d817f4',
  folder: 'ComfyUI-Qwen-TTS',
} as const;

/** ComfyUI node classes the app needs (health check). */
export const QWEN_TTS_NODE_CLASSES = {
  design: 'FB_Qwen3TTSVoiceDesign',
  clone: 'FB_Qwen3TTSVoiceClone',
} as const;

/**
 * Python packages the nodes import that a ComfyUI install may lack. Only the
 * MISSING ones are installed (ComfyUI's own packages are never changed),
 * exact versions, from PyPI. Not the pack's requirements.txt: it pulls
 * onnxruntime-openvino (Intel only) and unpinned versions.
 * `module` is what Python imports, `spec` what pip installs.
 */
export const QWEN_TTS_PYTHON_PACKAGES: ReadonlyArray<{ module: string; spec: string }> = [
  { module: 'librosa', spec: 'librosa==0.11.0' },
  { module: 'soundfile', spec: 'soundfile==0.13.1' },
  { module: 'einops', spec: 'einops==0.8.1' },
  { module: 'sox', spec: 'sox==1.5.0' },
  // Either onnxruntime or onnxruntime-gpu satisfies the import: never install both.
  { module: 'onnxruntime', spec: 'onnxruntime==1.22.1' },
  // transformers loads the model with device_map="cuda", which needs accelerate.
  { module: 'accelerate', spec: 'accelerate==1.10.1' },
];

/** The nodes need transformers ≥ 4.57 (Qwen3-TTS classes). Upgraded only when older. */
export const QWEN_TTS_MIN_TRANSFORMERS = { min: '4.57.0', spec: 'transformers==4.57.3' } as const;

/** A file of a Hugging Face model, pinned by commit (and by SHA-256 for weights). */
export interface PinnedModelFile {
  /** Sub-folder of ComfyUI/models. */
  folder: string;
  file: string;
  url: string;
  /** null: small config/tokenizer file, pinned by the commit in its URL only. */
  sha256: string | null;
  sizeMb: number;
}

/** Folder the nodes search (ComfyUI/models/qwen-tts/<name containing "1.7B" and the model type>). */
export const QWEN_TTS_MODELS_FOLDER = 'qwen-tts';

const SPEECH_TOKENIZER_SHA256 = '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258';

function modelFiles(repo: string, commit: string, weightsSha256: string, weightsMb: number): PinnedModelFile[] {
  const base = `https://huggingface.co/Qwen/${repo}/resolve/${commit}`;
  const folder = `${QWEN_TTS_MODELS_FOLDER}/${repo}`;
  const small = (file: string, sub = ''): PinnedModelFile => ({
    folder: sub ? `${folder}/${sub}` : folder,
    file,
    url: `${base}/${sub ? `${sub}/` : ''}${file}`,
    sha256: null,
    sizeMb: 1,
  });
  return [
    small('config.json'),
    small('generation_config.json'),
    small('preprocessor_config.json'),
    small('tokenizer_config.json'),
    { ...small('merges.txt'), sizeMb: 2 },
    { ...small('vocab.json'), sizeMb: 3 },
    { ...small('model.safetensors'), sha256: weightsSha256, sizeMb: weightsMb },
    small('config.json', 'speech_tokenizer'),
    small('configuration.json', 'speech_tokenizer'),
    small('preprocessor_config.json', 'speech_tokenizer'),
    { ...small('model.safetensors', 'speech_tokenizer'), sha256: SPEECH_TOKENIZER_SHA256, sizeMb: 682 },
  ];
}

/** Voice clone model (says any text with her reference voice). */
export const QWEN_TTS_BASE_FILES = modelFiles(
  'Qwen3-TTS-12Hz-1.7B-Base',
  'fd4b254389122332181a7c3db7f27e918eec64e3',
  '38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c',
  3860,
);

/** Voice design model (makes a voice from a description). */
export const QWEN_TTS_DESIGN_FILES = modelFiles(
  'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
  '5ecdb67327fd37bb2e042aab12ff7391903235d3',
  '391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522',
  3830,
);

/**
 * The nodes download "Qwen/Qwen3-TTS-Tokenizer-12Hz" (unpinned) whenever its
 * folder is missing, although inference uses the speech_tokenizer folder of
 * each model. The setup creates this folder (with a note) so nothing is
 * ever downloaded behind our back.
 */
export const QWEN_TTS_TOKENIZER_PLACEHOLDER = `${QWEN_TTS_MODELS_FOLDER}/Qwen3-TTS-Tokenizer-12Hz`;

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/** Languages the model speaks (values of the nodes' "language" input). */
export type QwenLanguage =
  | 'Auto'
  | 'Chinese'
  | 'English'
  | 'Japanese'
  | 'Korean'
  | 'French'
  | 'German'
  | 'Spanish'
  | 'Portuguese'
  | 'Russian'
  | 'Italian';

const LANGUAGE_PATTERNS: ReadonlyArray<[RegExp, QwenLanguage]> = [
  [/^(fr|fran[cç]ais|french)/i, 'French'],
  [/^(en|english|anglais)/i, 'English'],
  [/^(de|german|deutsch|allemand)/i, 'German'],
  [/^(es|spanish|espa[nñ]ol|espagnol)/i, 'Spanish'],
  [/^(it|italian|italiano|italien)/i, 'Italian'],
  [/^(pt|portugu)/i, 'Portuguese'],
  [/^(ru|russian|russe)/i, 'Russian'],
  [/^(ja|japanese|japonais)/i, 'Japanese'],
  [/^(ko|korean|cor[ée]en)/i, 'Korean'],
  [/^(zh|chinese|chinois|mandarin)/i, 'Chinese'],
];

/**
 * The reply-language setting (free text: "French", "français", "fr"…) as a
 * model language; "Auto" (the model guesses) for anything else or empty.
 */
export function qwenLanguage(replyLanguage: string | undefined): QwenLanguage {
  const text = (replyLanguage ?? '').trim();
  return LANGUAGE_PATTERNS.find(([re]) => re.test(text))?.[1] ?? 'Auto';
}

/**
 * What she says to show a new voice: ~8–10 s of natural speech with some
 * intonation (a question, an exclamation), which also makes a good
 * reference clip for cloning. French and English; English otherwise.
 */
export function voiceSampleText(language: QwenLanguage): string {
  return language === 'French'
    ? "Salut, c'est moi ! Je suis vraiment contente que tu sois là. Alors, raconte-moi, comment s'est passée ta journée ?"
    : "Hi, it's me! I'm really glad you're here. So, tell me, how was your day?";
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * Settings shared by both nodes. The model is unloaded right after each job:
 * the nodes keep it in their own cache, which ComfyUI's /free does NOT
 * clear, and the VRAM must go back to the chat model.
 */
const COMMON = {
  model_choice: '1.7B',
  device: 'auto',
  precision: 'bf16',
  // PyTorch's built-in attention. Not "auto": it prefers SageAttention when
  // installed, which this node pack applies through a fragile monkeypatch.
  attention: 'sdpa',
  unload_model_after_generate: true,
  // Defaults of the official examples.
  top_p: 1.0,
  top_k: 50,
  temperature: 0.9,
  repetition_penalty: 1.05,
} as const;

/** ~12.5 tokens per second of speech: 2048 tokens ≈ 2.7 minutes, far above MAX_SPEECH_CHARS. */
const MAX_NEW_TOKENS = 2048;

export interface VoiceDesignParams {
  /** What the voice sounds like (already safety-checked and prefixed with "adult"). */
  description: string;
  /** What she says (voiceSampleText). */
  text: string;
  language: QwenLanguage;
  seed: number;
}

/** Node ids: 1 design · 2 save. */
export function buildVoiceDesignWorkflow(p: VoiceDesignParams): ComfyWorkflow {
  return {
    '1': {
      class_type: QWEN_TTS_NODE_CLASSES.design,
      inputs: {
        ...COMMON,
        text: p.text,
        instruct: p.description,
        language: p.language,
        seed: p.seed,
        max_new_tokens: MAX_NEW_TOKENS,
      },
    },
    '2': { class_type: 'SaveAudio', inputs: { audio: ['1', 0], filename_prefix: 'girllm_voice/design' } },
  };
}

export interface VoiceCloneParams {
  /** Her reference clip, uploaded to ComfyUI's input folder (LoadAudio name). */
  referenceAudio: string;
  /** What the reference clip says (better cloning than the x-vector alone). */
  referenceText: string;
  /** What she says now. */
  text: string;
  language: QwenLanguage;
  seed: number;
}

/** Node ids: 1 load reference · 2 clone · 3 save. */
export function buildVoiceCloneWorkflow(p: VoiceCloneParams): ComfyWorkflow {
  return {
    '1': { class_type: 'LoadAudio', inputs: { audio: p.referenceAudio } },
    '2': {
      class_type: QWEN_TTS_NODE_CLASSES.clone,
      inputs: {
        ...COMMON,
        target_text: p.text,
        ref_audio: ['1', 0],
        ref_text: p.referenceText,
        language: p.language,
        seed: p.seed,
        max_new_tokens: MAX_NEW_TOKENS,
        x_vector_only: false,
        instruct: '',
        custom_model_path: '',
      },
    },
    '3': { class_type: 'SaveAudio', inputs: { audio: ['2', 0], filename_prefix: 'girllm_voice/speech' } },
  };
}
