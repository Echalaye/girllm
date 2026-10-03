/**
 * Voice models offered by girllm, downloaded by `npm run setup:voice` from
 * the official sherpa-onnx GitHub releases.
 *
 * Every archive is pinned by SHA-256: the setup script refuses anything
 * that doesn't match, so a compromised or corrupted download is never
 * extracted or loaded.
 */
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export interface ModelArchive {
  url: string;
  sha256: string;
  /** Approximate download size, shown to the user. */
  sizeMb: number;
  /** Top-level directory created by the archive (inside MODELS_DIR). */
  dir: string;
}

export interface SttModel extends ModelArchive {
  /** File prefix inside the archive: "<prefix>-encoder.int8.onnx"… */
  prefix: string;
  description: string;
}

export interface TtsVoice extends ModelArchive {
  /** Base name of the .onnx file inside `dir`. */
  file: string;
  speakerId: number;
  description: string;
}

export const STT_MODELS = {
  'whisper-tiny': {
    url: `${RELEASES}/asr-models/sherpa-onnx-whisper-tiny.tar.bz2`,
    sha256: 'c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1',
    sizeMb: 111,
    dir: 'sherpa-onnx-whisper-tiny',
    prefix: 'tiny',
    description: 'Fastest, least accurate',
  },
  'whisper-base': {
    url: `${RELEASES}/asr-models/sherpa-onnx-whisper-base.tar.bz2`,
    sha256: '911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de',
    sizeMb: 198,
    dir: 'sherpa-onnx-whisper-base',
    prefix: 'base',
    description: 'Good balance (default)',
  },
  'whisper-small': {
    url: `${RELEASES}/asr-models/sherpa-onnx-whisper-small.tar.bz2`,
    sha256: '486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6',
    sizeMb: 610,
    dir: 'sherpa-onnx-whisper-small',
    prefix: 'small',
    description: 'More accurate, ~3x slower than base',
  },
} as const satisfies Record<string, SttModel>;

const upmc = {
  url: `${RELEASES}/tts-models/vits-piper-fr_FR-upmc-medium.tar.bz2`,
  sha256: 'e9830a331a16f6cc5ef3116a287065e015d3495c3f56b974889a266da7f89a7f',
  sizeMb: 77,
  dir: 'vits-piper-fr_FR-upmc-medium',
  file: 'fr_FR-upmc-medium',
};

export const TTS_VOICES = {
  'fr-siwis': {
    url: `${RELEASES}/tts-models/vits-piper-fr_FR-siwis-medium.tar.bz2`,
    sha256: '375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b',
    sizeMb: 65,
    dir: 'vits-piper-fr_FR-siwis-medium',
    file: 'fr_FR-siwis-medium',
    speakerId: 0,
    description: 'French, female (default)',
  },
  'fr-jessica': { ...upmc, speakerId: 0, description: 'French, female' },
  'fr-pierre': { ...upmc, speakerId: 1, description: 'French, male' },
  'fr-tom': {
    url: `${RELEASES}/tts-models/vits-piper-fr_FR-tom-medium.tar.bz2`,
    sha256: '3d8258ef8466b5d5f2cc46c06e1415d3d01c9cbaeed8b6d5b3d152073672472c',
    sizeMb: 65,
    dir: 'vits-piper-fr_FR-tom-medium',
    file: 'fr_FR-tom-medium',
    speakerId: 0,
    description: 'French, male',
  },
  'en-amy': {
    url: `${RELEASES}/tts-models/vits-piper-en_US-amy-medium.tar.bz2`,
    sha256: '9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264',
    sizeMb: 65,
    dir: 'vits-piper-en_US-amy-medium',
    file: 'en_US-amy-medium',
    speakerId: 0,
    description: 'English (US), female',
  },
} as const satisfies Record<string, TtsVoice>;

export type SttModelId = keyof typeof STT_MODELS;
export type TtsVoiceId = keyof typeof TTS_VOICES;

export const STT_MODEL_IDS = Object.keys(STT_MODELS) as [SttModelId, ...SttModelId[]];
export const TTS_VOICE_IDS = Object.keys(TTS_VOICES) as [TtsVoiceId, ...TtsVoiceId[]];
