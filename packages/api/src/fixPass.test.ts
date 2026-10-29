import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { bytesOf } from './fixtures.testSupport.js';

let mf: Miniflare;
beforeAll(async () => {
  const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    .match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'fix-pass-harness.ts', contents: `
      import { authenticatedWorker } from './auth.testSupport.ts';
      import { reservedBodyBytes } from './body.ts';
      globalThis.fetch = () => { throw new Error('Outbound fetch is forbidden.'); };
      export default { async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/__budget') return Response.json({ reserved: reservedBodyBytes() });
        const response = await authenticatedWorker.fetch(request, undefined, ctx);
        return Response.json({ status: response.status, body: await response.json(), reserved: reservedBodyBytes() });
      } };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['browser'],
    mainFields: ['browser', 'module', 'main'], logLevel: 'silent',
    plugins: [{ name: 'short-upload-deadline', setup(bundler) {
      bundler.onLoad({ filter: /[\\/]src[\\/]index\.ts$/ }, args => {
        if (!args.path.replaceAll('\\', '/').endsWith('/packages/api/src/index.ts')) return undefined;
        return { contents: readFileSync(args.path, 'utf8').replaceAll('started + 30_000', 'started + 100'), loader: 'ts' };
      });
    } }],
  });
  const relay = `export default { async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/__deadline') return env.TARGET.fetch(request);
    // A service-binding request body becomes a real internal workerd stream.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const writing = writer.write(new Uint8Array([1])).catch(() => undefined);
    ctx.waitUntil(writing);
    try {
      return await env.TARGET.fetch('http://local/describe?filename=slow.ork', { method: 'POST', body: readable });
    } finally {
      ctx.waitUntil(writer.abort().catch(() => undefined));
    }
  } };`;
  mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
    workers: [
      { name: 'relay', modules: true, script: relay, compatibilityDate, serviceBindings: { TARGET: 'target' } },
      { name: 'target', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate },
    ],
  }));
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); });

it('real workerd request-stream deadline returns 408 BODY_TIMEOUT and returns reservations', async () => {
  const response = await mf.dispatchFetch('http://local/__deadline');
  expect(await response.json()).toMatchObject({ status: 408, body: { error: { code: 'BODY_TIMEOUT' } }, reserved: 0 });
  expect(await (await mf.dispatchFetch('http://local/__budget')).json()).toEqual({ reserved: 0 });
});

it.each(['/describe', '/experimental/fly'])('%s removes file CR/LF/TAB from motor and component notes in workerd', async route => {
  const hostile = 'UNKNOWN&#13;INJECT&#10;FAKE&#9;TAB';
  const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
    .replace('<designation>C6</designation>', '<designation>' + hostile + '</designation>')
    .replace('<name>Inner Tube</name>', '<name>PART' + hostile + '</name>')
    // A zero-density component guarantees its name is echoed in an import note.
    .replace(/<material ([^>]*)density="[^"]*"/, '<material $1density="0"')
    .replace('<name>Nose Cone</name>', '<name>COMPONENT' + hostile + '</name>');
  const response = await mf.dispatchFetch('http://local' + route + '?filename=hostile.ork', { method: 'POST', body: xml });
  const result = await response.json() as { status: number; body: {
    error?: { importNote: { text: string; group: { lines: { text: string }[] } } };
    notes?: { import: { text: string; group?: { lines: { text: string }[] } } };
  }; reserved: number };
  expect(result.status, JSON.stringify(result)).toBe(route === '/describe' ? 200 : 422);
  const note = result.body.error?.importNote ?? result.body.notes!.import;
  expect(note.text).toContain('UNKNOWNINJECTFAKE TAB');
  expect(note.text).toContain('COMPONENTUNKNOWNINJECTFAKE TAB');
  expect(note.text).not.toMatch(/[\r\t]/);
  expect(note.text).toContain('Loaded \u201cReference Rocket\u201d.\n');
  expect(note.text).not.toContain('INJECT\nFAKE');
  for (const line of note.group?.lines ?? []) expect(line.text).not.toMatch(/[\r\n\t]/);
  expect(result.reserved).toBe(0);
});

it.each(['/describe', '/experimental/fly'])('%s cleans manufacturer and designation before upstream splitting in workerd', async route => {
  const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
    .replace(/<manufacturer>[^<]*<\/manufacturer>/g, '<manufacturer>OTHER&#10;FAKE&#13;&#9;TAB</manufacturer>')
    .replace('<designation>C6</designation>', '<designation>C&#10;6</designation>');
  const response = await mf.dispatchFetch('http://local' + route + '?filename=controls.ork', { method: 'POST', body: xml });
  const result = await response.json() as { status: number; body: { notes: { import: { text: string } } }; reserved: number };
  expect(result.status, JSON.stringify(result)).toBe(200);
  expect(result.body.notes.import.text).toContain('OTHERFAKE TAB');
  expect(result.body.notes.import.text).toContain('Motor \u201cC6\u201d');
  expect(result.body.notes.import.text).not.toMatch(/OTHER\nFAKE|C\n6|[\r\t]/);
  expect(result.reserved).toBe(0);
});
