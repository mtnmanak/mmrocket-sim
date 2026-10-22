import { fetchAttempts, timerCalls } from './networkTrap.testSupport.js';
import { worker } from './index.js';
import { MAX_DESIGN_FILE_BYTES } from '../../app/src/headless/index.js';

// eslint-disable-next-line no-restricted-syntax -- Test-only Cloudflare module entry requires a default export.
export default {
  async fetch(request: Request, _env: unknown, runtime: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); runtime.waitUntil(p); } };
    const path = new URL(request.url).pathname;
    // Wrangler's HTTP proxy normalizes Content-Length. Exercise the early
    // refusal with a Request created inside workerd, before that proxy boundary.
    if (path === '/__test/declared-oversize') {
      const large = new Request('http://local/experimental/fly?filename=large.ork', { method: 'POST', body: 'x' });
      large.headers.set('Content-Length', String(MAX_DESIGN_FILE_BYTES + 1));
      return worker.fetch(large, undefined, ctx);
    }
    if (path.startsWith('/__test/streamed-cap') || path === '/__test/body-error') {
      let sent = 0;
      let cancelled = false;
      // Reuse a chunk to avoid allocating a second full upload in this test.
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (path === '/__test/body-error' || sent > MAX_DESIGN_FILE_BYTES) {
            controller.error(new Error('Private body reader failure; must never reach the JSON response.'));
            return;
          }
          const bytes = Math.min(chunk.byteLength, MAX_DESIGN_FILE_BYTES + 1 - sent);
          controller.enqueue(chunk.subarray(0, bytes));
          sent += bytes;
        },
        cancel() {
          cancelled = true;
          if (path === '/__test/streamed-cap-cancel-error') throw new Error('Transport cancellation failed.');
        },
      }, { highWaterMark: 0 });
      const input = new Request('http://local/experimental/fly?filename=stream.ork', { method: 'POST', body });
      const response = await worker.fetch(input, undefined, ctx);
      response.headers.set('X-Test-Reader-Cancelled', String(cancelled));
      response.headers.set('X-Test-Bytes-Read', String(sent));
      return response;
    }
    // Self-test the trap without ever reaching the network.
    if (path === '/__test/probe-fetch-trap') {
      const before = fetchAttempts();
      try { await globalThis.fetch('https://outbound.invalid/'); } catch { /* expected trap */ }
      return Response.json({ trapped: fetchAttempts() === before + 1, before });
    }
    const before = fetchAttempts();
    const timersBefore = timerCalls();
    const response = await worker.fetch(request, undefined, ctx);
    await Promise.all(pending);
    response.headers.set('X-Test-Timer-Calls', String(timerCalls() - timersBefore));
    // Bounded observation only: unregistered work scheduled beyond this window is not proven absent.
    await new Promise(resolve => setTimeout(resolve, 100));
    response.headers.set('X-Test-Fetch-Attempts', String(fetchAttempts() - before));
    return response;
  },
};
