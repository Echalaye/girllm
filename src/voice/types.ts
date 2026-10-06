/** Voice abstractions: the HTTP layer only depends on these interfaces. */

export interface AudioClip {
  /** Mono PCM in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export interface SpeechToText {
  /** Transcribe mono audio (any sample rate; resampled internally). */
  transcribe(audio: AudioClip): Promise<string>;
}

/** Her voice (step 7: Qwen3-TTS in ComfyUI, see speechService.ts). */
export interface TextToSpeech {
  /** Can she speak right now? (checks ComfyUI: async) */
  status(): Promise<VoiceComponentStatus>;
  /** `text` in the character's voice, as FLAC; undefined when nothing is speakable. */
  speak(characterId: string, text: string, signal?: AbortSignal): Promise<Buffer | undefined>;
  /** Design a voice from a description, kept as a candidate. @returns its id. */
  designCandidate(characterId: string, description: string, signal?: AbortSignal): Promise<string>;
}

export interface VoiceComponentStatus {
  available: boolean;
  /** Model/voice id, e.g. "whisper-base". */
  model: string;
  /** Why it is unavailable (missing files, disabled…). */
  reason?: string;
}

export interface VoiceStatus {
  stt: VoiceComponentStatus;
  tts: VoiceComponentStatus;
}

/** Thrown when a model can't be used (files missing, load failure). */
export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}

/** An engine that can report whether its model is installed. */
export interface WithStatus {
  status(): VoiceComponentStatus;
}

/** Voice engines handed to the HTTP layer (absent when VOICE_ENABLED=false). */
export interface VoiceServices {
  stt: SpeechToText & WithStatus;
  tts: TextToSpeech;
}
