/**
 * Runs async tasks one after another per key (e.g. per character), so two
 * background memory jobs never update the same data concurrently, while
 * jobs for different keys stay independent.
 */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Enqueue `task` after the previous task of the same key.
   * Errors are passed to `onError` and never break the chain.
   */
  enqueue(key: string, task: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task).catch(onError);
    this.tails.set(key, next);
    // Free the map entry once the chain is idle (prevents unbounded growth).
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  /** Resolves when every queued task has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
