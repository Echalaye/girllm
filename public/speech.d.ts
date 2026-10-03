// Type declarations for speech.js (plain browser module, also unit-tested from TypeScript).
export declare class SentenceSplitter {
  constructor(options?: { minChars?: number; maxChars?: number });
  buffer: string;
  push(text: string): string[];
  flush(): string[];
}
