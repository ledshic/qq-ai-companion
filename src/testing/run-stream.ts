import type { RunHost } from '../runtime/service/host.js';
// In-process transport fixture; real HTTP authentication is tested separately.
export function testRunStream(host: RunHost, ownerId: string, id: string, signal?: AbortSignal) {
  let timer: ReturnType<typeof setInterval> | undefined, closed = false;
  const clean = () => { closed = true; if (timer) clearInterval(timer); signal?.removeEventListener('abort', abort); };
  const abort = () => { clean(); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        if (closed) return;
        try {
          const output = host.output(ownerId, id);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(output)}\n\n`));
          if (!['queued', 'running'].includes(output.run.state)) { clean(); controller.close(); }
        } catch (error) { clean(); controller.error(error); }
      };
      signal?.addEventListener('abort', abort, { once: true }); send();
      if (!closed) timer = setInterval(send, 10);
    },
    cancel() { clean(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
