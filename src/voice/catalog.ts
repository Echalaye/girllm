/**
 * Speech-to-text (Whisper) models offered by girllm, downloaded by `npm run setup:voice` from
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

export type SttModelId = keyof typeof STT_MODELS;

export const STT_MODEL_IDS = Object.keys(STT_MODELS) as [SttModelId, ...SttModelId[]];
