import { gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { unstable_startWorker } from 'wrangler';
import {
  APP_VERSION, CURVES_GENERATED, MOTORS_GENERATED,
  commentsOf, jsXmlParser, mountMotorCount, mountNamesOf, motorMounts, resolveFlightState, setXmlParser, simulateFile,
} from '../../app/src/headless/index.js';
import { boosterBranches } from '@online-openrocket/engine';
import {
  autoBody, bytesOf, clusterBody, missingCurveBody, rktWithMotor, secondaryBody, stampOf, timeStepBody, unbundledDigestCase,
} from './fixtures.testSupport.js';
import { SNAPSHOT_ADDED } from './snapshotOverlay.testSupport.js';
import { API_XML_LIMITS } from './xmlLimits.js';

/** The API's DOM budgets, as its refusals word them: elements, and nodes at the gate's x4 default. */
const MAX_ELEMENTS = API_XML_LIMITS.maxElements;
const MAX_NODES = MAX_ELEMENTS * 4;
const count = (n: number) => n.toLocaleString('en-US');

type LocalWorker = Awaited<ReturnType<typeof unstable_startWorker>>;
interface FlightResponse {
  experimental: boolean;
  appVersion: string;
  partial: boolean;
  outcome: 'completed' | 'aborted' | 'incomplete';
  aborts: { reason: string; event: { type: string; time: number; cause?: string } }[];
  motorFailures: { mount: string; text: string }[];
  apogeeM: number;
  maxVelocityMs: number;
  maxMach: number;
  flightTimeS: number;
  motors: { mount: string; manufacturer: string; designation: string; count: number; delayS: number | 'plugged' }[];
  warnings: { message: string }[];
  notes: { api: string[]; import: { text: string; group: { lines: { text: string }[] } }; padMass: unknown; flight: unknown[] };
  timing: { basis: string; parseMs: number; flyMs: number; totalMs: number };
}
const FIXTURES = ['reference.ork', 'TubeFins2.rkt', 'Show-off.CDX1'] as const;
const INCOMPLETE_FILE = new URL('../../../docs/User files/TRF RASAero Files/SS Wild Bash 20260623v0.rkt', import.meta.url);
let normal: LocalWorker | undefined;
let trapped: LocalWorker | undefined;
let overlay: LocalWorker | undefined;
/** /health's own stamp keys: every error body carries them beside `error`. */
let STAMP: ReturnType<typeof stampOf>;
const previews: { fixture: string; phase: string; hostElapsedMs: number; parseMs: number; flyMs: number; totalMs: number }[] = [];

beforeAll(async () => {
  // Local-only, no telemetry, update banner, remote bindings, persistence or inspector.
  process.env['WRANGLER_SEND_METRICS'] = 'false';
  process.env['WRANGLER_HIDE_BANNER'] = 'true';
  process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
  process.env['WRANGLER_LOG_PATH'] = fileURLToPath(new URL('../.wrangler/test.log', import.meta.url));
  process.env['XDG_CONFIG_HOME'] = fileURLToPath(new URL('../.wrangler/config', import.meta.url));
  const { unstable_startWorker: start } = await import('wrangler');
  const options = {
    config: fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    entrypoint: fileURLToPath(new URL('./authenticatedWorker.testSupport.ts', import.meta.url)),
    dev: { remote: false, persist: false, watch: false, inspector: false,
      server: { hostname: '127.0.0.1', port: 0 }, logLevel: 'error' },
  };
  normal = await start(options);
  await normal.ready;
  trapped = await start({ ...options,
    entrypoint: fileURLToPath(new URL('./trappedWorker.testSupport.ts', import.meta.url)) });
  await trapped.ready;
  overlay = await start({ ...options,
    entrypoint: fileURLToPath(new URL('./overlayWorker.testSupport.ts', import.meta.url)) });
  await overlay.ready;
  STAMP = stampOf(await (await normal.fetch('http://local/health')).json());
  setXmlParser(jsXmlParser);
});
afterAll(async () => {
  await Promise.all([normal?.dispose(), trapped?.dispose(), overlay?.dispose()]);
  writeFileSync(new URL('../.wrangler/timing-previews.json', import.meta.url), JSON.stringify(previews, null, 2));
});

describe('S1 in real workerd', () => {
  it.skipIf(!existsSync(INCOMPLETE_FILE))('marks a time-capped descent incomplete without inventing an abort event', async () => {
    const response = await normal!.fetch('http://local/experimental/fly?filename=slow-descent.rkt',
      { method: 'POST', body: new Uint8Array(readFileSync(INCOMPLETE_FILE)) });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as FlightResponse;
    expect(result.warnings.some(w => /flight is incomplete/.test(w.message))).toBe(true);
    expect(result.aborts).toEqual([]);
    expect(result.outcome).toBe('incomplete');
    expect(result.partial).toBe(true);
  }, 60_000);
  it('returns 503 with retry guidance when a dead holder poisons the kernel', async () => {
    const response = await trapped!.fetch('http://local/__test/dead-kernel',
      { method: 'POST', body: bytesOf('reference.ork') });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'KERNEL_UNAVAILABLE',
      message: expect.stringMatching(/previous flight.*stopped part-way.*retry/i) } });
  }, 60_000);

  it.each([['ork', 'zip'], ['ork', 'gzip'], ['rkt', 'zip'], ['rkt', 'gzip'], ['CDX1', 'zip'], ['CDX1', 'gzip']] as const)(
    'rejects oversized inflated %s XML in %s as 413', async (extension, compression) => {
      const xml = new Uint8Array(16 * 1024 * 1024 + 1);
      const body = compression === 'zip' ? zipSync({ ['rocket.' + extension]: xml }) : gzipSync(xml);
      const response = await normal!.fetch('http://local/experimental/fly?filename=large.' + extension,
        { method: 'POST', body });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE',
        message: expect.stringMatching(/16 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    });

  it('bounds a long hostile filename echoed in a refusal, through the local dev proxy', async () => {
    // About 4,000 characters: NUL, ESC and RLO up front, an astral character, a .ork tail.
    const name = '\u0000\u001b\u202e' + 'a'.repeat(179) + '\u{1f680}' + 'b'.repeat(3_800) + '-final.ork';
    // The inflated-XML refusal keeps the upload small.
    const body = zipSync({ 'rocket.ork': new Uint8Array(16 * 1024 * 1024 + 1) });
    const response = await normal!.fetch(`http://local/experimental/fly?filename=${encodeURIComponent(name)}`,
      { method: 'POST', body });
    const result = await response.json() as { error: { code: string; message: string } };
    expect(response.status, JSON.stringify(result)).toBe(413);
    expect(result.error.code).toBe('FILE_TOO_LARGE');
    const { message } = result.error;
    expect(message).toMatch(/16 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/);
    const echo = message.slice(0, message.indexOf(': '));
    expect(Array.from(echo).length).toBeLessThanOrEqual(200);
    expect(echo).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
    expect(echo).not.toMatch(/[\ud800-\udfff]/u);
    expect(echo).toContain('\u{1f680}');
    expect(echo.endsWith('.ork')).toBe(true);
  });

  it.each([
    ['elements', '<x/>'.repeat(MAX_ELEMENTS), `XML element limit is ${count(MAX_ELEMENTS)}.`],
    ['depth', '<x>'.repeat(63) + '</x>'.repeat(63), 'XML nesting limit is 64.'],
    ['comments', '<!---->'.repeat(MAX_NODES), `XML node limit is ${count(MAX_NODES)}.`],
    ['processing instructions', '<?a?>'.repeat(MAX_NODES), `XML node limit is ${count(MAX_NODES)}.`],
    ['text siblings', 'x<!---->'.repeat(MAX_NODES / 2), `XML node limit is ${count(MAX_NODES)}.`],
    ['attributes', '<x ' + Array.from({ length: MAX_NODES }, (_, i) => `a${i}=""`).join(' ') + '/>', `XML node limit is ${count(MAX_NODES)}.`],
  ])('refuses excessive XML %s as JSON inside workerd', async (_kind, payload, limit) => {
    const response = await normal!.fetch('http://local/experimental/fly?filename=structure.ork',
      { method: 'POST', body: `<openrocket><rocket>${payload}</rocket></openrocket>` });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE',
      message: `structure.ork: ${limit} Use https://mmrsim.mountainmanrockets.com for larger files.` } });
  });

  it.each([0.005, 0.01, 0.05, 0.1])('flies an own-file step of %s s with the API floor and reports any change', async step => {
    const body = timeStepBody(step);
    const node = await simulateFile(body, 'step.ork', { reportSeries: 'summary', minTimeStepS: 0.05 });
    expect(node.run.timeStepS).toBe(Math.max(step, 0.05));
    const response = await normal!.fetch('http://local/experimental/fly?filename=step.ork',
      { method: 'POST', body });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as FlightResponse;
    // workerd and Node can part in the last bits, and a coarse step lets that move an event: compare at the
    // event-time tolerance, then prove the floor by distance — nearer the floored oracle than the file's own step.
    close(result.apogeeM, node.result.summary.maxAltitude, true);
    close(result.flightTimeS, node.result.summary.flightTime, true);
    if (step < 0.05) {
      const unfloored = await simulateFile(body, 'step.ork', { reportSeries: 'summary' });
      expect(unfloored.run.timeStepS).toBe(Math.max(step, 0.01));
      const floored = node.result.summary.maxAltitude, raw = unfloored.result.summary.maxAltitude;
      expect(raw).not.toBe(floored);
      expect(Math.abs(result.apogeeM - floored)).toBeLessThan(Math.abs(result.apogeeM - raw));
    }
    expect(result.notes.api).toEqual(step < 0.05
      ? ['This API flies at a time step of at least 0.05 s; in the app this design flies at 0.01 s.'] : []);
    for (const text of [result.notes.import.text, ...result.notes.import.group.lines.map(line => line.text)]) {
      expect(text).not.toContain('Flights here now use a 0.01 s');
    }
    if (step === 0.005) expect(result.notes.import.text).toMatch(/0\.005 s[\s\S]*0\.01 s/);
  }, 60_000);

  it('says when a desktop digest names no bundled curve, as the app\'s open words it', async () => {
    const { body, sentence } = await unbundledDigestCase();
    const response = await normal!.fetch('http://local/experimental/fly?filename=digest.ork', { method: 'POST', body });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json() as FlightResponse).notes.import.text).toContain(sentence);
  }, 60_000);

  it('accepts exactly 8 MiB at the body cap and parses the received bytes', async () => {
    const body = new Uint8Array(8 * 1024 * 1024);
    body.fill(32);
    const response = await normal!.fetch('http://local/experimental/fly?filename=boundary.ork', { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE' } });
  });

  it('/health identifies the actual app, public engine and bundled snapshots', async () => {
    const response = await normal!.fetch('http://local/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, api: 's1', appVersion: APP_VERSION,
      engine: { openRocket: '24.12', appVersion: APP_VERSION },
      catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it.each(FIXTURES)('%s matches plain Node and returns first/warm timing previews', async (name) => {
    const body = bytesOf(name);
    const node = await simulateFile(body, name, { network: 'forbid', reportSeries: 'summary' });
    for (const phase of ['first for fixture', 'warm repeat']) {
      const hostStarted = performance.now();
      const response = await normal!.fetch(`http://local/experimental/fly?filename=${encodeURIComponent(name)}`, { method: 'POST', body });
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json() as FlightResponse;
      expect(result.experimental).toBe(true);
      expect(result.appVersion).toBe(APP_VERSION);
      expect(result.apogeeM).toBeGreaterThan(0);
      expect(result.apogeeM).toBeLessThan(100_000);
      close(result.apogeeM, node.result.summary.maxAltitude);
      close(result.maxVelocityMs, node.result.summary.maxVelocity);
      close(result.maxMach, node.result.summary.maxMachNumber);
      close(result.flightTimeS, node.result.summary.flightTime, true);
      sameNumeric(result.motors, expectedMotors(node));
      const aborts = [node.result, ...boosterBranches(node.result)].flatMap(branch =>
        branch.events.filter(e => e.type === 'SIM_ABORT' || e.type === 'EXCEPTION')
          .map(({ sourceId: _sourceId, motorMountId: _motorMountId, ...event }) => event));
      const expectedOutcome = name === 'Show-off.CDX1' ? 'aborted' : 'completed';
      expect(result.outcome).toBe(expectedOutcome);
      sameNumeric(result.aborts.map(a => a.event), aborts);
      // Fixture outcomes are independent expectations; numeric comparisons still use the fresh Node oracle.
      expect(result.partial).toBe(name === 'Show-off.CDX1');
      expect(result.motorFailures).toEqual(expectedFailures(node));
      // A literal kernel warning from this fixture; independent of the formatter implementation.
      if (name === 'TubeFins2.rkt') expect(result.warnings.map(w => w.message)).toContain(
        'Airframe diameter steps abruptly — drag predictions suffer — : "Nose cone", "Forward Fuselage Tube"');
      expect(result.warnings.every(w => !w.message.includes(': :'))).toBe(true);
      expect(result.notes).toEqual({ api: [], import: node.importNote, padMass: node.padMassNote, flight: commentsOf(node.run) });
      expect(result.timing.basis).toContain('not CPU time');
      expect(result.timing.basis).toContain('local-only');
      const { basis: _basis, ...times } = result.timing;
      for (const value of Object.values(times)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(result.timing.totalMs + numericTolerance(result.timing.totalMs)).toBeGreaterThanOrEqual(result.timing.parseMs + result.timing.flyMs);
      const preview = { fixture: name, phase, hostElapsedMs: performance.now() - hostStarted, ...result.timing };
      previews.push(preview);
    }
  });

  it('arms the fetch trap, then flies all formats without even attempting fetch', async () => {
    const probe = await trapped!.fetch('http://local/__test/probe-fetch-trap');
    expect(await probe.json()).toEqual({ trapped: true, before: 0 });
    for (const name of FIXTURES) {
      const response = await trapped!.fetch(`http://local/experimental/fly?filename=${name}&network=allow`, { method: 'POST', body: bytesOf(name) });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('x-test-fetch-attempts')).toBe('0');
    }
  });

  it('the timer trap counts every macrotask source workerd offers', async () => {
    const probe = await trapped!.fetch('http://local/__test/probe-timer-trap');
    const { sources, counted } = await probe.json() as { sources: string[]; counted: Record<string, number> };
    // All four exist in the pinned local workerd; a lost wrapper or source fails here.
    expect(sources).toEqual(['setTimeout', 'setInterval', 'scheduler.wait', 'MessagePort.postMessage']);
    expect(Object.keys(counted).sort()).toEqual([...sources].sort());
    for (const source of sources) expect(counted[source], source).toBe(1);
  });

  it('auto-delay schedules only the upload deadline timer inside workerd', async () => {
    const body = await autoBody();
    const node = await simulateFile(body, 'auto.rkt', { reportSeries: 'summary' });
    expect(node.flight.delayResolution.probes).toBeGreaterThan(0);
    expect(node.flight.delayResolution.mounts.some(mount => mount.mode === 'auto')).toBe(true);
    const response = await trapped!.fetch('http://local/experimental/fly?filename=auto.rkt',
      { method: 'POST', body });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('x-test-timer-calls')).toBe('1');
    expect(response.headers.get('x-test-fetch-attempts')).toBe('0');
  });

  it('a caller cannot allow a missing bundled curve to trigger even a late fetch', async () => {
    const response = await overlay!.fetch('http://local/experimental/fly?filename=missing.rkt&network=allow',
      { method: 'POST', body: await missingCurveBody() });
    expect(response.status).toBe(422);
    expect(response.headers.get('x-test-fetch-attempts')).toBe('0');
    const body = await response.json() as { error: { code: string; importNote: { text: string } } };
    expect(body.error.code).toBe('NO_MOTOR');
    expect(body.error.importNote.text).toMatch(/thrust curve/);
  });

  it('under a curated-snapshot overlay with an added motor, the API still matches the shipped catalogue and asks nothing', async () => {
    // The headless matcher reads the shipped catalogue, not the overlay, so
    // the added motor is unknown here and its curves file is never asked for.
    const response = await overlay!.fetch('http://local/experimental/fly?filename=added.rkt&network=allow',
      { method: 'POST', body: rktWithMotor(SNAPSHOT_ADDED.designation, SNAPSHOT_ADDED.manufacturerAbbrev, 5) });
    expect(response.headers.get('x-test-fetch-attempts')).toBe('0');
    expect(response.status, await response.clone().text()).toBe(422);
    const body = await response.json() as { error: { code: string; importNote: { text: string } } };
    expect(body.error.code).toBe('NO_MOTOR');
    expect(body.error.importNote.text).toMatch(/Motor “C99” matched no motor in the motor database/);
  });

  it.each(['cluster', 'never', 'refused'] as const)('reports the actual %s loadout and build refusals', async kind => {
    const body = kind === 'cluster' ? clusterBody() : secondaryBody(kind);
    const node = await simulateFile(body, `${kind}.ork`, { network: 'forbid', reportSeries: 'summary' });
    const response = await normal!.fetch(`http://local/experimental/fly?filename=${kind}.ork`, { method: 'POST', body });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as FlightResponse;
    sameNumeric(result.motors, expectedMotors(node));
    if (kind === 'cluster') expect(result.motors.some(m => m.count > 1)).toBe(true);
    if (kind === 'never') {
      expect(node.flight.delayResolution.mounts).toHaveLength(2);
      expect(result.motors).toHaveLength(1);
    }
    if (kind === 'refused') {
      // The archive gate now refuses the out-of-range snapshot before build (U3),
      // that motor alone (C1: invalid captured EX motors are refused one by one;
      // indexGuards.test.ts holds the in-process worker to the same note).
      expect(node.build.motorFailures).toHaveLength(0);
      expect(result.motorFailures).toEqual([]);
      expect(node.importNote.text).toMatch(/Embedded EX motor Bad-C6 was not loaded: .*captured CG outside the motor/);
      expect(result.notes.import.text).toContain('Embedded EX motor Bad-C6 was not loaded');
      expect(node.importNote.text).not.toContain('Embedded EX motors were refused');
      expect(result.motors).toHaveLength(1);
      expect(result.motors.some(m => m.mount === 'Secondary mount')).toBe(false);
    }
  });

  it('keeps same-name bodies and interleaved/reversed designs independent', async () => {
    const bodies = [bytesOf('reference.ork'), clusterBody()];
    const oracles = await Promise.all(bodies.map(body => simulateFile(body, 'same.ork', { reportSeries: 'summary' })));
    expect(oracles[0]!.result.summary.maxAltitude).not.toBe(oracles[1]!.result.summary.maxAltitude);
    for (const index of [1, 0, 1, 0]) {
      const response = await trapped!.fetch('http://local/experimental/fly?filename=same.ork', { method: 'POST', body: bodies[index]! });
      const out = await response.json() as FlightResponse;
      close(out.apogeeM, oracles[index]!.result.summary.maxAltitude);
      sameNumeric(out.motors, expectedMotors(oracles[index]!));
    }
    for (const name of [...FIXTURES].reverse()) {
      const node = await simulateFile(bytesOf(name), name, { reportSeries: 'summary' });
      const response = await trapped!.fetch(`http://local/experimental/fly?filename=${name}`, { method: 'POST', body: bytesOf(name) });
      close((await response.json() as FlightResponse).apogeeM, node.result.summary.maxAltitude);
    }
  });

  it('concurrent requests retain each design\'s own oracle result (statelessness, not lock contention)', async () => {
    const bodies = [await autoBody(), bytesOf('reference.ork'), bytesOf('TubeFins2.rkt')];
    const names = ['auto.rkt', 'reference.ork', 'TubeFins2.rkt'];
    const nodes = await Promise.all(bodies.map((body, i) => simulateFile(body, names[i]!, { reportSeries: 'summary', yieldToUi: () => Promise.resolve() })));
    const responses = await Promise.all(bodies.map((body, i) => normal!.fetch(`http://local/experimental/fly?filename=${names[i]}`, { method: 'POST', body })));
    for (const [i, response] of responses.entries()) {
      expect(response.status, await response.clone().text()).toBe(200);
      const out = await response.json() as FlightResponse;
      const node = nodes[i]!;
      close(out.apogeeM, node.result.summary.maxAltitude);
      close(out.maxVelocityMs, node.result.summary.maxVelocity);
      close(out.maxMach, node.result.summary.maxMachNumber);
      close(out.flightTimeS, node.result.summary.flightTime, true);
      sameNumeric(out.motors, expectedMotors(node));
    }
  });

  it('rejects a declared oversize body before parsing', async () => {
    const response = await trapped!.fetch('http://local/__test/declared-oversize');
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE', message: expect.stringMatching(/8 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
  });

  it('HTTP smoke: an oversize upload is refused (early cancellation is checked inside workerd below)', async () => {
    // Exactly one byte over the 8 MiB cap: the refusal then lands as the upload ends. A larger body leaves bytes
    // unsent when the Worker cancels, and Wrangler's dev proxy loses the next request on that connection
    // ("Network connection lost" — CI run 40059718401, the no-motor test two tests later).
    let remaining = 8 * 1024 * 1024 + 1;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const size = Math.min(1024 * 1024, remaining);
      controller.enqueue(new Uint8Array(size));
      remaining -= size;
    } });
    // Use a real loopback HTTP stream: DispatchFetch's BodyInit accepts buffered
    // bodies, while Node fetch supports upload streaming with duplex: 'half'.
    const response = await fetch(new URL('/experimental/fly?filename=stream.ork', await normal!.url),
      { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'FILE_TOO_LARGE', message: expect.any(String) } });
  });

  it.each(['/__test/streamed-cap', '/__test/streamed-cap-cancel-error'])(
    'the stream cap cancels at the first excess byte before another read: %s', async (path) => {
      const response = await trapped!.fetch(`http://local${path}`);
      expect(response.status).toBe(413);
      expect(response.headers.get('x-test-reader-cancelled')).toBe('true');
      expect(response.headers.get('x-test-bytes-read')).toBe(String(8 * 1024 * 1024 + 1));
    });

  it('hides unexpected failures behind a stable JSON 500', async () => {
    const response = await trapped!.fetch('http://local/__test/body-error');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'INTERNAL_ERROR', message: 'The design could not be simulated.' } });
  });

  it('returns a semantic no-motor refusal as JSON 422', async () => {
    const response = await normal!.fetch('http://local/experimental/fly?filename=unit-site-notes.ork',
      { method: 'POST', body: bytesOf('unit-site-notes.ork') });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ...STAMP, error: { code: 'NO_MOTOR', message: expect.any(String),
      importNote: expect.objectContaining({ text: expect.any(String), severity: expect.any(String) }) } });
  });

  it('returns a stable JSON bad-file error without a stack', async () => {
    const response = await normal!.fetch('http://local/experimental/fly?filename=bad.ork', { method: 'POST', body: 'not a rocket' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    const result = await response.json();
    expect(result).toEqual({ ...STAMP, error: { code: 'INVALID_FILE', message: expect.any(String) } });
    expect(JSON.stringify(result)).not.toMatch(/\n\s+at |"stack"/);
  });

  it.each([
    ['/unknown', 'GET', 404, 'NOT_FOUND'],
    ['/health', 'POST', 405, 'METHOD_NOT_ALLOWED'],
    ['/experimental/fly', 'GET', 405, 'METHOD_NOT_ALLOWED'],
    ['/experimental/fly', 'POST', 400, 'FILENAME_REQUIRED'],
    ['/experimental/fly?filename=empty.rkt', 'POST', 400, 'EMPTY_FILE'],
  ] as const)('%s %s returns %s %s', async (path, method, status, code) => {
    const response = await normal!.fetch(`http://local${path}`, { method });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ...STAMP, error: { code, message: expect.any(String) } });
  });
});

describe('version stamp on every route in real workerd', () => {
  const post = (body: Uint8Array | string) => ({ method: 'POST', body });
  type Send = () => ReturnType<LocalWorker['fetch']>;
  /** reference.ork with a part comment past the share link's 4 MiB XML limit, inside every API cap. */
  const pastLinkLimit = () => zipSync({ 'rocket.ork': strToU8(strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
    .replace('<name>Nose Cone</name>', `<name>Nose Cone</name><comment>${'x'.repeat(4 * 1024 * 1024 + 1)}</comment>`)) });
  const cases: [string, Send, number, string | null, Record<string, string>?][] = [
    ['GET /health', () => normal!.fetch('http://local/health'), 200, null],
    ...FIXTURES.map(name => [`fly ${name}`, () => normal!.fetch(`http://local/experimental/fly?filename=${encodeURIComponent(name)}`,
      post(bytesOf(name))), 200, null] as [string, Send, number, null]),
    ['describe reference.ork', () => normal!.fetch('http://local/describe?filename=reference.ork', post(bytesOf('reference.ork'))), 200, null],
    ['GET /unknown', () => normal!.fetch('http://local/unknown'), 404, 'NOT_FOUND'],
    ['POST /describe/extra', () => normal!.fetch('http://local/describe/extra', { method: 'POST' }), 404, 'NOT_FOUND'],
    ['POST /health', () => normal!.fetch('http://local/health', { method: 'POST' }), 405, 'METHOD_NOT_ALLOWED', { allow: 'GET' }],
    ['GET /describe', () => normal!.fetch('http://local/describe'), 405, 'METHOD_NOT_ALLOWED', { allow: 'POST' }],
    ['GET /experimental/fly', () => normal!.fetch('http://local/experimental/fly'), 405, 'METHOD_NOT_ALLOWED', { allow: 'POST' }],
    ['fly without a filename', () => normal!.fetch('http://local/experimental/fly', { method: 'POST' }), 400, 'FILENAME_REQUIRED'],
    ['fly an empty body', () => normal!.fetch('http://local/experimental/fly?filename=empty.rkt', { method: 'POST' }), 400, 'EMPTY_FILE'],
    ['fly an unreadable file', () => normal!.fetch('http://local/experimental/fly?filename=bad.ork', post('not a rocket')), 400, 'INVALID_FILE'],
    ['describe an unreadable file', () => normal!.fetch('http://local/describe?filename=bad.ork', post('not a rocket')), 400, 'INVALID_FILE'],
    ['fly a declared body over 8 MiB', () => trapped!.fetch('http://local/__test/declared-oversize'), 413, 'FILE_TOO_LARGE'],
    ['fly a streamed body over 8 MiB', () => trapped!.fetch('http://local/__test/streamed-cap'), 413, 'FILE_TOO_LARGE',
      { 'x-test-reader-cancelled': 'true' }],
    ['fly inflated XML over 16 MiB', () => normal!.fetch('http://local/experimental/fly?filename=large.ork',
      post(zipSync({ 'rocket.ork': new Uint8Array(16 * 1024 * 1024 + 1) }))), 413, 'FILE_TOO_LARGE'],
    ['fly past the XML element budget', () => normal!.fetch('http://local/experimental/fly?filename=structure.ork',
      post(`<openrocket><rocket>${'<x/>'.repeat(MAX_ELEMENTS)}</rocket></openrocket>`)), 413, 'FILE_TOO_LARGE'],
    ['describe past the share link limit', () => normal!.fetch('http://local/describe?filename=long.ork', post(pastLinkLimit())),
      413, 'LINK_TOO_LARGE'],
    ['fly a design with no motor', () => normal!.fetch('http://local/experimental/fly?filename=unit-site-notes.ork',
      post(bytesOf('unit-site-notes.ork'))), 422, 'NO_MOTOR'],
    ['describe a refused build', () => trapped!.fetch('http://local/__test/describe-build-failure', post(bytesOf('reference.ork'))),
      422, 'DESIGN_BUILD_FAILED'],
    ['fly on a poisoned kernel', () => trapped!.fetch('http://local/__test/dead-kernel', post(bytesOf('reference.ork'))),
      503, 'KERNEL_UNAVAILABLE', { 'retry-after': '5' }],
    ['describe on a poisoned kernel', () => trapped!.fetch('http://local/__test/dead-kernel?route=describe', post(bytesOf('reference.ork'))),
      503, 'KERNEL_UNAVAILABLE', { 'retry-after': '5' }],
    ['fly an unexpected failure', () => trapped!.fetch('http://local/__test/body-error'), 500, 'INTERNAL_ERROR'],
    ['describe an unexpected failure', () => trapped!.fetch('http://local/__test/body-error?route=describe'), 500, 'INTERNAL_ERROR'],
  ];

  it.each(cases)('%s carries /health\'s stamp and the bundled snapshot', async (_label, send, status, code, headers = {}) => {
    const health = await (await normal!.fetch('http://local/health')).json() as { engine: { openRocket: string } };
    const response = await send();
    const body = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(body).slice(0, 500)).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name), name).toBe(value);
    expect(stampOf(body)).toEqual(stampOf(health));
    expect(stampOf(body)).toEqual({ appVersion: APP_VERSION, engine: { openRocket: health.engine.openRocket, appVersion: APP_VERSION },
      catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });
    if (code) {
      // Beside the error, never inside it.
      expect(Object.keys(body)).toEqual(['error', 'appVersion', 'engine', 'catalogue']);
      expect(Object.keys(body['error'] as object).slice(0, 2)).toEqual(['code', 'message']);
      expect((body['error'] as { code: string }).code).toBe(code);
    }
  }, 60_000);
});

// Round-2 review measured <=1e-12 SI differences for compared non-time quantities
// (auto apogee: 8e-13 m); Node 22/24 were identical for all five reviewed designs.
// Keep ten relative digits there. Only event times/delays use 1e-5 relative:
// cluster descent showed 1.7e-6 relative flight-time drift across workerd/Node.
const numericTolerance = (expected: number, eventTime = false) =>
  (eventTime ? 1e-5 : 1e-10) * Math.max(1, Math.abs(expected));
const close = (actual: number, expected: number, eventTime = false) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(numericTolerance(expected, eventTime));

/** Only event-time leaves receive the wider adaptive-step tolerance. */
function sameNumeric(actual: unknown, expected: unknown, eventTime = false): void {
  if (typeof expected === 'number') { close(actual as number, expected, eventTime); return; }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect(actual as unknown[]).toHaveLength(expected.length);
    expected.forEach((value, index) => sameNumeric((actual as unknown[])[index], value, eventTime));
  } else if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      sameNumeric((actual as Record<string, unknown>)[key], value, key === 'time' || key === 'delayS');
    }
  } else expect(actual).toEqual(expected);
}

function expectedFailures(node: Awaited<ReturnType<typeof simulateFile>>) {
  const names = mountNamesOf(motorMounts(node.state.tree));
  return node.build.motorFailures.map(({ mountId, text }) => ({ mount: names[mountId], text }));
}

function expectedMotors(node: Awaited<ReturnType<typeof simulateFile>>) {
  const state = resolveFlightState(node.state.tree, node.state.savedConfigs, node.state.activeConfigId,
    node.state.detachedOverrides ?? {}, node.state.mountMotors);
  return node.flight.delayResolution.mounts.flatMap(m => {
    const motor = state.mountMotors[m.mountId];
    return !motor || motor.ignition?.event === 'never' ? [] : [{ mount: m.mountName, designation: motor.spec.designation,
      manufacturer: motor.meta.manufacturer ?? '', count: mountMotorCount(state.tree, m.mountId), delayS: m.flownDelay }];
  });
}
