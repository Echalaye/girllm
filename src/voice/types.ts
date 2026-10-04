/** Voice abstractions: the HTTP layer only depends on these interfaces. */
import type { TtsVoiceId } from './catalog.js';

export interface AudioClip {
  /** Mono PCM in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export interface SpeechToText {
  /** Transcribe mono audio (any sample rate; resampled internally). */
  transcribe(audio: AudioClip): Promise<string>;
}

export interface TextToSpeech {
  /** @param voice optional voice id (a character's own voice); default = the configured one */
  synthesize(text: string, voice?: TtsVoiceId): Promise<AudioClip>;
  /** Is this voice downloaded? (optional: engines with a single voice can omit it) */
  isInstalled?(voice: TtsVoiceId): boolean;
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
  tts: TextToSpeech & WithStatus;
}
