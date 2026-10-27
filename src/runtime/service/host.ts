import { APIError, type AcceptedMessage } from '@companion/contracts/service';
import type { ChatTurn } from '../../memory/memory.js';
import { ServiceStore } from './store.js';
export type ConsoleGenerator = (
  content: string,
  history: ChatTurn[],
  signal: AbortSignal,
) => Promise<string>;
export class RunHost {
  private active = new Map<
    string,
    { ownerId: string; controller: AbortController }
  >();
  private closed = false;
  constructor(
    private store: ServiceStore,
    private generate: ConsoleGenerator,
    private concurrency = 3,
    private historyTurns = 9,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw Error('Invalid concurrency');
    if (
      !Number.isInteger(historyTurns) ||
      historyTurns < 1 ||
      historyTurns > 50
    )
      throw Error('Invalid history turns');
    store.interrupt();
  }
  submit(
    ownerId: string,
    conversationId: string,
    clientMessageId: string,
    content: string,
  ): AcceptedMessage {
    if (this.closed) throw new APIError(503, 'host_stopped');
    const result = this.store.accept(
      ownerId,
      conversationId,
      clientMessageId,
      content,
    );
    for (const [id, active] of this.active)
      if (this.store.run(active.ownerId, id).state !== 'running')
        active.controller.abort();
    this.pump();
    return result;
  }
  cancel(ownerId: string, id: string) {
    const result = this.store.transaction(() => this.store.cancel(ownerId, id));
    this.active.get(id)?.controller.abort();
    this.pump();
    return result;
  }
  private pump() {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      const queued = this.store.nextQueued();
      if (!queued) break;
      const { ownerId, run } = queued;
      if (!this.store.start(ownerId, run.id)) continue;
      const controller = new AbortController();
      this.active.set(run.id, { ownerId, controller });
      const history = this.store.history(
        ownerId,
        run.conversationId,
        this.historyTurns,
      );
      const timer = setTimeout(() => {
        if (this.closed || !this.active.has(run.id)) return;
        this.store.finish(ownerId, run.id, null, 'generation_timeout');
        controller.abort();
      }, 120_000);
      timer.unref();
      void Promise.resolve()
        .then(() => this.generate(run.input, history, controller.signal))
        .then((result) => {
          if (!this.closed && !controller.signal.aborted) {
            if (
              typeof result !== 'string' ||
              !result.trim() ||
              result.length > 16000
            )
              throw Error('invalid_result');
            this.store.finish(ownerId, run.id, result, null);
          }
        })
        .catch((error) => {
          if (!this.closed && !controller.signal.aborted)
            this.store.finish(
              ownerId,
              run.id,
              null,
              error instanceof APIError ? error.code : 'generation_failed',
            );
        })
        .finally(() => {
          clearTimeout(timer);
          this.active.delete(run.id);
          this.pump();
        });
    }
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.store.interrupt();
    } finally {
      for (const active of this.active.values()) active.controller.abort();
      this.active.clear();
    }
  }
}
