import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { unstable_startWorker } from 'wrangler';
import { API_XML_LIMITS, worker } from './index.js';
import * as staticHeadless from '../../app/src/headless/index.js';
import { createJsXmlParser, setXmlParser, simulateFile } from '../../app/src/headless/index.js';
import { bytesOf } from './fixtures.testSupport.js';
import { REFERENCE_CONFIG, SECOND_CONFIG, storedFlightXml, type StoredFlightDesign } from './storedFlight.testSupport.js';

// Main's E1 parser before this opt-in: the baseline every comparison below is held to.
const E1 = { maxElements: 50_000, maxDepth: 64 };
const API_OPTIONS = { network: 'forbid', reportSeries: 'summary', yieldToUi: () => Promise.resolve(),
  minTimeStepS: 0.05, maxInflatedBytes: 16 * 1024 * 1024 } as const;

const otherSite = `        <launchrodlength>2.5</launchrodlength>
        <launchrodangle>9.0</launchrodangle>
        <launchroddirection>45.0</launchroddirection>
        <windaverage>6.5</windaverage>
        <windturbulence>0.2</windturbulence>
        <launchaltitude>1400.0</launchaltitude>
        <launchlatitude>32.9</launchlatitude>
        <launchlongitude>-106.9</launchlongitude>
        <geodeticmethod>flat</geodeticmethod>
        <atmosphere model="isa"/>
        <timestep>0.02</timestep>
`;
const lookalike = '<flightdata><databranch name="x"><datapoint>1</datapoint></databranch></flightdata>';
/** Stored-flight designs covering each input orkFile reads around the omitted samples. */
const DESIGNS: Record<string, StoredFlightDesign> = {
  'one stored flight': { simulations: [{ points: 400 }] },
  'two stages of data': { simulations: [{ points: 150, branches: 2 }] },
  'two configurations, the second active with its own site': { secondConfig: 'default', simulations: [
    { name: 'First', points: 120 }, { name: 'Second', configId: SECOND_CONFIG, points: 90, baseConditions: otherSite }] },
  'two configurations, the first active': { secondConfig: 'listed', simulations: [
    { name: 'Second', configId: SECOND_CONFIG, points: 60, baseConditions: otherSite }, { name: 'First', points: 60 }] },
  'a configuration-less simulation': { simulations: [{ configId: null, points: 30 }] },
  'an empty branch': { simulations: [{ points: 0 }] },
  'flightdata with no branch': { simulations: [{ points: 0, branches: 0 }] },
  'no stored results': { simulations: [{ points: 0, noFlightdata: true, status: 'notsimulated' }] },
  'warnings, simwarnings and a simulation extension': { simulations: [{ points: 80,
    flightdataHead: '        <warning>Large angle of attack encountered.</warning>\n        <warning>Recovery device deployment at high speed.</warning>\n',
    after: '      <extension extensionid="org.example.ext"><payload a="1">kept</payload></extension>\n'
      + '      <simwarnings version="1">[]</simwarnings>\n' }] },
  'unreadable simwarnings': { simulations: [{ points: 20, after: '      <simwarnings version="1">not json</simwarnings>\n' }] },
  'an extension inside a branch': { simulations: [{ points: 20, branchTail: '        <extension extensionid="nested"/>\n' }] },
  'wrong-path lookalikes': { simulations: [{ points: 20,
    conditions: `        <databranch name="c"><datapoint>1</datapoint></databranch>\n`,
    after: `      <x:flightdata xmlns:x="urn:x"><databranch><datapoint>1</datapoint></databranch></x:flightdata>\n      <stored>${lookalike}</stored>\n` }] },
  'a sub-minimum time step': { simulations: [{ points: 40, conditions: '        <timestep>0.005</timestep>\n' }] },
  'rounded freeform fins': { freeformFins: 'rounded', simulations: [{ points: 60 }] },
  'airfoil freeform fins': { freeformFins: 'airfoil', simulations: [{ points: 60 }] },
};
const DESIGN_NAMES = Object.keys(DESIGNS);

/** The flight response with its wall timings removed. */
async function respond(body: Uint8Array, filename: string) {
  const response = await worker.fetch(new Request(`http://local/experimental/fly?filename=${encodeURIComponent(filename)}`,
    { method: 'POST', body: new Uint8Array(body).buffer }), undefined, { waitUntil: () => undefined });
  const json = await response.json() as Record<string, unknown>;
  delete json['timing'];
  return { status: response.status, json };
}

type Headless = typeof import('../../app/src/headless/index.js');
/**
 * One call under main's E1 parser, then under the API's: what each handed
 * xmldom, and the results. With `fresh`, each call gets its own module graph,
 * so component ids (a process-wide counter) and every key hashed from them
 * start alike; the parser is installed on that graph's own seam.
 */
async function both<T>(run: (headless: Headless) => Promise<T>, fresh = false) {
  const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
  const under = async (limits: typeof E1) => {
    if (fresh) vi.resetModules();
    // `worker` (index.ts) holds the static graph: install there unless fresh.
    const headless = fresh ? await import('../../app/src/headless/index.js') : staticHeadless;
    headless.setXmlParser(headless.createJsXmlParser(limits));
    spy.mockClear();
    const out = await run(headless);
    return { out, dom: spy.mock.calls.map(call => call[0]) };
  };
  try {
    const baseline = await under(E1);
    const changed = await under(API_XML_LIMITS);
    return { baseline: baseline.out, changed: changed.out, baselineDom: baseline.dom, changedDom: changed.dom };
  } finally {
    spy.mockRestore();
    setXmlParser(createJsXmlParser(API_XML_LIMITS));
  }
}
/** 1,000,000 bare elements after the branch's ten events: past the samples budget, inside 16 MiB inflated. */
const pastSamplesBudget = () => gzipSync(strToU8(storedFlightXml({ simulations: [{ points: 0 }] })
  .replace('</databranch>', `${'<d/>'.repeat(1_000_000)}</databranch>`)));
/** A simulateFile result without its wall timings, or its run record's wall-clock `when` and time-and-random id. */
const withoutTiming = (out: object): unknown => JSON.parse(JSON.stringify(out, (key, value: unknown) =>
  (key === 'timing' || key === 'execMs' || key === 'when' || (key === 'id' && typeof value === 'string' && /^[a-z0-9]{6,}-[a-z0-9]{4,}$/.test(value))
    ? undefined : value))) as unknown;

describe('API stored-flight omission: same import and flight as main, without the samples in the DOM', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(DESIGN_NAMES)('%s: identical import plan, state and flight in Node', async name => {
    const body = zipSync({ 'rocket.ork': strToU8(storedFlightXml(DESIGNS[name]!)) });
    const { baseline, changed, baselineDom, changedDom } = await both(h => h.simulateFile(body, 'stored.ork', API_OPTIONS), true);
    expect(withoutTiming(changed)).toEqual(withoutTiming(baseline));
    expect(changed.plan).toEqual(baseline.plan);
    expect(changed.importNote).toEqual(baseline.importNote);
    // The DOM boundary: main built every datapoint; the API builds the ones outside a sample branch only.
    const kept = name === 'wrong-path lookalikes' ? 3 : name === 'an extension inside a branch' ? 20 : 0;
    expect(baselineDom.join('').match(/<datapoint>/g)?.length ?? 0).toBe(storedFlightXml(DESIGNS[name]!).match(/<datapoint>/g)?.length ?? 0);
    expect(changedDom.join('').match(/<datapoint>/g)?.length ?? 0).toBe(kept);
  });

  it.each(DESIGN_NAMES)('%s: identical API response in Node', async name => {
    const body = zipSync({ 'rocket.ork': strToU8(storedFlightXml(DESIGNS[name]!)) });
    const { baseline, changed } = await both(() => respond(body, 'stored.ork'));
    expect(changed).toEqual(baseline);
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  });

  it('keeps the selected configuration\'s own launch settings', async () => {
    const body = strToU8(storedFlightXml(DESIGNS['two configurations, the second active with its own site']!));
    const out = await simulateFile(body, 'stored.ork', API_OPTIONS);
    expect(out.state.activeConfigId).toBe(SECOND_CONFIG);
    expect(out.state.launch.launchRodLengthM).toBe(2.5);
    expect(out.state.launch.launchRodAngleDeg).toBe(9);
  });

  it.each(['plain', 'zip', 'gzip'] as const)('%s .ork: identical results and no samples in the DOM', async container => {
    const xml = storedFlightXml(DESIGNS['two stages of data']!);
    const body = container === 'zip' ? zipSync({ 'rocket.ork': strToU8(xml) }) : container === 'gzip' ? gzipSync(strToU8(xml)) : strToU8(xml);
    const { baseline, changed, changedDom } = await both(() => respond(body, 'stored.ork'));
    expect(changed).toEqual(baseline);
    expect(changedDom.join('')).not.toContain('<datapoint');
  });

  it('keeps the unknown-encoding note when undecodable bytes sit inside omitted samples', async () => {
    const bytes = strToU8(storedFlightXml(DESIGNS['one stored flight']!));
    const at = new TextDecoder().decode(bytes).indexOf('<datapoint>') + '<datapoint>'.length;
    bytes[at] = 0xe9; // Latin-1 é: not UTF-8, and no declared encoding names it.
    const { baseline, changed, changedDom } = await both(h => h.simulateFile(bytes, 'latin.ork', API_OPTIONS), true);
    expect(withoutTiming(changed)).toEqual(withoutTiming(baseline));
    expect(JSON.stringify(changed.importNote)).toMatch(/encod/i);
    expect(changedDom.join('')).not.toContain('<datapoint');
  });

  it.each(['TubeFins2.rkt', 'rocksimTestRocket2.rkt', 'Show-off.CDX1', 'Complex.Two-Stage.CDX1', 'reference.ork'])(
    '%s: xmldom gets exactly the text main gave it, and the same response', async name => {
      const { baseline, changed, baselineDom, changedDom } = await both(() => respond(bytesOf(name), name));
      expect(changedDom).toEqual(baselineDom);
      expect(changed).toEqual(baseline);
    });

  it('refuses malformed XML inside omitted samples as main does, as a 400', async () => {
    const xml = storedFlightXml(DESIGNS['one stored flight']!).replace('<datapoint>', '<datapoint>R & D');
    const { baseline, changed, changedDom } = await both(() => respond(strToU8(xml), 'bad.ork'));
    expect(changed).toEqual(baseline);
    expect(changed.status).toBe(400);
    expect(changedDom).toEqual([]);
  });

  it('refuses a result-free design past the DOM budget exactly as main does', async () => {
    const xml = storedFlightXml({ simulations: [] }).replace('</rocket>', `${'<x/>'.repeat(50_000)}</rocket>`);
    const { baseline, changed, changedDom } = await both(() => respond(strToU8(xml), 'big.ork'));
    expect(changed).toEqual(baseline);
    expect(changed).toEqual({ status: 413, json: { error: { code: 'FILE_TOO_LARGE',
      message: 'big.ork: XML element limit is 50,000. Use https://mmrsim.mountainmanrockets.com for larger files.' } } });
    expect(changedDom).toEqual([]);
  });

  it('opens a stored flight main refused at 50,000 elements, and refuses one past the samples budget', async () => {
    const columns = 2;
    const opened = strToU8(storedFlightXml({ simulations: [{ points: 60_000 }] }, columns));
    const { baseline, changed } = await both(() => respond(opened, 'long.ork'));
    expect(baseline.json).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: 'long.ork: XML element limit is 50,000. Use https://mmrsim.mountainmanrockets.com for larger files.' } });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    // The same design with no samples: the flight is the design's, not the stored data's.
    const plain = await respond(strToU8(storedFlightXml({ simulations: [{ points: 0 }] })), 'long.ork');
    expect(changed.json).toEqual(plain.json);
    // Past the samples budget (1,000,000, events included): its own refusal, before any DOM.
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const refused = await respond(pastSamplesBudget(), 'longer.ork');
    expect(refused).toEqual({ status: 413, json: { error: { code: 'FILE_TOO_LARGE',
      message: 'longer.ork: Stored flight data element limit is 1,000,000. Use https://mmrsim.mountainmanrockets.com for larger files.' } } });
    expect(spy).not.toHaveBeenCalled();
  });
});

type LocalWorker = Awaited<ReturnType<typeof unstable_startWorker>>;
let local: LocalWorker | undefined;

describe('stored flights in real workerd', () => {
  beforeAll(async () => {
    process.env['WRANGLER_SEND_METRICS'] = 'false';
    process.env['WRANGLER_HIDE_BANNER'] = 'true';
    process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
    process.env['WRANGLER_LOG_PATH'] = fileURLToPath(new URL('../.wrangler/test.log', import.meta.url));
    process.env['XDG_CONFIG_HOME'] = fileURLToPath(new URL('../.wrangler/config', import.meta.url));
    const { unstable_startWorker: start } = await import('wrangler');
    local = await start({ config: fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
      dev: { remote: false, persist: false, watch: false, inspector: false,
        server: { hostname: '127.0.0.1', port: 0 }, logLevel: 'error' } });
    await local.ready;
  });
  afterAll(async () => { await local?.dispose(); });

  // Cross-runtime, not this change: workerd computes some Math differently
  // from Node (README: up to 0.026% apogee and 0.26% flight time across 109
  // corpus flights). These tilted-rod, windy flights drift further than the
  // calm fixtures index.test.ts holds to 1e-10 (measured here up to 2e-6
  // relative in apogee), so non-time values use 1e-4 relative and event times
  // and delays 1e-3: still well inside the documented corpus band. Exactness
  // is proven in Node above, and within workerd by the stripped twin below.
  const close = (actual: unknown, expected: unknown, path = '', time = false): void => {
    if (typeof expected === 'number') {
      expect(Math.abs((actual as number) - expected), path).toBeLessThanOrEqual((time ? 1e-3 : 1e-4) * Math.max(1, Math.abs(expected)));
    } else if (Array.isArray(expected)) {
      expect(actual, path).toHaveLength(expected.length);
      expected.forEach((value, i) => close((actual as unknown[])[i], value, `${path}[${i}]`, time));
    } else if (expected !== null && typeof expected === 'object') {
      expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(expected)) {
        close((actual as Record<string, unknown>)[key], value, `${path}.${key}`, time || /time|delay/i.test(key));
      }
    } else expect(actual, path).toEqual(expected);
  };

  it.each(DESIGN_NAMES)('%s: workerd matches main\'s parser in Node', async name => {
    const body = zipSync({ 'rocket.ork': strToU8(storedFlightXml(DESIGNS[name]!)) });
    setXmlParser(createJsXmlParser(E1));
    let oracle: Awaited<ReturnType<typeof respond>>;
    try { oracle = await respond(body, 'stored.ork'); } finally { setXmlParser(createJsXmlParser(API_XML_LIMITS)); }
    const response = await local!.fetch('http://local/experimental/fly?filename=stored.ork', { method: 'POST', body });
    const json = await response.json() as Record<string, unknown>;
    delete json['timing'];
    expect(response.status, JSON.stringify(json)).toBe(oracle.status);
    close(json, oracle.json);
  });

  it.each(['one stored flight', 'two configurations, the second active with its own site', 'airfoil freeform fins'])(
    '%s: workerd answers exactly as for the same file with its samples deleted', async name => {
      const design = DESIGNS[name]!;
      const fly = async (xml: string) => {
        const response = await local!.fetch('http://local/experimental/fly?filename=stored.ork',
          { method: 'POST', body: zipSync({ 'rocket.ork': strToU8(xml) }) });
        const json = await response.json() as Record<string, unknown>;
        delete json['timing'];
        return { status: response.status, json };
      };
      const stripped = { ...design, simulations: design.simulations.map(sim => ({ ...sim, points: 0 })) };
      expect(await fly(storedFlightXml(design))).toEqual(await fly(storedFlightXml(stripped)));
    });

  it('opens in workerd a stored flight main refused, and refuses past the samples budget', async () => {
    const opened = await local!.fetch('http://local/experimental/fly?filename=long.ork',
      { method: 'POST', body: strToU8(storedFlightXml({ simulations: [{ points: 60_000 }] }, 2)) });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const refused = await local!.fetch('http://local/experimental/fly?filename=longer.ork',
      { method: 'POST', body: pastSamplesBudget() });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: 'longer.ork: Stored flight data element limit is 1,000,000. Use https://mmrsim.mountainmanrockets.com for larger files.' } });
  });
});

it('the reference design really is the generator\'s seed', () => {
  expect(storedFlightXml({ simulations: [] })).toContain(`configid="${REFERENCE_CONFIG}"`);
});
