import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { autoBody, bytesOf } from './fixtures.testSupport.js';
import { boosterBranches } from '@online-openrocket/engine';
import { jsXmlParser, setXmlParser, simulateFile } from '../../app/src/headless/index.js';

const relay = `export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname !== '/cancel') return env.TARGET.fetch(request);
  const body = await request.arrayBuffer();
  const controller = new AbortController();
  let observed;
  const reading = new Promise(resolve => { observed = resolve; });
  let sent = false;
  let cancelled = false;
  let uploadController;
  const upload = new ReadableStream({
    start(c) { uploadController = c; },
    pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(body)); observed(); } },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const flight = env.TARGET.fetch('http://local/experimental/fly?filename=auto.rkt',
    { method: 'POST', body: upload, signal: controller.signal });
  ctx.waitUntil(flight.then(r => r.arrayBuffer()).catch(() => undefined));
  try {
    await Promise.race([reading, flight.then(() => { throw new Error('Target answered before reading the upload.'); })]);
    controller.abort();
    return Response.json({ cancelled: controller.signal.aborted });
  } finally {
    controller.abort();
    if (!cancelled) uploadController.error(new Error('Relay cancelled upload.'));
  }
} };`;

// Direct service dispatch, without Wrangler's HTTP proxy. The relay aborts an upstream
// subrequest after observing upload consumption, keeping the upload open until abort.
// This is a relay smoke test, not evidence of mid-lock cancellation.
it('a relay abort signal after upload consumption leaves later direct dispatches usable', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./authenticatedWorker.testSupport.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'], logLevel: 'silent' });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
    workers: [
      { name: 'relay', modules: true, script: relay, compatibilityDate, serviceBindings: { TARGET: 'target' } },
      { name: 'target', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate },
    ] }));
  try {
    await mf.ready;
    const response = await mf.dispatchFetch('http://local/cancel', { method: 'POST', body: await autoBody() });
    expect(await response.json()).toEqual({ cancelled: true });
    const subsequent = await mf.dispatchFetch('http://local/experimental/fly?filename=reference.ork',
      { method: 'POST', body: bytesOf('reference.ork'), signal: AbortSignal.timeout(5000) });
    expect(subsequent.status, await subsequent.clone().text()).toBe(200);
    setXmlParser(jsXmlParser);
    const node = await simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
    const aborted = [node.result, ...boosterBranches(node.result)].some(branch =>
      branch.events.some(event => event.type === 'SIM_ABORT' || event.type === 'EXCEPTION'));
    expect((await subsequent.json() as { outcome: string }).outcome).toBe(aborted ? 'aborted' : 'completed');
  } finally { await mf.dispose(); }
});

it('waits for observed upload consumption even when the upstream is delayed', async () => {
  vi.useFakeTimers();
  // eslint-disable-next-line no-new-func -- Exercise the exact test-owned relay without a workerd listener.
  const service = new Function('return ' + relay.replace('export default ', ''))() as {
    fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response>;
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let reading = false;
  let premature = false;
  const pending: Promise<unknown>[] = [];
  const response = service.fetch(new Request('http://local/cancel', { method: 'POST', body: 'test-only upload' }), {
    TARGET: { async fetch(_url: string, init: { body: ReadableStream<Uint8Array>; signal: AbortSignal }) {
      started = true;
      init.signal.addEventListener('abort', () => { premature = !reading; }, { once: true });
      await gate;
      reading = true;
      const reader = init.body.getReader();
      try {
        await reader.read();
        await new Promise<void>(resolve => {
          if (init.signal.aborted) resolve();
          else init.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return new Response('');
      } finally { await reader.cancel().catch(() => undefined); }
    } },
  }, { waitUntil(p) { pending.push(p); } });
  try {
    await vi.waitFor(() => { expect(started).toBe(true); });
    await vi.advanceTimersByTimeAsync(100);
    expect(premature).toBe(false);
    release();
    expect(await (await response).json()).toEqual({ cancelled: true });
    expect(reading).toBe(true);
    expect(premature).toBe(false);
  } finally {
    release();
    await response;
    await Promise.all(pending);
    vi.useRealTimers();
  }
});
