/**
 * Promise-based mutex: `run` executes tasks one at a time, in call order,
 * and propagates each task's result or error to its own caller.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive whatever the outcome of this task.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
