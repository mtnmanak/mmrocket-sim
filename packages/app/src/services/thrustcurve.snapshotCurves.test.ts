// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TcMotor } from './thrustcurve.js';
import type { CatalogueOverlay, MotorDbEntry } from './motorDb.js';
import { CATALOGUE_BASE, CURATED_CHECK_SINCE } from './catalogueClient.js';
import { catalogueFetch, daysAfter, manifestOf, publication, type Publication } from './catalogueFixture.testSupport.js';

/**
 * Curves for motors the app shipped no curve for (row 110 ruling 3, D.7): the
 * curated snapshot's curves file, read on first use for an ADDED motor and
 * for a SHIPPED motor the bundle has no curve for — never for a shipped motor
 * the bundle has, whose curve is never replaced. Motors are picked from the
 * shipped data at run time; shas are computed here.
 */

type Client = typeof import('./thrustcurve.js');
let tc: Client;
let db: typeof import('./motorDb.js');
let bundle: Record<string, unknown[]>;
let curveless: MotorDbEntry;
let bundled: MotorDbEntry;
let addedMotor: MotorDbEntry;
let tcRequests: string[];
let catalogueRequests: string[];
const NO_CURVE_KEY = 'online-openrocket.no-curve.v1';
const file = (peak: number, over: Record<string, unknown> = {}) => ({
  simfileId: `sf-${peak}`, source: 'cert', format: 'RASP',
  samples: [[0, 0], [0.1, peak], [0.5, peak / 2], [1, 0]], masses: { totalWeightG: 30, propWeightG: 12 }, ...over,
});

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  tc = await import('./thrustcurve.js');
  db = await import('./motorDb.js');
  const { default: b } = await import('../data/motorCurves.json');
  bundle = b.curves as unknown as Record<string, unknown[]>;
  curveless = db.MOTOR_DB.find((m) => !Object.hasOwn(bundle, m.motorId))!;
  bundled = db.MOTOR_DB.find((m) => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!;
  expect(curveless, 'a shipped motor with no bundled curve').toBeDefined();
  expect(Object.hasOwn(bundle, bundled.motorId)).toBe(true);
  addedMotor = { ...bundled, motorId: 'snapshot-added', designation: 'C7', commonName: 'C7' };
  await tc.bundledSimFiles('warm');
  tcRequests = [];
  catalogueRequests = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('../data/motorCurves.json'); localStorage.clear(); });

/** A snapshot whose curves file holds `curves`, installed as the active overlay; fetch serves it, and refuses thrustcurve.org with `tcAnswer`. */
async function install(curves: Record<string, unknown[]>, opts: {
  added?: MotorDbEntry[]; changed?: CatalogueOverlay['changed']; fetchedAt?: string; curvesDoc?: unknown;
  curvesAnswer?: () => Response | Promise<Response>; tcAnswer?: () => Response | Promise<Response>; generated?: string; revision?: number;
} = {}): Promise<{ pub: Publication; overlay: CatalogueOverlay }> {
  const generated = opts.generated ?? daysAfter(db.MOTOR_DB_DATE, 2);
  const pub = await publication(`${generated}.${opts.revision ?? 2}`, db.MOTOR_DB, curves, opts.curvesDoc !== undefined ? { curvesDoc: opts.curvesDoc } : {});
  const serve = catalogueFetch(manifestOf(pub), [pub], opts.curvesAnswer ? { [pub.entry.curves.path]: opts.curvesAnswer } : {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(CATALOGUE_BASE)) { catalogueRequests.push(url); return serve(input, init); }
    tcRequests.push(url);
    return opts.tcAnswer ? opts.tcAnswer() : new Response(JSON.stringify({ results: [] }));
  }));
  const overlay: CatalogueOverlay = {
    baseGenerated: db.MOTOR_DB_DATE, fetchedAt: opts.fetchedAt ?? new Date().toISOString(), liveCount: db.MOTOR_DB.length,
    added: opts.added ?? [], changed: opts.changed ?? [], removed: [], rejected: [],
    snapshot: { id: pub.id, generated, motorsSha256: pub.entry.motors.sha256,
      curves: { path: pub.entry.curves.path, bytes: pub.entry.curves.bytes, sha256: pub.entry.curves.sha256 } },
  };
  db.setCatalogueOverlay(overlay);
  return { pub, overlay };
}
const legacy = (fetchedAt: string, added: MotorDbEntry[] = []) => db.setCatalogueOverlay({
  baseGenerated: db.MOTOR_DB_DATE, fetchedAt, liveCount: 0, added, changed: [], removed: [], rejected: [] });
const miss = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e as Error);
const thrusts = async (m: TcMotor, opts?: Parameters<Client['fetchMotorSpec']>[3]) => (await tc.fetchMotorSpec(m, 5, undefined, opts)).thrusts;
/** E: the failure for a curves file that could not be read — never "none exists". */
const unreadable = (err: Error): boolean => !(err instanceof tc.NoPublishedCurveError)
  && /^The curated catalogue's curves file, the only source of a curve for .+, could not be read\./.test(err.message);

describe('an added motor', () => {
  it('flies the snapshot file\'s curve, with no thrustcurve.org request, and the file is read once', async () => {
    await install({ [addedMotor.motorId]: [file(40)] }, { added: [addedMotor] });
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(40, 9);
    expect(tcRequests).toEqual([]);
    expect(catalogueRequests).toHaveLength(1);
    localStorage.clear();
    await thrusts(addedMotor);
    expect(catalogueRequests).toHaveLength(1);
  });

  it('caches the curve the way a download does', async () => {
    await install({ [addedMotor.motorId]: [file(40)] }, { added: [addedMotor] });
    await thrusts(addedMotor);
    const cached = JSON.parse(localStorage.getItem(`tc:samples:v7:${addedMotor.motorId}`)!) as { samples: unknown[]; masses: unknown };
    expect(cached.samples).toHaveLength(4);
    expect(cached.masses).toEqual({ totalWeightG: 30, propWeightG: 12 });
  });

  it('falls through to today\'s download when the file lacks it', async () => {
    await install({}, { added: [addedMotor] });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(catalogueRequests).toHaveLength(1);
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
  });

  it('a motor id that is not in the overlay\'s added list never reads the file', async () => {
    await install({ [addedMotor.motorId]: [file(40)] }, { added: [] });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(catalogueRequests).toEqual([]);
    expect(tcRequests).toHaveLength(1);
  });

  it('bundleOnly makes zero requests with a snapshot overlay installed', async () => {
    await install({ [addedMotor.motorId]: [file(40)] }, { added: [addedMotor] });
    expect(await miss(tc.fetchMotorSpec(addedMotor, 5, undefined, { bundleOnly: true }))).toBeInstanceOf(tc.OfflineCurveError);
    expect(await miss(tc.fetchMotorSpec(curveless, 5, undefined, { bundleOnly: true }))).toBeInstanceOf(tc.OfflineCurveError);
    expect([...catalogueRequests, ...tcRequests]).toEqual([]);
    // Positive control: the same call without bundleOnly reads the file.
    await thrusts(addedMotor);
    expect(catalogueRequests).toHaveLength(1);
  });
});

describe('a shipped motor with no bundled curve (D.7)', () => {
  it('flies the file\'s curve when the file has one — adding a curve where none ships replaces nothing', async () => {
    await install({ [curveless.motorId]: [file(55)] });
    expect(Math.max(...await thrusts(curveless))).toBeCloseTo(55, 9);
    expect(tcRequests).toEqual([]);
    expect(catalogueRequests).toHaveLength(1);
  });

  it('is "no published curve" with zero thrustcurve.org requests when the file lacks it', async () => {
    await install({});
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(tcRequests).toEqual([]);
    expect(catalogueRequests).toHaveLength(1);
  });

  it('positive control: the same motor under a legacy overlay still reaches today\'s download', async () => {
    await install({});
    legacy(`${daysAfter(CURATED_CHECK_SINCE, -2)}T00:00:00.000Z`);
    await miss(tc.fetchMotorSpec(curveless, 5));
    expect(tcRequests).toEqual(daysAfter(CURATED_CHECK_SINCE, -2) > db.MOTOR_DB_DATE
      ? ['https://www.thrustcurve.org/api/v1/download.json'] : []);
    expect(catalogueRequests).toEqual([]);
  });

  // E (audit S5-1): a file that could not be read says nothing about the
  // motor. Until the fix this was NoPublishedCurveError, "publishes none".
  it('is "could not be read", not "no published curve", with no thrustcurve.org request when the file cannot be fetched, and the next use asks the catalogue again', async () => {
    let up = false;
    await install({ [curveless.motorId]: [file(55)] }, { curvesAnswer: () => up ? fetchedCurves() : Promise.reject(new TypeError('Failed to fetch')) });
    let fetchedCurves!: () => Response;
    expect(unreadable(await miss(tc.fetchMotorSpec(curveless, 5)))).toBe(true);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
    expect(tcRequests).toEqual([]);
    expect(catalogueRequests).toHaveLength(1);
    // A network failure is not remembered: the next pick asks again.
    const pub = await publication(`${daysAfter(db.MOTOR_DB_DATE, 2)}.2`, db.MOTOR_DB, { [curveless.motorId]: [file(55)] });
    fetchedCurves = () => new Response(pub.curvesBytes as Uint8Array<ArrayBuffer>);
    up = true;
    expect(Math.max(...await thrusts(curveless))).toBeCloseTo(55, 9);
    expect(catalogueRequests).toHaveLength(2);
  });

  it('knownNoPublishedCurve is unknown until the file is read, then the file\'s answer', async () => {
    await install({});
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
    expect(catalogueRequests).toEqual([]);
    await miss(tc.fetchMotorSpec(curveless, 5));
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(true);
    // A shipped motor WITH a bundled curve, and an added one, are never "known absent".
    expect(await tc.knownNoPublishedCurve(bundled.motorId)).toBe(false);
    expect(await tc.knownNoPublishedCurve(addedMotor.motorId)).toBe(false);
  });

  it('a file that lists it with a curve answers knownNoPublishedCurve false', async () => {
    await install({ [curveless.motorId]: [file(55)] });
    await thrusts(curveless);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
  });
});

describe('a shipped curve is never replaced', () => {
  it('a shipped motor whose curve differs in the file still flies its bundled curve, and never reads the file — in overlay.changed too', async () => {
    const shippedSpec = tc.samplesToMotorSpec(bundled, tc.pickSampleFile(await tc.bundledFiles(bundled.motorId), bundled)!.samples!, 5,
      tc.headerMasses(tc.pickSampleFile(await tc.bundledFiles(bundled.motorId), bundled)!));
    await install({ [bundled.motorId]: [file(999)] }, {
      changed: [{ motorId: bundled.motorId, before: bundled, after: { ...bundled, totImpulseNs: bundled.totImpulseNs + 1 }, fields: ['totImpulseNs'] }],
    });
    const flown = await tc.fetchMotorSpec(bundled, 5);
    expect(flown.thrusts).toEqual(shippedSpec.thrusts);
    expect(flown.times).toEqual(shippedSpec.times);
    expect(catalogueRequests).toEqual([]);
    expect(tcRequests).toEqual([]);
  });
});

describe('the curves file is checked before anything flies from it', () => {
  it('a sha mismatch rejects the whole file, remembered for the session: added falls through, curveless is no published curve', async () => {
    const other = await publication(`${daysAfter(db.MOTOR_DB_DATE, 2)}.9`, db.MOTOR_DB, { [addedMotor.motorId]: [file(41)], [curveless.motorId]: [file(42)] });
    const { pub } = await install({ [addedMotor.motorId]: [file(40)], [curveless.motorId]: [file(55)] }, {
      added: [addedMotor],
      // Same size, other bytes: the sha is what refuses it.
      curvesAnswer: () => new Response(other.curvesBytes.slice(0, pub.curvesBytes.length) as Uint8Array<ArrayBuffer>),
    });
    expect(other.curvesBytes.length).toBe(pub.curvesBytes.length);
    const err = await miss(tc.fetchMotorSpec(curveless, 5));
    expect(unreadable(err)).toBe(true);
    expect(err.message).toContain('does not match its manifest');
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests).toHaveLength(1);
    // A refusal alone is not "none exists" (E).
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
  });

  it.each([
    ['a catalogueGenerated that is not the snapshot\'s', { catalogueGenerated: '2001-01-01', curves: 'GOOD' }],
    ['a curves array', { catalogueGenerated: 'SNAP', curves: [] }],
    ['no curves', { catalogueGenerated: 'SNAP' }],
    ['a JSON array', []],
  ])('refuses a file with %s — even its good curves fly nothing — and asks for it no more this session', async (_name, doc) => {
    const generated = daysAfter(db.MOTOR_DB_DATE, 2);
    const good = { [addedMotor.motorId]: [file(40)], [curveless.motorId]: [file(55)] };
    const curvesDoc = Array.isArray(doc) ? doc : { ...doc,
      catalogueGenerated: doc.catalogueGenerated === 'SNAP' ? generated : doc.catalogueGenerated,
      ...('curves' in doc && doc.curves === 'GOOD' ? { curves: good } : {}) };
    await install({}, { added: [addedMotor], curvesDoc });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(unreadable(await miss(tc.fetchMotorSpec(curveless, 5)))).toBe(true);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests).toHaveLength(1);
  });

  it.each([
    ['empty samples', { samples: [] }], ['a non-finite sample', { samples: [[0, 0], [0.1, null], [1, 0]] }],
    ['a three-element sample', { samples: [[0, 0, 1], [1, 0, 1]] }], ['samples that are not pairs', { samples: 'x' }],
    ['a numeric format', { format: 7 }], ['no source', { source: undefined }],
    ['masses with text', { masses: { totalWeightG: '30', propWeightG: 12 } }], ['masses as an array', { masses: [30, 12] }],
    ['digests with a number', { digests: ['a', 7] }], ['a numeric simfileId', { simfileId: 7 }],
  ])('drops a file with %s; with no file left, an added motor falls through and a curveless one has none', async (_name, over) => {
    await install({ [addedMotor.motorId]: [file(40, over)], [curveless.motorId]: [file(55, over)] }, { added: [addedMotor] });
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toHaveLength(1);
  });

  // H1: planPublication publishes only a complete curves file.
  it.each([false, undefined])('refuses a curves file whose complete is %s: an added motor flies nothing from it', async (complete) => {
    const generated = daysAfter(db.MOTOR_DB_DATE, 2);
    const curves = { [addedMotor.motorId]: [file(40)] };
    const curvesDoc = { generated, catalogueGenerated: generated, ...(complete === undefined ? {} : { complete }), motors: 1, files: 1, curves };
    await install({}, { added: [addedMotor], curvesDoc });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests).toHaveLength(1);
    // Positive control: the same file, complete, flies.
    vi.resetModules();
    tc = await import('./thrustcurve.js');
    db = await import('./motorDb.js');
    await install({}, { added: [addedMotor], curvesDoc: { ...curvesDoc, complete: true } });
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(40, 9);
  });

  it('keeps the good file of a motor beside a bad one', async () => {
    await install({ [addedMotor.motorId]: [file(40, { samples: 'bad' }), file(44)] }, { added: [addedMotor] });
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(44, 9);
  });

  it('a curves map with __proto__ and constructor keys flies nothing from them', async () => {
    const proto = { ...addedMotor, motorId: '__proto__' };
    const ctor = { ...addedMotor, motorId: 'constructor' };
    const generated = daysAfter(db.MOTOR_DB_DATE, 2);
    const curvesDoc = JSON.parse(`{"generated":"${generated}","catalogueGenerated":"${generated}","complete":true,"motors":2,"files":2,
      "curves":{"__proto__":[${JSON.stringify(file(66))}],"constructor":[${JSON.stringify(file(67))}]}}`) as unknown;
    await install({}, { added: [addedMotor, ctor], curvesDoc });
    // A motor the file does not list gets no curve through a prototype key…
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toHaveLength(1);
    // …and 'constructor', listed as an own key, flies only its own file.
    expect(Math.max(...await thrusts(ctor))).toBeCloseTo(67, 9);
    // '__proto__' is not in the overlay's added list, so it reads nothing.
    await miss(tc.fetchMotorSpec(proto, 5));
    expect(tcRequests).toHaveLength(2);
    expect(({} as Record<string, unknown>)['samples']).toBeUndefined();
  });
});

describe('D.7: the no-curve date does not churn under a snapshot', () => {
  it('rewrites of fetchedAt by the automatic check allow no new thrustcurve.org request', async () => {
    // An added motor the file lacks and thrustcurve.org has no curve for.
    const { overlay } = await install({}, { added: [addedMotor] });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toHaveLength(1);
    for (const hours of [6, 12, 18]) {
      db.setCatalogueOverlay({ ...overlay, fetchedAt: new Date(Date.now() + hours * 3_600_000).toISOString() });
      expect(await miss(tc.fetchMotorSpec(addedMotor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
      expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    }
    expect(tcRequests).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(NO_CURVE_KEY)!)).toEqual({ [addedMotor.motorId]: overlay.snapshot!.generated });
  });

  it('a NEWER snapshot allows one more try (positive control)', async () => {
    const { overlay } = await install({}, { added: [addedMotor] });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    db.setCatalogueOverlay({ ...overlay, snapshot: { ...overlay.snapshot!, generated: daysAfter(db.MOTOR_DB_DATE, 3) } });
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toHaveLength(2);
  });

  it('a legacy overlay still keys on its check date, as before', async () => {
    legacy(`${daysAfter(CURATED_CHECK_SINCE, -2)}T00:00:00.000Z`, [addedMotor]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { tcRequests.push(String(input)); return new Response(JSON.stringify({ results: [] })); }));
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    legacy(`${daysAfter(CURATED_CHECK_SINCE, -1)}T00:00:00.000Z`, [addedMotor]);
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toHaveLength(2);
  });
});

/**
 * The shipped-curve rule, where nothing else would hold it: a mocked bundle
 * LISTS the shipped motor with a file it cannot fly (one sample), so the
 * bundle answers nothing and the snapshot step is reached. The motor has a
 * bundled curve entry, so the snapshot's file is never read for it — not as a
 * "shipped motor with no bundled curve" (case b), and not as an "added" row a
 * hand-edited overlay gives a shipped id (case a). Today's download stands.
 */
describe('a shipped motor the bundle lists never reads the snapshot file, even when the bundle cannot fly it', () => {
  it.each([false, true])('in overlay.added: %s', async (inAdded) => {
    const { default: real } = await vi.importActual<{ default: { curves: Record<string, unknown[]> } }>('../data/motorCurves.json');
    const listed = db.MOTOR_DB.find((m) => m.motorId === bundled.motorId)!;
    vi.resetModules();
    vi.doMock('../data/motorCurves.json', () => ({ default: { ...real,
      curves: { ...real.curves, [listed.motorId]: [{ simfileId: 'one', source: 'cert', format: 'RASP', samples: [[0.1, 5]] }] } } }));
    tc = await import('./thrustcurve.js');
    db = await import('./motorDb.js');
    expect(await tc.bundleHasCurve(listed.motorId)).toBe(true);
    await install({ [listed.motorId]: [file(77)] }, { added: inAdded ? [listed] : [] });
    await miss(tc.fetchMotorSpec(listed, 5));
    expect(catalogueRequests).toEqual([]);
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
  });
});

describe('E: a curves file that was not read is "could not be read", never "none exists" (audit S5-1)', () => {
  it.each([
    ['an HTTP 503', () => new Response('down', { status: 503 })],
    ['a dropped connection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s: the unreadable error, zero thrustcurve.org requests, knownNoPublishedCurve false', async (_name, answer) => {
    await install({ [curveless.motorId]: [file(55)] }, { curvesAnswer: answer });
    const err = await miss(tc.fetchMotorSpec(curveless, 5));
    expect(unreadable(err)).toBe(true);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
    expect(tcRequests).toEqual([]);
  });

  it('a browser with no crypto.subtle: the unreadable error, no download at all, and not remembered as refused', async () => {
    await install({ [curveless.motorId]: [file(55)] });
    // An own property over the prototype's getter, removed again below.
    const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try {
      const err = await miss(tc.fetchMotorSpec(curveless, 5));
      expect(unreadable(err)).toBe(true);
      expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(false);
      // Checked before the download: no file is fetched only to fail at the hash.
      expect(catalogueRequests).toEqual([]);
      expect(tcRequests).toEqual([]);
    } finally {
      if (own) Object.defineProperty(globalThis.crypto, 'subtle', own);
      else delete (globalThis.crypto as { subtle?: unknown }).subtle;
    }
    expect(globalThis.crypto.subtle).toBeDefined();
    // Not refused for the session: with the hash back, the next use reads the file.
    expect(Math.max(...await thrusts(curveless))).toBeCloseTo(55, 9);
    expect(catalogueRequests).toHaveLength(1);
  });

  it('a file that was read and lacks the motor is still "no published curve" (positive control)', async () => {
    await install({});
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(true);
  });

  it('an added motor whose file cannot be read still falls through to the download', async () => {
    await install({ [addedMotor.motorId]: [file(40)] }, { added: [addedMotor], curvesAnswer: () => new Response('down', { status: 503 }),
      tcAnswer: () => new Response(JSON.stringify({ results: [{ motorId: addedMotor.motorId, format: 'RASP', source: 'cert', samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 33 }, { time: 1, thrust: 0 }] }] })) });
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(33, 9);
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
  });

  it('the open\'s note is the "could not be loaded" form, never "publishes none"', async () => {
    await install({ [curveless.motorId]: [file(55)] }, { curvesAnswer: () => new Response('down', { status: 503 }) });
    const { matchImportedMotor } = await import('./motorMatch.js');
    const result = await matchImportedMotor({ designation: curveless.designation, manufacturer: curveless.manufacturerAbbrev,
      diameter: curveless.diameter / 1000, length: curveless.length / 1000, delay: 5 }, { findDb: () => curveless });
    expect(result.note).toContain('its thrust curve could not be loaded');
    expect(result.note).not.toContain('publishes none');
    expect(result.missing).toBeUndefined();
    expect(tcRequests).toEqual([]);
  });
});

describe('C: a snapshot older than the build is never active (audit S5-2)', () => {
  it('an older stored ref reads no curves file: a curveless shipped motor is the bundle\'s "none", an added one downloads', async () => {
    await install({ [curveless.motorId]: [file(55)], [addedMotor.motorId]: [file(40)] },
      { added: [addedMotor], generated: daysAfter(db.MOTOR_DB_DATE, -3) });
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(true);
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(catalogueRequests).toEqual([]);
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
  });

  it('positive control: a snapshot dated the shipped catalogue\'s day is active', async () => {
    await install({ [curveless.motorId]: [file(55)] }, { generated: db.MOTOR_DB_DATE });
    expect(Math.max(...await thrusts(curveless))).toBeCloseTo(55, 9);
    expect(catalogueRequests).toHaveLength(1);
  });

  /**
   * The trap: with no active snapshot an overlay looks like a pre-row-110
   * thrustcurve.org pull, whose date is its check time — and the automatic
   * check rewrites that every six hours. Two real checks against an older
   * snapshot, an added motor kept from before, and a curveless shipped motor.
   */
  it('two checks against an older snapshot: zero requests for a curveless shipped motor, and the no-curve date does not move', async () => {
    const catalogue = await import('./catalogueOverlay.js');
    const older = daysAfter(db.MOTOR_DB_DATE, -3);
    const pub = await publication(`${older}.2`, db.MOTOR_DB.slice(0, 1), { [curveless.motorId]: [file(55)], [addedMotor.motorId]: [file(40)] });
    const serve = catalogueFetch(manifestOf(pub), [pub]);
    const fetchImpl = vi.fn(serve);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(CATALOGUE_BASE)) { catalogueRequests.push(String(input)); return serve(input, init); }
      tcRequests.push(String(input));
      return new Response(JSON.stringify({ results: [] }));
    }));
    // What an earlier check learned: a motor it added.
    localStorage.setItem(catalogue.OVERLAY_KEY, JSON.stringify({ baseGenerated: db.MOTOR_DB_DATE,
      fetchedAt: new Date().toISOString(), liveCount: 1, added: [addedMotor], changed: [], removed: [], rejected: [] }));
    let now = Date.now() + 7 * 3_600_000;
    const dates: string[] = [];
    for (let check = 0; check < 2; check++) {
      const { overlay } = await catalogue.checkForCatalogueUpdates({ fetchImpl, now: () => now });
      expect(Object.hasOwn(overlay, 'snapshot')).toBe(false);
      expect(overlay.added.map(m => m.motorId)).toEqual([addedMotor.motorId]);
      expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
      await miss(tc.fetchMotorSpec(addedMotor, 5));
      dates.push((JSON.parse(localStorage.getItem(NO_CURVE_KEY)!) as Record<string, string>)[addedMotor.motorId]!);
      now += 7 * 3_600_000;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(dates).toEqual([db.MOTOR_DB_DATE, db.MOTOR_DB_DATE]);
    // The added motor asked thrustcurve.org once, the curveless one never.
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests.filter(u => u.endsWith('motorCurves.json'))).toEqual([]);
  });

  it('an added motor whose snapshot is gone flies its cached curve, offline too', async () => {
    const { overlay } = await install({ [addedMotor.motorId]: [file(40)] }, { added: [addedMotor] });
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(40, 9);
    db.setCatalogueOverlay({ ...overlay, snapshot: { ...overlay.snapshot!, generated: daysAfter(db.MOTOR_DB_DATE, -1) } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(40, 9);
  });
});

describe('A: a warm cache does not beat the file a desktop digest names (no bundled file)', () => {
  /** Two files of one motor; `named` is the one a desktop .ork's digest names, not the usual pick. */
  const usualFile = () => file(40, { simfileId: 'sf-usual', samples: [[0, 0], [0.1, 40], [0.5, 20], [1, 0], [1.2, 0]], digests: ['a'.repeat(32)] });
  const namedFile = () => file(77, { simfileId: 'sf-named', source: 'user', digests: ['b'.repeat(32)] });
  const NAMED = 'b'.repeat(32);
  const cases = (): [string, MotorDbEntry, { added?: MotorDbEntry[] }][] =>
    [['an added motor', addedMotor, { added: [addedMotor] }], ['a curveless shipped motor', curveless, {}]];

  it.each([0, 1])('%#: plain first, then the digest: the named file flies', async (which) => {
    const [, motor, extra] = cases()[which]!;
    await install({ [motor.motorId]: [usualFile(), namedFile()] }, extra);
    expect(Math.max(...await thrusts(motor))).toBeCloseTo(40, 9);
    expect(localStorage.getItem(`tc:samples:v7:${motor.motorId}`)).not.toBeNull();
    expect(Math.max(...await thrusts(motor, { digest: NAMED }))).toBeCloseTo(77, 9);
    expect(tc.lastCurveFiles(motor.motorId)).toMatchObject({ origin: 'snapshot', digest: { value: NAMED, named: 'flown' } });
    expect(tcRequests).toEqual([]);
  });

  it.each([0, 1])('%#: a newer snapshot can add the digest a cached list lacked', async (which) => {
    const [, motor, extra] = cases()[which]!;
    const { overlay } = await install({ [motor.motorId]: [usualFile()] }, extra);
    await thrusts(motor);
    const key = `tc:samples:v7:${motor.motorId}`;
    const cached = localStorage.getItem(key)!;
    expect(JSON.parse(cached)).toMatchObject({ motorDigests: ['a'.repeat(32)], motorDigestsSource: overlay.snapshot!.curves.sha256 });
    await thrusts(motor, { digest: NAMED });
    expect(tc.lastCurveFiles(motor.motorId)).toMatchObject({ origin: 'cache', digest: { named: 'absent' } });
    const requests = catalogueRequests.length;
    await install({ [motor.motorId]: [usualFile(), namedFile()] }, { ...extra, revision: 3 });
    expect(Math.max(...await thrusts(motor, { digest: NAMED }))).toBeCloseTo(77, 9);
    expect(tc.lastCurveFiles(motor.motorId)).toMatchObject({ origin: 'snapshot', digest: { named: 'flown' } });
    expect(catalogueRequests).toHaveLength(requests + 1);
    expect(tcRequests).toEqual([]);
    expect(localStorage.getItem(key)).toBe(cached);
  });

  it.each(['offline', 'failed', 'untagged'] as const)('a stale digest list keeps its cached stand-in when %s', async kind => {
    await install({ [addedMotor.motorId]: [usualFile()] }, { added: [addedMotor] });
    await thrusts(addedMotor);
    const key = `tc:samples:v7:${addedMotor.motorId}`;
    if (kind === 'untagged') {
      const cached = JSON.parse(localStorage.getItem(key)!);
      delete cached.motorDigestsSource;
      localStorage.setItem(key, JSON.stringify(cached));
    }
    const cached = localStorage.getItem(key);
    await install({}, { added: [addedMotor], generated: daysAfter(db.MOTOR_DB_DATE, 3),
      curvesAnswer: () => new Response('down', { status: 503 }), tcAnswer: () => new Response('down', { status: 503 }) });
    if (kind === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(Math.max(...await thrusts(addedMotor, { digest: NAMED }))).toBeCloseTo(40, 9);
    expect(tc.lastCurveFiles(addedMotor.motorId)).toMatchObject({ origin: 'cache',
      cacheFallback: kind === 'offline' ? 'offline' : 'failed', digest: { named: 'unknown' } });
    expect(localStorage.getItem(key)).toBe(cached);
  });

  it.each([0, 1])('%#: offline (navigator.onLine false) the cached curve flies at once, and the fallback is recorded', async (which) => {
    const [, motor, extra] = cases()[which]!;
    await install({ [motor.motorId]: [usualFile(), namedFile()] }, extra);
    await thrusts(motor);
    // A fresh page load: the file is no longer held in memory.
    vi.resetModules();
    tc = await import('./thrustcurve.js');
    db = await import('./motorDb.js');
    await install({ [motor.motorId]: [usualFile(), namedFile()] }, extra);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(Math.max(...await thrusts(motor, { digest: NAMED }))).toBeCloseTo(40, 9);
    expect(catalogueRequests).toHaveLength(1);
    expect(tc.lastCurveFiles(motor.motorId)).toMatchObject({ origin: 'cache', cacheFallback: 'offline', digest: { value: NAMED, named: 'unknown' } });
  });

  it('a legacy-overlay added motor (the download path): plain first, then the digest: the named file flies', async () => {
    const asDownload = (f: ReturnType<typeof file>) => ({ ...f, motorId: addedMotor.motorId, samples: f.samples.map(([time, thrust]) => ({ time, thrust })) });
    legacy(`${daysAfter(CURATED_CHECK_SINCE, -1)}T00:00:00.000Z`, [addedMotor]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      tcRequests.push(String(input));
      return new Response(JSON.stringify({ results: [asDownload(usualFile()), asDownload(namedFile())] }));
    }));
    expect(Math.max(...await thrusts(addedMotor))).toBeCloseTo(40, 9);
    expect(Math.max(...await thrusts(addedMotor, { digest: NAMED }))).toBeCloseTo(77, 9);
    expect(tcRequests).toHaveLength(2);
    expect(tc.lastCurveFiles(addedMotor.motorId)).toMatchObject({ origin: 'download', digest: { named: 'flown' } });
  });

  it('a digest the cached file carries flies from the cache with no request', async () => {
    await install({ [addedMotor.motorId]: [usualFile(), namedFile()] }, { added: [addedMotor] });
    await thrusts(addedMotor);
    vi.resetModules();
    tc = await import('./thrustcurve.js');
    db = await import('./motorDb.js');
    await install({ [addedMotor.motorId]: [usualFile(), namedFile()] }, { added: [addedMotor] });
    expect(Math.max(...await thrusts(addedMotor, { digest: 'a'.repeat(32) }))).toBeCloseTo(40, 9);
    expect(catalogueRequests).toHaveLength(1);
    expect(tc.lastCurveFiles(addedMotor.motorId)).toMatchObject({ origin: 'cache', cachedFrom: 'snapshot', digest: { named: 'flown' } });
  });
});

describe('B: a cached curve never beats a curve the loaded bundle has (audit S5-3, 113-9b, 113-16e)', () => {
  const hot = (m: MotorDbEntry, over: Record<string, unknown> = {}) => localStorage.setItem(`tc:samples:v7:${m.motorId}`, JSON.stringify({
    samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 999 }, { time: 1, thrust: 0 }], masses: null, massParser: 1, t: 1, ...over }));
  const shipped = async () => tc.samplesToMotorSpec(bundled, tc.pickSampleFile(await tc.bundledFiles(bundled.motorId), bundled)!.samples!, 5,
    tc.headerMasses(tc.pickSampleFile(await tc.bundledFiles(bundled.motorId), bundled)!));

  it.each([
    ['a snapshot-written entry', { origin: 'snapshot' }], ['a download-written entry', { origin: 'download' }], ['an untagged (v0.196) entry', {}],
  ])('%s for a motor a later release bundles: the bundle flies, with no request and no read of the curves file', async (_name, tag) => {
    await install({ [bundled.motorId]: [file(999)] }, { added: [bundled] });
    hot(bundled, tag);
    const flown = await tc.fetchMotorSpec(bundled, 5);
    expect(flown.thrusts).toEqual((await shipped()).thrusts);
    expect(catalogueRequests).toEqual([]);
    expect(tcRequests).toEqual([]);
    expect(tc.lastCurveFiles(bundled.motorId)).toMatchObject({ origin: 'bundle' });
  });

  it('lane 16\'s case: a bundled motor, a digest that names none of its files, and a cache entry: the bundle\'s pick', async () => {
    hot(bundled);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { tcRequests.push(String(input)); return new Response('{}'); }));
    const flown = await tc.fetchMotorSpec(bundled, 5, undefined, { digest: 'c'.repeat(32) });
    expect(flown.thrusts).toEqual((await shipped()).thrusts);
    expect(tcRequests).toEqual([]);
    expect(tc.lastCurveFiles(bundled.motorId)).toMatchObject({ origin: 'bundle', digest: { named: 'absent' } });
  });
});
