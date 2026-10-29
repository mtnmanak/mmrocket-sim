import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { TEST_KEY, TEST_KEYS } from './auth.testSupport.js';

type Reply = { status: number; code: string; retryAfter: string | null };
type Batch = { start: number; end: number; unauthorised: Reply[]; accepted: Reply[]; limited: Reply };

it('the real local binding permits twenty authenticated requests and refuses the twenty-first', async () => {
  process.env['WRANGLER_SEND_METRICS'] = 'false';
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'rate-limit-harness.ts', contents: `
      import worker from './index.ts';
      globalThis.fetch = () => { throw new Error('Outbound fetch is forbidden in this test.'); };
      export default { async fetch(_request, env, ctx) {
        const epoch = () => Math.floor(Date.now() / 60_000);
        const start = epoch();
        const run = async authorization => {
          const response = await worker.fetch(new Request('http://local/describe?filename=empty.ork', {
            method: 'POST', headers: authorization ? { Authorization: authorization } : {},
          }), env, ctx);
          return { status: response.status, code: (await response.json()).error.code,
            retryAfter: response.headers.get('Retry-After') };
        };
        const unauthorised = [await run(), await run(${JSON.stringify(`Bearer ${TEST_KEY}-invalid`)})];
        const accepted = [];
        for (let i = 0; i < 20; i++) accepted.push(await run(${JSON.stringify(`Bearer ${TEST_KEY}`)}));
        const limited = await run(${JSON.stringify(`Bearer ${TEST_KEY}`)});
        return Response.json({ start, end: epoch(), unauthorised, accepted, limited });
      } };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'], logLevel: 'silent',
  });
  // The installed binding uses wall-clock-aligned windows. Repeat with fresh storage only
  // if this short batch straddles a minute; a denial is never treated as a skipped test.
  let batch: Batch | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
      modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate,
      bindings: { API_KEYS: TEST_KEYS },
      ratelimits: { RATE_LIMITER: { namespace_id: String(1001 + attempt), simple: { limit: 20, period: 60 } } },
    }));
    try {
      await mf.ready;
      const response = await mf.dispatchFetch('http://local/__test/rate-limit');
      expect(response.status, await response.clone().text()).toBe(200);
      batch = await response.json() as Batch;
      if (batch.start === batch.end) break;
    } finally { await mf.dispose(); }
  }
  expect(batch!.start, 'the batch must finish inside one real binding window').toBe(batch!.end);
  expect(batch!.unauthorised).toEqual([
    { status: 401, code: 'API_KEY_REQUIRED', retryAfter: null },
    { status: 401, code: 'API_KEY_INVALID', retryAfter: null },
  ]);
  expect(batch!.accepted).toEqual(Array.from({ length: 20 }, () => ({ status: 400, code: 'EMPTY_FILE', retryAfter: null })));
  expect(batch!.limited).toEqual({ status: 429, code: 'RATE_LIMITED', retryAfter: '60' });
});
