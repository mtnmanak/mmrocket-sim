import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { unstable_startWorker } from 'wrangler';
import {
  APP_VERSION, CURVES_GENERATED, MOTORS_GENERATED, describeFile, jsXmlParser, setXmlParser, type DescribeFileResult,
} from '../../app/src/headless/index.js';
import { decodeShareFragment, MAX_INFLATED_BYTES, SHARE_TOO_LARGE_ERROR_NAME } from '../../app/src/services/shareLink.js';
import { motorFreeOrk, motorFreeProjection } from '../../app/src/services/describeFile.js';
import { openHeadlessDesign, planHeadlessImport } from '../../app/src/services/simulateFile.js';
import { autoBody, bytesOf, clusterBody, orkOf, rktWithMotor, stampOf } from './fixtures.testSupport.js';

/**
 * S3 DRAFT: POST /describe in real local workerd. Every expected figure is the
 * same describeFile run afresh in this Node host (cross-runtime parity), never
 * a pinned number. The tester corpus is local-only and is not run here.
 */
type LocalWorker = Awaited<ReturnType<typeof unstable_startWorker>>;
type Described = Omit<DescribeFileResult, 'fragment'> & {
  experimental: true; api: string; appVersion: string; fragment: string; link: string;
  engine: { openRocket: string; appVersion: string }; catalogue: { motorsGenerated: string; curvesGenerated: string };
};
const APP_URL = 'https://mmrsim.mountainmanrockets.com';
const FIXTURES = [['reference.ork', 'ork'], ['rocksimTestRocket1.rkt', 'rkt'], ['Show-off.CDX1', 'cdx1']] as const;
let normal: LocalWorker | undefined;
let trapped: LocalWorker | undefined;
/** /health's own stamp keys: every error body carries them beside `error`. */
let STAMP: ReturnType<typeof stampOf>;

beforeAll(async () => {
  process.env['WRANGLER_SEND_METRICS'] = 'false';
  process.env['WRANGLER_HIDE_BANNER'] = 'true';
  process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
  process.env['WRANGLER_LOG_PATH'] = fileURLToPath(new URL('../.wrangler/test.log', import.meta.url));
  process.env['XDG_CONFIG_HOME'] = fileURLToPath(new URL('../.wrangler/config', import.meta.url));
  const { unstable_startWorker: start } = await import('wrangler');
  const options = {
    config: fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    dev: { remote: false, persist: false, watch: false, inspector: false,
      server: { hostname: '127.0.0.1', port: 0 }, logLevel: 'error' },
  };
  normal = await start(options);
  await normal.ready;
  trapped = await start({ ...options,
    entrypoint: fileURLToPath(new URL('./trappedWorker.testSupport.ts', import.meta.url)) });
  await trapped.ready;
  STAMP = stampOf(await (await normal.fetch('http://local/health')).json());
  setXmlParser(jsXmlParser);
});
afterAll(async () => { await Promise.all([normal?.dispose(), trapped?.dispose()]); });

const post = (worker: LocalWorker, name: string, body: Uint8Array | string, query = '') =>
  worker.fetch(`http://local/describe?filename=${encodeURIComponent(name)}${query}`, { method: 'POST', body });
async function described(worker: LocalWorker, name: string, body: Uint8Array, query = ''): Promise<Described> {
  const response = await post(worker, name, body, query);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return await response.json() as Described;
}
// The same tolerance the S1 parity tests use for non-time quantities: workerd's Math may part from Node's in
// the last bits (README); only arithmetic results (areas, bores, counts) are compared exactly.
const close = (actual: number | null, expected: number | null) => {
  if (expected === null) { expect(actual).toBeNull(); return; }
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(1e-10 * Math.max(1, Math.abs(expected)));
};
async function sameAsNode(out: Described, node: DescribeFileResult) {
  const a = out.analysis, b = node.analysis;
  expect({ ...a, lengthM: 0, referenceDiameterM: 0, dryMassKg: 0, dryCgM: 0, cpM: 0, stabilityCalibers: 0,
    cdEstimate: { ...a.cdEstimate, value: 0, referenceAreaM2: 0 } }).toEqual({ ...b, lengthM: 0, referenceDiameterM: 0,
    dryMassKg: 0, dryCgM: 0, cpM: 0, stabilityCalibers: 0, cdEstimate: { ...b.cdEstimate, value: 0, referenceAreaM2: 0 } });
  for (const key of ['lengthM', 'referenceDiameterM', 'dryMassKg', 'dryCgM', 'cpM', 'stabilityCalibers'] as const) close(a[key], b[key]);
  close(a.cdEstimate.value, b.cdEstimate.value);
  close(a.cdEstimate.referenceAreaM2, b.cdEstimate.referenceAreaM2);
  expect(out.mounts).toEqual(node.mounts);
  expect(out.notes).toEqual(node.notes);
  // Deflate output may differ between runtimes; the design it carries must not.
  expect(await decodeShareFragment(out.fragment)).toBe(await decodeShareFragment(node.fragment));
}

describe('S3 draft POST /describe in real workerd', () => {
  it.each(FIXTURES)('%s: draft schema, version stamps, SI basis and Node parity', async (name, format) => {
    const body = bytesOf(name);
    const out = await described(normal!, name, body);
    expect(Object.keys(out).sort()).toEqual(['analysis', 'api', 'appVersion', 'catalogue', 'engine', 'experimental',
      'fragment', 'link', 'mounts', 'name', 'notes', 'sourceFormat'].sort());
    expect({ experimental: out.experimental, api: out.api, sourceFormat: out.sourceFormat }).toEqual({ experimental: true, api: 's3-draft', sourceFormat: format });
    const health = await (await normal!.fetch('http://local/health')).json() as Record<string, unknown>;
    expect({ appVersion: out.appVersion, engine: out.engine, catalogue: out.catalogue })
      .toEqual({ appVersion: health['appVersion'], engine: health['engine'], catalogue: health['catalogue'] });
    expect(out.appVersion).toBe(APP_VERSION);
    expect(out.catalogue).toEqual({ motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED });
    expect(out.analysis.basis).toBe('dry; no installed motors');
    expect(out.link).toBe(APP_URL + out.fragment);
    expect(out.fragment).toMatch(/^#d=1\.[A-Za-z0-9_-]+$/);
    expect(Object.keys(out.mounts[0]!).sort()).toEqual(['count', 'diameterM', 'key', 'maxMotorLengthM', 'name', 'stageIndex', 'stageName']);
    await sameAsNode(out, await describeFile(body, name));
  });

  it('describes motorless, unmatched and clustered designs without a flight', async () => {
    const reference = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
    const bodies = {
      'motorless.ork': orkOf(reference.replace(/<motor configid[\s\S]*?<\/motor>/, '')),
      'unmatched.rkt': rktWithMotor('Z99999-NOPE', 'XX', 5),
      'cluster.ork': clusterBody(),
    };
    for (const [name, body] of Object.entries(bodies)) {
      const out = await described(normal!, name, body);
      await sameAsNode(out, await describeFile(body, name));
      if (name === 'cluster.ork') expect(out.mounts[0]!.count).toBe(4);
    }
  });

  it('ignores unknown query options: they cannot enable network or change the analysis', async () => {
    const body = bytesOf('reference.ork');
    const plain = await described(trapped!, 'reference.ork', body);
    const options = await described(trapped!, 'reference.ork', body, '&network=allow&motor=123&mach=2&aoa=0.1&delay=auto&src=https://example.invalid/x');
    expect(options).toEqual(plain);
  });

  it('arms the fetch trap, then describes every format without attempting fetch or scheduling a timer', async () => {
    const probe = await trapped!.fetch('http://local/__test/probe-fetch-trap');
    expect(await probe.json()).toMatchObject({ trapped: true });
    for (const [name] of FIXTURES) {
      const response = await post(trapped!, name, bytesOf(name), '&network=allow');
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('x-test-fetch-attempts')).toBe('0');
      expect(response.headers.get('x-test-timer-calls')).toBe('0');
    }
  });

  it('the same bytes give the same complete JSON and fragment around unrelated requests in one isolate', async () => {
    const show = bytesOf('Show-off.CDX1');
    const first = await described(trapped!, 'Show-off.CDX1', show);
    await described(trapped!, 'rocksimTestRocket1.rkt', bytesOf('rocksimTestRocket1.rkt'));
    expect((await trapped!.fetch('http://local/experimental/fly?filename=reference.ork', { method: 'POST', body: bytesOf('reference.ork') })).status).toBe(200);
    await described(trapped!, 'cluster.ork', clusterBody());
    expect(await described(trapped!, 'Show-off.CDX1', show)).toEqual(first);
  });

  it('overlapping describes and flights each get their own answer', async () => {
    const solo = await described(normal!, 'Show-off.CDX1', bytesOf('Show-off.CDX1'));
    // An auto-delay flight (several probes in one kernel turn) between them. Lock ordering itself is
    // proven deterministically in describeFile.test.ts; here each answer must still be its own.
    const auto = await autoBody();
    const responses = await Promise.all([
      post(normal!, 'Show-off.CDX1', bytesOf('Show-off.CDX1')),
      normal!.fetch('http://local/experimental/fly?filename=auto.rkt', { method: 'POST', body: auto }),
      post(normal!, 'reference.ork', bytesOf('reference.ork')),
      normal!.fetch('http://local/experimental/fly?filename=reference.ork', { method: 'POST', body: bytesOf('reference.ork') }),
      post(normal!, 'Show-off.CDX1', bytesOf('Show-off.CDX1')),
    ]);
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(200);
    const [a, , ref, , b] = await Promise.all(responses.map(r => r.json())) as Described[];
    expect(a).toEqual(solo);
    expect(b).toEqual(solo);
    await sameAsNode(ref!, await describeFile(bytesOf('reference.ork'), 'reference.ork'));
  });

  it('a refused build is 422 and releases the kernel for the next request', async () => {
    const refused = await trapped!.fetch('http://local/__test/describe-build-failure', { method: 'POST', body: bytesOf('reference.ork') });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ ...STAMP, error: { code: 'DESIGN_BUILD_FAILED', message: expect.stringContaining('Test-only kernel build refusal'),
      importNote: expect.objectContaining({ text: expect.stringContaining('Reference Rocket'), severity: expect.any(String) }) } });
    await described(trapped!, 'reference.ork', bytesOf('reference.ork'));
  });

  it('returns 503 with retry guidance when a dead holder poisons the kernel', async () => {
    const response = await trapped!.fetch('http://local/__test/dead-kernel?route=describe', { method: 'POST', body: bytesOf('reference.ork') });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'KERNEL_UNAVAILABLE', message: expect.stringMatching(/retry/i) } });
  }, 60_000);

  it.each([
    ['/describe', 'GET', 405, 'METHOD_NOT_ALLOWED'],
    ['/describe', 'PUT', 405, 'METHOD_NOT_ALLOWED'],
    ['/describe', 'POST', 400, 'FILENAME_REQUIRED'],
    ['/describe?filename=%20', 'POST', 400, 'FILENAME_REQUIRED'],
    ['/describe?filename=empty.ork', 'POST', 400, 'EMPTY_FILE'],
    ['/describe/extra', 'POST', 404, 'NOT_FOUND'],
    ['/simulate', 'POST', 404, 'NOT_FOUND'],
  ] as const)('%s %s returns %s %s', async (path, method, status, code) => {
    const response = await normal!.fetch(`http://local${path}`, { method });
    expect(response.status).toBe(status);
    if (status === 405) expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({ ...STAMP, error: { code, message: expect.any(String) } });
  });

  it('keeps the importer\'s own explanation for a file it cannot read, without a stack', async () => {
    const response = await post(normal!, 'bad.ork', 'not a rocket');
    expect(response.status).toBe(400);
    const result = await response.json() as { error: { code: string; message: string } };
    expect(result).toEqual({ ...STAMP, error: { code: 'INVALID_FILE', message: expect.stringMatching(/Could not open that \.ork file: .+/) } });
    expect(JSON.stringify(result)).not.toMatch(/\n\s+at |"stack"/);
  });

  it('applies the body, streamed, inflated and XML-structure caps exactly as the flight does', async () => {
    const declared = await trapped!.fetch('http://local/__test/declared-oversize?route=describe');
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE', message: expect.stringMatching(/8 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    const streamed = await trapped!.fetch('http://local/__test/streamed-cap?route=describe');
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get('x-test-reader-cancelled')).toBe('true');
    expect(streamed.headers.get('x-test-bytes-read')).toBe(String(8 * 1024 * 1024 + 1));
    const inflated = await post(normal!, 'large.ork', zipSync({ 'rocket.ork': new Uint8Array(16 * 1024 * 1024 + 1) }));
    expect(inflated.status).toBe(413);
    expect(await inflated.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE', message: expect.stringMatching(/16 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    const internal = await trapped!.fetch('http://local/__test/body-error?route=describe');
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ ...STAMP, error: { code: 'INTERNAL_ERROR', message: 'The design could not be described.' } });
    for (const payload of ['<x/>'.repeat(50_000), '<x>'.repeat(63) + '</x>'.repeat(63)]) {
      const structure = await post(normal!, 'structure.ork', `<openrocket><rocket>${payload}</rocket></openrocket>`);
      expect(structure.status).toBe(413);
      expect(await structure.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE', message: expect.stringMatching(/XML.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    }
  });

  // A long part comment survives import and export, and the upload stays far inside the 8 MiB body,
  // 16 MiB inflate and XML structure caps. 'x'.repeat passes the share link's 4 MiB XML cap; pseudo-random
  // URL-safe text under 4 MiB of XML deflates past the 1,048,576-character fragment cap instead.
  const noise = (length: number) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let seed = 1;
    return Array.from({ length }, () => alphabet[(seed = (seed * 48271) % 2147483647) % 64]).join('');
  };
  it.each([
    ['XML bytes', () => 'x'.repeat(4 * 1024 * 1024 + 1), true],
    ['fragment characters', () => noise(2 * 1024 * 1024), false],
  ] as const)('a design past the share link\'s %s limit is 413 LINK_TOO_LARGE with no partial result', async (_kind, comment, overXml) => {
    const reference = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
    const xml = reference.replace('<name>Nose Cone</name>', `<name>Nose Cone</name><comment>${comment()}</comment>`);
    expect(xml).not.toBe(reference);
    const body = zipSync({ 'rocket.ork': strToU8(xml) });
    expect(body.byteLength).toBeLessThan(8 * 1024 * 1024);
    // Which cap the Node oracle meets: the projection's written XML is over or under the 4 MiB XML cap.
    const opened = (await planHeadlessImport(await openHeadlessDesign(body, 'long.ork', { network: 'forbid' }), { network: 'forbid' })).snapshot;
    expect(strToU8(motorFreeOrk(motorFreeProjection(opened))).byteLength > MAX_INFLATED_BYTES).toBe(overXml);
    await expect(describeFile(body, 'long.ork')).rejects.toMatchObject({ name: SHARE_TOO_LARGE_ERROR_NAME });
    const response = await post(normal!, 'long.ork', body);
    expect(response.status).toBe(413);
    const result = await response.json() as Record<string, unknown>;
    expect(result).toEqual({ ...STAMP, error: { code: 'LINK_TOO_LARGE', message: expect.stringMatching(/share link.*4 MiB.*1,048,576.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
  });

  it('leaves /health and the flight route unchanged', async () => {
    const health = await normal!.fetch('http://local/health');
    expect(await health.json()).toMatchObject({ ok: true, api: 's1' });
    const flight = await normal!.fetch('http://local/experimental/fly?filename=reference.ork', { method: 'POST', body: bytesOf('reference.ork') });
    expect(flight.status).toBe(200);
    expect(await flight.json()).toMatchObject({ experimental: true, outcome: 'completed' });
  });
});
