import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { autoBody, bytesOf } from './fixtures.testSupport.js';
import { boosterBranches } from '@online-openrocket/engine';
import { jsXmlParser, setXmlParser, simulateFile } from '../../app/src/headless/index.js';

// Direct service dispatch, without Wrangler's HTTP proxy. The relay aborts an upstream
// subrequest at the first macrotask opportunity. With microtask-only flight the target
// may have already answered: this is a relay smoke test, not evidence of mid-lock cancellation.
it('a relay abort signal after an event-loop turn leaves later direct dispatches usable', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'], logLevel: 'silent' });
  const relay = `export default { async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/cancel') return env.TARGET.fetch(request);
    const body = await request.arrayBuffer();
    const controller = new AbortController();
    const flight = env.TARGET.fetch('http://local/experimental/fly?filename=auto.rkt',
      { method: 'POST', body, signal: controller.signal });
    ctx.waitUntil(flight.then(r => r.arrayBuffer()).catch(() => undefined));
    await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    return Response.json({ cancelled: controller.signal.aborted });
  } };`;
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
