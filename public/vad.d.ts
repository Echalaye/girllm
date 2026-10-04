// Type declarations for vad.js (plain browser module, also unit-tested from TypeScript).
export declare const VAD_SAMPLE_RATE: number;
export declare const VAD_DEFAULTS: Readonly<{
  sampleRate: number;
  frameMs: number;
  startMarginDb: number;
  continueMarginDb: number;
  minSpeechDb: number;
  minSpeechMs: number;
  hangoverMs: number;
  prerollMs: number;
  tailMs: number;
  maxUtteranceMs: number;
}>;
export type VadEvent =
  { type: 'speechstart' } | { type: 'speechend'; audio: Float32Array; forced: boolean } | { type: 'discarded' };
export declare function frameDb(frame: Float32Array): number;
export declare class Downsampler {
  constructor(fromRate: number, toRate?: number);
  readonly ratio: number;
  push(input: Float32Array): Float32Array;
}
export declare class VoiceActivityDetector {
  constructor(options?: Partial<typeof VAD_DEFAULTS>);
  readonly frameSize: number;
  readonly state: 'idle' | 'pending' | 'speech';
  readonly lastDb: number;
  readonly noiseFloorDb: number | undefined;
  readonly speaking: boolean;
  reset(): void;
  push(samples: Float32Array): VadEvent[];
}
