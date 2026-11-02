import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { TEST_KEY, TEST_KEYS } from './auth.testSupport.js';
import { bytesOf } from './fixtures.testSupport.js';

it('real workerd grows in place, supports consumers, and admits a 6 MiB design with same-key bytes held', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'growth-harness.ts', contents: `
      import { readBody, BodyReservation, reservedBodyBytes } from './body.ts';
      import { worker } from './index.ts';
      export default { async fetch() {
        const small = new BodyReservation();
        const large = new BodyReservation();
        const MiB = 1024 * 1024;
        const stream = bytes => new ReadableStream({ start(c) {
          c.enqueue(bytes.subarray(0, 4 * MiB));
          c.enqueue(bytes.subarray(4 * MiB)); c.close();
        } });
        const request = bytes => new Request('http://local', {
          method: 'POST', body: stream(bytes), duplex: 'half',
        });
        let peak = 0;
        const reserve = large.reserve.bind(large);
        large.reserve = bytes => { reserve(bytes); peak = Math.max(peak, reservedBodyBytes()); };
        try {
          const smallBuffer = await readBody(new Request('http://local', { method: 'POST', body: 'held' }),
            small, performance.now() + 30000, 'test');
          const input = new Uint8Array(8 * MiB).fill(65);
          const grown = await readBody(request(input), large, performance.now() + 30000, 'test');
          const decoded = new TextDecoder().decode(grown);
          const blob = new Uint8Array(await new Blob([grown]).arrayBuffer());
          const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',');
          const consumers = decoded.length === input.length && !/[^A]/.test(decoded)
            && blob.length === input.length && blob.every(b => b === 65)
            && await digest(grown) === await digest(input);
          const maxByteLength = grown.maxByteLength;
          large.release();
          const xml = new TextDecoder().decode(new Uint8Array(${JSON.stringify([...bytesOf('rocksimTestRocket1.rkt')])}));
          const design = new TextEncoder().encode(xml + ' '.repeat(6 * MiB - new TextEncoder().encode(xml).length));
          const upload = new Request('http://local/describe?filename=large.rkt', {
            method: 'POST', headers: { Authorization: ${JSON.stringify('Bearer ' + TEST_KEY)} },
            body: stream(design), duplex: 'half',
          });
          const response = await worker.fetch(upload, { API_KEYS: ${JSON.stringify(TEST_KEYS)},
            RATE_LIMITER: { async limit() { return { success: true }; } } }, { waitUntil() {} });
          return Response.json({ peak, consumers, maxByteLength, status: response.status,
            held: reservedBodyBytes(), smallLength: smallBuffer.byteLength });
        } finally { small.release(); large.release(); }
      } };
    ` }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate,
  }));
  try {
    const response = await mf.dispatchFetch('http://local');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ peak: 8 * 1024 * 1024 + 4, consumers: true,
      maxByteLength: 8 * 1024 * 1024, status: 200, held: 4, smallLength: 4 });
  } finally { await mf.dispose(); }
});

it('real workerd keeps half the capacity available when one key trickles to its byte cap', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'key-body-harness.ts', contents: `
      import { readBody, BodyReservation, reservedBodyBytes } from './body.ts';
      import { worker } from './index.ts';
      export default { async fetch() {
        const reservations = [new BodyReservation(), new BodyReservation()];
        const controllers = [];
        const reads = [];
        const MiB = 1024 * 1024;
        const waitFor = async bytes => {
          for (let i = 0; i < 100 && reservedBodyBytes() !== bytes; i++)
            await new Promise(resolve => setTimeout(resolve, 1));
          if (reservedBodyBytes() !== bytes) throw new Error('Unexpected held capacity: ' + reservedBodyBytes());
        };
        try {
          const start = i => reads.push(readBody(new Request('http://local', { method: 'POST',
            body: new ReadableStream({ start(c) { controllers[i] = c; } }), duplex: 'half',
          }), reservations[i], performance.now() + 30000, 'test'));
          start(0);
          controllers[0].enqueue(new Uint8Array(4 * MiB));
          await waitFor(4 * MiB);
          controllers[0].enqueue(new Uint8Array(4 * MiB));
          await waitFor(8 * MiB);
          start(1);
          controllers[1].enqueue(new Uint8Array(4 * MiB));
          await waitFor(12 * MiB);
          const calls = [];
          const env = { API_KEYS: ${JSON.stringify(TEST_KEYS)}, RATE_LIMITER: {
            async limit({ key }) { calls.push(key); return { success: true }; }
          } };
          const post = body => new Request('http://local/describe?filename=reference.ork', {
            method: 'POST', headers: { Authorization: ${JSON.stringify('Bearer ' + TEST_KEY)} }, body,
          });
          const busy = await worker.fetch(post('x'), env, { waitUntil() {} });
          const empty = post('');
          empty.headers.set('Content-Length', '0');
          const emptyResponse = await worker.fetch(empty, env, { waitUntil() {} });
          const other = await worker.fetch(post(new Uint8Array(${JSON.stringify([...bytesOf('reference.ork')])})),
            { ...env, API_KEYS: env.API_KEYS.replace('test:', 'other:') }, { waitUntil() {} });
          return Response.json({ held: reservedBodyBytes(), busy: busy.status, busyCode: (await busy.json()).error.code,
            emptyHasBody: empty.body !== null, empty: emptyResponse.status,
            emptyCode: (await emptyResponse.json()).error.code, other: other.status, calls });
        } finally {
          controllers.forEach(c => c.close());
          await Promise.allSettled(reads);
          reservations.forEach(r => r.release());
        }
      } };
    ` }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate,
  }));
  try {
    const response = await mf.dispatchFetch('http://local');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ held: 12 * 1024 * 1024, busy: 503, busyCode: 'SERVER_BUSY',
      emptyHasBody: true, empty: 400, emptyCode: 'EMPTY_FILE', other: 200, calls: ['refused:test', 'refused:test', 'other'] });
  } finally { await mf.dispose(); }
});

it('real workerd shrinks three concurrent 6 MiB uploads without a handoff allocation', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)![1]!;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'body-harness.ts', contents: `
      import { readBody, BodyReservation, reservedBodyBytes } from './body.ts';
      export default { async fetch() {
        const reservations = Array.from({ length: 3 }, () => new BodyReservation());
        const controllers = [];
        const reads = reservations.map((reservation, i) => readBody(new Request('http://local', {
          method: 'POST', body: new ReadableStream({ start(c) {
            controllers.push(c); c.enqueue(new Uint8Array(6 * 1024 * 1024));
          } }), duplex: 'half',
        }), reservation, performance.now() + 30000, 'key-' + i));
        try {
          await new Promise(resolve => setTimeout(resolve, 0));
          const before = reservedBodyBytes();
          controllers[0].close();
          const first = await reads[0];
          const afterFirst = reservedBodyBytes();
          controllers[1].close(); controllers[2].close();
          const bodies = await Promise.all(reads);
          return Response.json({ before, afterFirst, lengths: bodies.map(b => b.byteLength),
            resizable: first.resizable, after: reservedBodyBytes() });
        } finally { reservations.forEach(r => r.release()); }
      } };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), cf: false,
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate,
  }));
  try {
    const response = await mf.dispatchFetch('http://local');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ before: 18 * 1024 * 1024, afterFirst: 18 * 1024 * 1024,
      lengths: [6, 6, 6].map(n => n * 1024 * 1024), resizable: true, after: 18 * 1024 * 1024 });
  } finally { await mf.dispose(); }
});
