// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TcMotor } from './thrustcurve.js';
import type { CatalogueOverlay, MotorDbEntry } from './motorDb.js';
import { CATALOGUE_BASE } from './catalogueClient.js';
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
  curvesAnswer?: () => Response | Promise<Response>; tcAnswer?: () => Response;
} = {}): Promise<{ pub: Publication; overlay: CatalogueOverlay }> {
  const generated = daysAfter(db.MOTOR_DB_DATE, 2);
  const pub = await publication(`${generated}.2`, db.MOTOR_DB, curves, opts.curvesDoc !== undefined ? { curvesDoc: opts.curvesDoc } : {});
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
    legacy(new Date(Date.parse(db.MOTOR_DB_DATE) + 86_400_000).toISOString());
    await miss(tc.fetchMotorSpec(curveless, 5));
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests).toEqual([]);
  });

  it('stays "no published curve" with no thrustcurve.org request when the file cannot be fetched, and the next use asks the catalogue again', async () => {
    let up = false;
    await install({ [curveless.motorId]: [file(55)] }, { curvesAnswer: () => up ? fetchedCurves() : Promise.reject(new TypeError('Failed to fetch')) });
    let fetchedCurves!: () => Response;
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
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
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    expect(tcRequests).toEqual(['https://www.thrustcurve.org/api/v1/download.json']);
    expect(catalogueRequests).toHaveLength(1);
    expect(await tc.knownNoPublishedCurve(curveless.motorId)).toBe(true);
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
    expect(await miss(tc.fetchMotorSpec(curveless, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
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
    legacy(new Date(Date.parse(db.MOTOR_DB_DATE) + 86_400_000).toISOString(), [addedMotor]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { tcRequests.push(String(input)); return new Response(JSON.stringify({ results: [] })); }));
    await miss(tc.fetchMotorSpec(addedMotor, 5));
    legacy(new Date(Date.parse(db.MOTOR_DB_DATE) + 2 * 86_400_000).toISOString(), [addedMotor]);
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
