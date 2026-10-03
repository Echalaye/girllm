/**
 * Minimal type declarations for the parts of `sherpa-onnx-node` we use
 * (the package ships JSDoc only, no .d.ts).
 */
declare module 'sherpa-onnx-node' {
  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export class OfflineTts {
    static createAsync(config: unknown): Promise<OfflineTts>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generateAsync(req: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>;
  }

  export class OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    static createAsync(config: unknown): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string; lang?: string }>;
  }

  const sherpa: {
    OfflineTts: typeof OfflineTts;
    OfflineRecognizer: typeof OfflineRecognizer;
  };
  export default sherpa;
}
