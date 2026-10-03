/**
 * Coordinates GPU use between the LLM and image generation on an 8 GB card.
 *
 * - LLM requests are "shared": any number may run at once.
 * - Image generation is "exclusive": it waits for running LLM requests to
 *   finish and holds back new ones until it is done, so the LLM can be
 *   unloaded and the image model gets the whole VRAM.
 *
 * Exclusive jobs run one at a time, in order. A waiting exclusive job has
 * priority over new shared requests (no starvation).
 */
export class GpuGate {
  private shared = 0;
  /** Resolves when the current exclusive phase ends. */
  private exclusiveDone: Promise<void> | null = null;
  /** Wakes the exclusive job waiting for shared users to drain. */
  private onDrained: (() => void) | null = null;
  private exclusiveTail: Promise<unknown> = Promise.resolve();

  /** Enter as a shared user; call the returned function to leave. */
  async enterShared(): Promise<() => void> {
    while (this.exclusiveDone) await this.exclusiveDone;
    this.shared++;
    let left = false;
    return () => {
      if (left) return; // idempotent
      left = true;
      this.shared--;
      if (this.shared === 0) this.onDrained?.();
    };
  }

  /** Run `task` with exclusive GPU access. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let end!: () => void;
      this.exclusiveDone = new Promise<void>((r) => (end = r));
      try {
        if (this.shared > 0) await new Promise<void>((r) => (this.onDrained = r));
        this.onDrained = null;
        return await task();
      } finally {
        this.exclusiveDone = null;
        end();
      }
    };
    const result = this.exclusiveTail.then(run, run);
    this.exclusiveTail = result.catch(() => undefined);
    return result;
  }
}
