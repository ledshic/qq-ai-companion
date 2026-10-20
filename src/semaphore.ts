// A counting semaphore: work that needs a model call waits here instead of
// being dropped, and an abort removes it from the queue immediately.
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数');
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release);
    }
    return new Promise((resolve, reject) => {
      const start = (): void => { this.active++; resolve(this.release); };
      this.waiters.push(start);
      signal?.addEventListener('abort', () => {
        const index = this.waiters.indexOf(start);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(signal.reason);
      }, { once: true });
    });
  }

  private readonly release = (): void => {
    this.active--;
    this.waiters.shift()?.();
  };
}
