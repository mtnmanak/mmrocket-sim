// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { addChild, defaultTree, motorMounts } from '../tree/treeModel.js';
import { orkMotorSet, toOrkMotor, type ExLibrary } from './orkExportMotors.js';
import { exportOrk, importOrk, type OrkMotorRef } from './orkFile.js';
import { fileMotorIdentity, matchImportedMotor } from './motorMatch.js';
import { autosaveToOrk } from './autosaveBackup.js';
import { exportConfigs, exportMotorsMap } from './exportAssembly.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { exportRkt } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';
import { restoreMotorLabels } from './motorLabels.js';
import { displayDesignation, manufacturerMatches, matchDbMotor, MOTOR_DB } from './motorDb.js';
import { bundledOnlyFetchSpec, bundledSimFiles, pickDigestFile } from './thrustcurve.js';
import type { MotorMeta } from './simReport.js';
import { typedPadMass } from './padMassReconcile.js';
import { parseEng } from './exMotors.js';

/**
 * THE .ork EXPORT MAPPING FOR MOTORS, ON ITS OWN (audit 2026-09-30, item 23).
 * It was App's closures, reachable only by mounting App, with a drifted copy in
 * the crash-recovery download. Each rule here has a reason in a file a desktop
 * user opened: the EX badge is no manufacturer, an Auto mount flies its optimum,
 * and the writer takes the first pad mass it finds in a configuration.
 */

const motor = (
  over: { spec?: Partial<MotorSpec>; meta?: Partial<MotorMeta>; padMassKg?: number } = {},
): MountMotor => ({
  label: 'C6-5',
  spec: { designation: 'C6', diameter: 0.018, length: 0.07, ejectionDelay: 5, ...over.spec },
  meta: { label: 'C6-5', manufacturer: 'Estes', type: 'SU', ...over.meta },
  ignition: { event: 'automatic', delay: 0 },
  ...(over.padMassKg !== undefined ? { padMassKg: over.padMassKg } : {}),
}) as unknown as MountMotor;

const noLibrary: ExLibrary = () => [];

/** Two vendors' X99, Acme's first: a find by designation alone takes Acme's. */
const library: ExLibrary = () => [
  { motorId: 'ex:acme-x99', designation: 'X99', realManufacturer: 'Acme' },
  { motorId: 'ex:loki-x99', designation: 'X99', realManufacturer: 'Loki' },
  { motorId: 'ex:bare-y1', designation: 'Y1', realManufacturer: 'EX' },
];

const exMotor = (meta: Partial<MotorMeta> = {}, designation = 'X99'): MountMotor =>
  motor({ spec: { designation }, meta: { manufacturer: 'EX', type: 'reload', ...meta } });

/** The starter rocket with a two-pod set on its body tube; the core's mount ranks first. */
function podTree(): { tree: RocketTree; core: string } {
  const t = defaultTree();
  const body = t.components[0]!.children!.find((n) => n.type === 'bodytube')!;
  const tree = addChild(t, body.id!, {
    type: 'podset', id: 'pods', name: 'Side pods', instanceCount: 2, children: [{
      type: 'bodytube', id: 'pod-bt', name: 'Pod tube', length: 0.1, outerRadius: 0.01, thickness: 0.0005,
      children: [{
        type: 'innertube', id: 'pod-mmt', name: 'Pod MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
      } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode);
  return { tree, core: motorMounts(tree).find((m) => m.id !== 'pod-mmt')!.id! };
}

/**
 * The starter rocket with a second motor mount, `mmt-b`, beside its own in the
 * body tube: a cluster built as separate mounts. Same stage, same rank, so
 * primaryMountOf takes whichever of the two it is handed first.
 */
function tieTree(): { tree: RocketTree; starter: string } {
  const t = defaultTree();
  const body = t.components[0]!.children!.find((n) => n.type === 'bodytube')!;
  const tree = addChild(t, body.id!, {
    type: 'innertube', id: 'mmt-b', name: 'Second MMT', motorMount: true,
    length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
  } as ComponentNode);
  return { tree, starter: motorMounts(tree).find((m) => m.id !== 'mmt-b')!.id! };
}

const ref = (over: Partial<OrkMotorRef> = {}): OrkMotorRef => ({
  designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 6, ...over,
});

describe('toOrkMotor — an EX motor’s manufacturer', () => {
  it('is the pinned library entry’s, over another vendor’s same designation listed first', () => {
    expect(toOrkMotor(exMotor({ exMotorId: 'ex:loki-x99' }), undefined, library).manufacturer).toBe('Loki');
  });

  it('is found by designation only when no entry is pinned', () => {
    expect(toOrkMotor(exMotor(), undefined, library).manufacturer).toBe('Acme');
    expect(toOrkMotor(exMotor({ exMotorId: 'ex:deleted' }), undefined, library).manufacturer).toBeUndefined();
  });

  it('is left out when the library names only the EX badge, or has no such motor', () => {
    expect(toOrkMotor(exMotor({ exMotorId: 'ex:bare-y1' }, 'Y1'), undefined, library).manufacturer).toBeUndefined();
    expect(toOrkMotor(exMotor(), undefined, noLibrary).manufacturer).toBeUndefined();
  });

  it('never carries a digest: desktop’s is over its own data file', () => {
    expect(toOrkMotor(exMotor({ orkDigest: 'abc123' }), undefined, library)).not.toHaveProperty('digest');
  });

  it('is the only thing that reads the library', () => {
    const lib = vi.fn(library);
    toOrkMotor(motor(), undefined, lib);
    expect(lib).not.toHaveBeenCalled();
    toOrkMotor(exMotor(), undefined, lib);
    expect(lib).toHaveBeenCalledTimes(1);
  });
});

describe('toOrkMotor — identity, type and pad mass', () => {
  it('writes the file’s own manufacturer and digest, but corrects a conflicting catalogue type', () => {
    expect(toOrkMotor(motor({ meta: fileMotorIdentity(ref({ designation: 'C6', manufacturer: 'Estes Industries', motorType: 'reload', digest: 'abc' })) }),
      undefined, noLibrary)).toMatchObject({ manufacturer: 'Estes Industries', type: 'single', digest: 'abc' });
  });

  it.each(['maker', 'designation'] as const)('drops the old identity after a %s substitution on open', async changed => {
    const db = MOTOR_DB.find(m => m.type === 'SU')!;
    const source = ref({ designation: db.designation,
      manufacturer: changed === 'maker' ? 'File maker A' : db.manufacturerAbbrev,
      digest: 'original-motor-digest', motorType: 'reload' });
    const loaded = await matchImportedMotor(source, { findDb: () => db, exMotors: [],
      fetchSpec: async (_row, delay) => ({ ...motor({ spec: { designation: db.designation, ejectionDelay: delay } }).spec,
        times: [0, 1], thrusts: [0, 1], masses: [0.1, 0.05], cgX: 0.035 }) });
    expect(loaded.motor!.spec.designation).toBe(db.designation);
    if (changed === 'designation') {
      // A spelling change during matching is the same motor. A replacement
      // changes the catalogue identity, even when source metadata survives.
      const replacement = MOTOR_DB.find(row => row.type === 'SU' && row.manufacturerAbbrev === db.manufacturerAbbrev
        && row.designation !== db.designation)!;
      loaded.motor = { ...loaded.motor!, meta: { ...loaded.motor!.meta, motorId: replacement.motorId },
        spec: { ...loaded.motor!.spec, designation: replacement.designation } };
    }
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const records = { [mount]: loaded.motor! };
    const configs = [{ id: 'copy', name: 'Copied configuration', isDefault: true, motors: structuredClone(records) }];
    const xml = exportOrk({ name: 'Substituted motor', tree,
      motors: exportMotorsMap({ tree, assigned: Object.entries(records), unmatchedRefs: {}, activeConfigId: 'copy', exLibrary: noLibrary }),
      configs: exportConfigs(configs, tree, noLibrary), activeConfigId: 'copy' });
    const recovery = autosaveToOrk({ tree, mountMotors: records, savedConfigs: configs, activeConfigId: 'copy',
      launch: DEFAULT_CONDITIONS, savedAt: 0, configLayers: 1, motorLengthLimitsMigrated: true }).xml;
    for (const document of [xml, await decodeShareFragment(await encodeShareFragment(xml)), recovery]) {
      expect(document).not.toContain('<digest>original-motor-digest</digest>');
      const opened = importOrk(document);
      for (const saved of [...Object.values(opened.motors), ...opened.configs.flatMap(c => Object.values(c.motors))]) {
        expect(saved).toMatchObject({ designation: loaded.motor!.spec.designation, manufacturer: db.manufacturerAbbrev, motorType: 'single' });
        expect(saved.digest).toBeUndefined();
      }
    }
  });

  it('the makerless G80 equivalent cannot export the file motor identity', async () => {
    const target = matchDbMotor('G80')!.curveEquivalent!;
    expect(target).toBeDefined();
    const result = await matchImportedMotor(ref({ designation: 'G80', manufacturer: '', diameter: 0, length: 0,
      digest: 'old-g80-digest', motorType: 'hybrid' }), {
      exMotors: [], fetchSpec: async (row, delay) => ({ ...motor({ spec: { designation: row.designation, ejectionDelay: delay } }).spec,
        times: [0, 1], thrusts: [0, 1], masses: [0.1, 0.05], cgX: 0.035 }),
    });
    expect(result.motor!.meta.motorId).toBe(target.motorId);
    const saved = toOrkMotor(result.motor!, undefined, noLibrary);
    expect(saved).toMatchObject({ designation: target.designation, manufacturer: target.manufacturerAbbrev,
      type: new Map([['SU', 'single'], ['reload', 'reload'], ['hybrid', 'hybrid']]).get(target.type) });
    expect(saved.digest).toBeUndefined();
  });

  it('keeps an unchanged motor digest through a save and reopen, including a changed delay', () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const mm = motor({ spec: { ejectionDelay: 7 }, meta: fileMotorIdentity(ref({
      designation: 'C6', manufacturer: 'Estes Industries', motorType: 'single', digest: 'exact-file-digest',
    })) });
    const xml = exportOrk({ name: 'Unchanged motor', tree, motors: { [mount]: toOrkMotor(mm, undefined, noLibrary) } });
    expect(Object.values(importOrk(xml).motors)[0]).toMatchObject({
      designation: 'C6', manufacturer: 'Estes Industries', motorType: 'single', digest: 'exact-file-digest', delay: 7,
    });
  });

  it.each([['loose', undefined], ['common-name', undefined], ['Micro Maxx', undefined], ['loose', 'unknown'],
    ['Micro Maxx', 'Unknown'], ['Micro Maxx', 'CUSTOM'], ['Micro Maxx', ' custom ']] as const)(
    'keeps an unchanged %s spelling variant and curve (sentinel maker: %s)', async (kind, sentinelMaker) => {
    const fileSpelling = (row: (typeof MOTOR_DB)[number]) => kind === 'loose' ? row.designation.replace(/^HP-/, '')
      : kind === 'Micro Maxx' ? row.designation.toLowerCase().replaceAll('_', ' ') : row.commonName;
    const db = MOTOR_DB.find(row => {
      const spelling = fileSpelling(row);
      return spelling !== row.designation && (kind === 'loose' ? row.designation.startsWith('HP-')
        : kind !== 'Micro Maxx' || /micro/i.test(row.designation))
        && matchDbMotor(spelling, row.diameter, undefined, sentinelMaker ?? row.manufacturerAbbrev)?.motor.motorId === row.motorId;
    })!;
    expect(db).toBeDefined();
    const spelling = fileSpelling(db);
    const files = await bundledSimFiles(db.motorId);
    const digest = files.flatMap(file => file.digests ?? [])[0]!;
    expect(digest).toBeTruthy();
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const sourceXml = exportOrk({ name: 'Original spelling variant', tree, motors: { [mount]: {
      designation: spelling, manufacturer: db.manufacturerAbbrev, diameter: db.diameter / 1000,
      length: db.length / 1000, digest, type: db.type === 'SU' ? 'single' : db.type, delay: 6,
    } } });
    const source = Object.values(importOrk(sentinelMaker === undefined ? sourceXml
      : sourceXml.replace(/<manufacturer>[^<]*<\/manufacturer>/, `<manufacturer>${sentinelMaker}</manufacturer>`)).motors)[0]!;
    const loaded = (await matchImportedMotor(source, { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
    expect(loaded.meta.motorId).toBe(db.motorId);
    expect(loaded.spec.designation).not.toBe(spelling);
    if (sentinelMaker !== undefined) expect(loaded.meta).not.toHaveProperty('orkManufacturer');
    const xml = exportOrk({ name: 'Unchanged spelling variant', tree, motors: { [mount]: toOrkMotor(loaded, undefined, noLibrary) } });
    const saved = Object.values(importOrk(xml).motors)[0]!;
    expect(saved).toMatchObject({ digest, motorType: db.type === 'SU' ? 'single' : db.type });
    const reopened = (await matchImportedMotor(saved, { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
    expect(reopened.meta.motorId).toBe(db.motorId);
    expect(reopened.spec.times).toEqual(loaded.spec.times);
    expect(reopened.spec.thrusts).toEqual(loaded.spec.thrusts);
    expect(reopened.spec.masses).toEqual(loaded.spec.masses);
  });

  it.for(['', 'Unknown', 'custom', 'named'])('checks digest ownership and type for a reference (%j)', async (manufacturer, ctx) => {
    // Find two makers' same-designation motors and their actual bundled digests.
    let pair;
    for (const row of MOTOR_DB) {
      if (!['SU', 'reload', 'hybrid'].includes(row.type)) continue;
      const match = matchDbMotor(row.designation, row.diameter, undefined, manufacturer === 'named' ? row.manufacturerAbbrev : manufacturer);
      if (match?.motor.motorId !== row.motorId || match.curveEquivalent) continue;
      const files = await bundledSimFiles(row.motorId);
      const ownDigest = files.flatMap(file => file.digests ?? []).find(digest => pickDigestFile(files, digest, row));
      if (!ownDigest) continue;
      for (const other of MOTOR_DB.filter(m => m.designation === row.designation
        && !manufacturerMatches(m.manufacturerAbbrev, row.manufacturerAbbrev))) {
        const foreignDigest = (await bundledSimFiles(other.motorId)).flatMap(file => file.digests ?? [])
          .find(digest => !pickDigestFile(files, digest, row));
        if (foreignDigest) { pair = { row, ownDigest, foreignDigest }; break; }
      }
      if (pair) break;
    }
    if (!pair) { ctx.skip('No matched same-designation pair of different makers has distinct bundled digests'); return; }
    const { row, ownDigest, foreignDigest } = pair!;
    const expectedType = row.type === 'SU' ? 'single' : row.type;
    const conflictingType = expectedType === 'reload' ? 'single' : 'reload';
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    for (const digest of [foreignDigest, ownDigest]) {
      const source = ref({ manufacturer: manufacturer === 'named' ? row.manufacturerAbbrev : manufacturer,
        designation: row.designation, diameter: row.diameter / 1000,
        length: row.length / 1000, digest, motorType: conflictingType });
      const loaded = (await matchImportedMotor(source, { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
      expect(loaded.meta.motorId).toBe(row.motorId);
      if (digest === foreignDigest) expect(loaded.meta.orkType).toBeUndefined();
      const xml = exportOrk({ name: 'Digest ownership', tree, motors: { [mount]: toOrkMotor(loaded, undefined, noLibrary) } });
      const saved = Object.values(importOrk(xml).motors)[0]!;
      expect(saved.digest).toBe(digest === ownDigest ? ownDigest : undefined);
      expect(saved.motorType).toBe(expectedType);
      const reopened = (await matchImportedMotor(saved, { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
      expect(reopened.meta.motorId).toBe(loaded.meta.motorId);
      expect(reopened.spec.times).toEqual(loaded.spec.times);
      expect(reopened.spec.thrusts).toEqual(loaded.spec.thrusts);
      expect(reopened.spec.masses).toEqual(loaded.spec.masses);
    }
  });

  it('corrects a makerless matched type with a foreign digest or no digest', async ctx => {
    let pair;
    for (const other of MOTOR_DB) {
      const designation = other.commonName;
      const match = matchDbMotor(designation, undefined, undefined, '');
      const row = match?.motor;
      if (!row || match.curveEquivalent || !['SU', 'reload', 'hybrid'].includes(row.type)
        || !['SU', 'reload', 'hybrid'].includes(other.type) || other.type === row.type
        || manufacturerMatches(row.manufacturerAbbrev, other.manufacturerAbbrev)) continue;
      const own = await bundledSimFiles(row.motorId);
      if (!own.length) continue;
      const foreignDigest = (await bundledSimFiles(other.motorId)).flatMap(f => f.digests ?? [])
        .find(digest => !pickDigestFile(own, digest, row));
      if (foreignDigest) { pair = { row, other, designation, foreignDigest }; break; }
    }
    if (!pair) { ctx.skip('No makerless matched row has a different-maker/type sibling with a foreign bundled digest'); return; }
    const { row, other, designation, foreignDigest } = pair;
    const expectedType = row.type === 'SU' ? 'single' : row.type;
    const fileType = other.type === 'SU' ? 'single' : other.type;
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    for (const digest of [foreignDigest, undefined]) {
      const loaded = (await matchImportedMotor(ref({ manufacturer: '', designation, diameter: 0, motorType: fileType, digest }),
        { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
      expect(loaded.meta.motorId).toBe(row.motorId);
      const saved = Object.values(importOrk(exportOrk({ name: 'Makerless type', tree,
        motors: { [mount]: toOrkMotor(loaded, undefined, noLibrary) } })).motors)[0]!;
      expect(saved.motorType).toBe(expectedType);
      expect(saved.digest).toBeUndefined();
    }
  });

  it('keeps an unowned digest and an equivalent sibling digest', async () => {
    let pair;
    for (const row of MOTOR_DB.filter(m => /^HP-/i.test(m.designation))) {
      const sibling = MOTOR_DB.find(m => m.motorId !== row.motorId
        && manufacturerMatches(m.manufacturerAbbrev, row.manufacturerAbbrev)
        && displayDesignation(m.designation, m.manufacturerAbbrev) === displayDesignation(row.designation, row.manufacturerAbbrev));
      if (!sibling) continue;
      const own = await bundledSimFiles(row.motorId);
      const digest = (await bundledSimFiles(sibling.motorId)).flatMap(f => f.digests ?? [])
        .find(d => !pickDigestFile(own, d, row));
      if (digest && matchDbMotor(row.designation, row.diameter, undefined, row.manufacturerAbbrev)?.motor.motorId === row.motorId) {
        pair = { row, digest }; break;
      }
    }
    expect(pair).toBeDefined();
    const { row, digest } = pair!;
    const allDigests = new Set((await Promise.all(MOTOR_DB.map(m => bundledSimFiles(m.motorId))))
      .flatMap(files => files.flatMap(f => f.digests ?? [])));
    const unowned = '0'.repeat(32);
    expect(allDigests.has(unowned)).toBe(false);
    for (const manufacturer of ['', row.manufacturerAbbrev]) {
      for (const value of [digest, unowned]) {
        const loaded = (await matchImportedMotor(ref({ manufacturer, designation: row.designation,
          diameter: row.diameter / 1000, digest: value, motorType: row.type === 'SU' ? 'single' : row.type }),
        { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
        expect(loaded.meta.motorId).toBe(row.motorId);
        expect(toOrkMotor(loaded, undefined, noLibrary).digest).toBe(value);
      }
    }
  });

  it('drops a digest owned by a different designation of the same maker', async () => {
    let pair;
    for (const row of MOTOR_DB.filter(m => m.type === 'SU')) {
      if (matchDbMotor(row.designation, row.diameter, undefined, row.manufacturerAbbrev)?.motor.motorId !== row.motorId) continue;
      const own = await bundledSimFiles(row.motorId);
      if (!own.length) continue;
      for (const other of MOTOR_DB.filter(m => m.manufacturerAbbrev === row.manufacturerAbbrev && m.designation !== row.designation)) {
        const digest = (await bundledSimFiles(other.motorId)).flatMap(f => f.digests ?? [])
          .find(d => !pickDigestFile(own, d, row));
        if (digest) { pair = { row, digest }; break; }
      }
      if (pair) break;
    }
    expect(pair).toBeDefined();
    const { row, digest } = pair!;
    const loaded = (await matchImportedMotor(ref({ manufacturer: row.manufacturerAbbrev, designation: row.designation,
      diameter: row.diameter / 1000, motorType: 'single', digest }), { fetchSpec: bundledOnlyFetchSpec, exMotors: [] })).motor!;
    expect(loaded.meta.motorId).toBe(row.motorId);
    expect(loaded.meta.orkType).toBeUndefined();
    const saved = toOrkMotor(loaded, undefined, noLibrary);
    expect(saved.digest).toBeUndefined();
    expect(saved.type).toBe('single');
  });

  it('keeps the ID-based digest fallback when the loaded motor has no bundled files', async () => {
    const row = { ...MOTOR_DB[0]!, motorId: 'no-bundled-files' };
    expect(await bundledSimFiles(row.motorId)).toEqual([]);
    const source = ref({ manufacturer: '', designation: row.designation, digest: 'unverifiable-file-digest' });
    const loaded = (await matchImportedMotor(source, { findDb: () => row, exMotors: [],
      fetchSpec: async () => ({ ...motor().spec, times: [0, 1], thrusts: [0, 1], masses: [0.1, 0.05], cgX: 0.035 }) })).motor!;
    expect(toOrkMotor(loaded, undefined, noLibrary).digest).toBe(source.digest);
  });

  it('keeps a legacy session identity when its original maker still matches', () => {
    expect(toOrkMotor(motor({ meta: { orkManufacturer: 'Estes Industries', orkType: 'reload', orkDigest: 'legacy-digest' } }),
      undefined, noLibrary)).toMatchObject({ manufacturer: 'Estes Industries', type: 'single', digest: 'legacy-digest' });
  });

  it.each(['unknown', 'custom', 'Unknown', 'CUSTOM', ' custom '])('the XML writer omits sentinel maker %j without losing the reference digest', manufacturer => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const xml = exportOrk({ name: 'Sentinel maker', tree, motors: { [mount]: {
      ...ref({ manufacturer }), type: 'single', digest: 'unchanged-digest',
    } } });
    expect(xml).not.toContain('<manufacturer>');
    expect(Object.values(importOrk(xml).motors)[0]).toMatchObject({ manufacturer: 'unknown', digest: 'unchanged-digest' });
  });

  it('does not trust legacy session identity after its original maker was removed or changed', () => {
    expect(toOrkMotor(motor({ meta: { orkManufacturer: 'Old maker', orkType: 'reload', orkDigest: 'old-digest' } }),
      undefined, noLibrary)).toMatchObject({ manufacturer: 'Estes', type: 'single' });
    expect(toOrkMotor(motor({ meta: { orkDigest: 'old-digest' } }), undefined, noLibrary)).not.toHaveProperty('digest');
  });

  it('an EX replacement uses its own type rather than the old file type', () => {
    const mm = exMotor(fileMotorIdentity(ref({ designation: 'X99', manufacturer: 'Loki', motorType: 'single', digest: 'old-digest' })));
    expect(toOrkMotor(mm, undefined, library)).toMatchObject({ manufacturer: 'Acme', type: 'reload' });
    expect(toOrkMotor(mm, undefined, library)).not.toHaveProperty('digest');
  });

  it('keeps the file type for its single matching imported EX motor without a digest', async () => {
    const ex = parseEng('I300T 38 200 6 0.1 0.2 Cesaroni\n0 0\n0.5 300\n1 0\n')[0]!;
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const source = ref({ designation: 'I300T', manufacturer: 'Cesaroni', diameter: 0.038,
      length: 0.2, motorType: 'reload', digest: 'desktop-file-digest' });
    const loaded = (await matchImportedMotor(source, { catalogue: [], exMotors: [ex] })).motor!;
    expect(loaded.meta).toMatchObject({ manufacturer: 'EX', type: 'SU', orkType: 'reload' });
    const saved = toOrkMotor(loaded, undefined, () => [ex]);
    const xml = exportOrk({ name: 'Unchanged imported EX motor', tree, motors: { [mount]: saved } });
    expect(Object.values(importOrk(xml).motors)[0]).toMatchObject({
      designation: 'I300T', manufacturer: 'Cesaroni', motorType: 'reload',
    });
    expect(saved).not.toHaveProperty('digest');
    expect(xml).not.toContain('<digest>');

    const reopened = (await matchImportedMotor(Object.values(importOrk(xml).motors)[0]!,
      { catalogue: [], exMotors: [] })).motor!;
    expect(reopened).toBeDefined();
    const secondXml = exportOrk({ name: 'Second EX save', tree,
      motors: { [mount]: toOrkMotor(reopened, undefined, noLibrary) } });
    expect(Object.values(importOrk(secondXml).motors)[0]!.motorType).toBe('reload');
    expect(secondXml).not.toContain('<digest>');

    // A same-maker replacement retains stale source fields but owns another ID.
    const replacement = { ...loaded, spec: { ...loaded.spec, designation: 'I400T' },
      meta: { ...loaded.meta, motorId: 'ex:cesaroni-i400t' } };
    expect(toOrkMotor(replacement, undefined, () => [ex])).toMatchObject({ type: 'single' });
    const otherMaker = { ...loaded, spec: { ...loaded.spec, exDefinition: { ...ex, realManufacturer: 'Loki' } } };
    expect(toOrkMotor(otherMaker, undefined, () => [ex])).toMatchObject({ manufacturer: 'Loki', type: 'single' });
  });

  it('keeps a legacy EX type when its recorded real maker still matches', () => {
    const mm = exMotor({ type: 'SU', exMotorId: 'ex:loki-x99', orkManufacturer: 'Loki Research', orkType: 'reload', orkDigest: 'legacy-digest' });
    expect(toOrkMotor(mm, undefined, library)).toMatchObject({ manufacturer: 'Loki', type: 'reload' });
    expect(toOrkMotor(mm, undefined, library)).not.toHaveProperty('digest');
    expect(toOrkMotor({ ...mm, meta: { ...mm.meta, orkMotorId: '' } }, undefined, library).type).toBe('single');
  });

  it('keeps an embedded EX type without a named maker, but rejects another embedded motor', async () => {
    const ex = parseEng('X99 38 200 6 0.1 0.2 EX\n0 0\n0.5 300\n1 0\n')[0]!;
    const source = ref({ designation: 'X99', manufacturer: 'unknown', diameter: 0.038,
      motorType: 'reload', exMotorId: ex.motorId, exDefinition: ex });
    const loaded = (await matchImportedMotor(source)).motor!;
    expect(toOrkMotor(loaded, undefined, noLibrary).type).toBe('reload');
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const xml = exportOrk({ name: 'Makerless embedded EX', tree,
      motors: { [mount]: toOrkMotor(loaded, undefined, noLibrary) } });
    const reopened = (await matchImportedMotor(Object.values(importOrk(xml).motors)[0]!)).motor!;
    expect(toOrkMotor(reopened, undefined, noLibrary).type).toBe('reload');
    const wrong = (await matchImportedMotor({ ...source, designation: 'Different motor' })).motor!;
    expect(toOrkMotor(wrong, undefined, noLibrary).type).toBe('single');
  });

  it('checks the maker even when a stale record still carries the original maker', () => {
    const mm = motor({ meta: { ...fileMotorIdentity(ref({ designation: 'C6', manufacturer: 'Another maker',
      motorType: 'reload', digest: 'old-digest' })), type: undefined } });
    const saved = toOrkMotor(mm, undefined, noLibrary);
    expect(saved.manufacturer).toBe('Estes');
    expect(saved).not.toHaveProperty('digest');
    expect(saved).not.toHaveProperty('type');
  });

  it('maps the catalogue’s type to desktop’s names, and leaves out a type it does not know', () => {
    const typeOf = (type: string | undefined) => toOrkMotor(motor({ meta: { type } }), undefined, noLibrary).type;
    expect([typeOf('SU'), typeOf('reload'), typeOf('hybrid')]).toEqual(['single', 'reload', 'hybrid']);
    expect(typeOf('plugged-something')).toBeUndefined();
    expect(typeOf(undefined)).toBeUndefined();
  });

  it('carries the weighed pad mass only when it is a positive number', () => {
    expect(toOrkMotor(motor({ padMassKg: 0.25 }), undefined, noLibrary).padMassKg).toBe(0.25);
    expect(toOrkMotor(motor({ padMassKg: 0 }), undefined, noLibrary)).not.toHaveProperty('padMassKg');
  });
});

describe('toOrkMotor — the Auto delay', () => {
  const auto = motor({ meta: { autoDelay: true } });

  it('writes an Auto mount at the delay it flew, and says it flew it', () => {
    expect(toOrkMotor(auto, 7, noLibrary)).toMatchObject({ delay: 7, autoDelay: true, autoDelayFrom: 'flown' });
  });

  it('with no flight keeps the provisional delay, and says it is provisional', () => {
    expect(toOrkMotor(auto, undefined, noLibrary))
      .toMatchObject({ delay: 5, autoDelay: true, autoDelayFrom: 'provisional' });
  });

  it('a typed delay ignores any flown figure and carries no Auto flags', () => {
    const fixed = toOrkMotor(motor(), 7, noLibrary);
    expect(fixed.delay).toBe(5);
    expect(fixed).not.toHaveProperty('autoDelay');
    expect(fixed).not.toHaveProperty('autoDelayFrom');
  });

  it('a plugged motor stays plugged', () => {
    expect(toOrkMotor(motor({ spec: { ejectionDelay: Infinity } }), undefined, noLibrary).delay).toBe(Infinity);
  });
});

describe('orkMotorSet', () => {
  it('reads each Auto mount’s flown delay from its own configuration', () => {
    const { tree, core } = podTree();
    const records = { [core]: motor({ meta: { autoDelay: true } }) };
    const flown = { A: { [core]: 7 }, B: { [core]: 9 } };
    const delayIn = (configKey: string) =>
      orkMotorSet({ records, tree, flown, configKey, exLibrary: noLibrary, first: 'refs' })[core]!.delay;
    expect([delayIn('A'), delayIn('B')]).toEqual([7, 9]);
    // No entry for the configuration: the provisional delay. A file-sourced id
    // that names something every object inherits finds nothing either.
    expect([delayIn(''), delayIn('constructor'), delayIn('__proto__')]).toEqual([5, 5, 5]);
    // Even where what it inherits has a number under the mount's id: read
    // through the prototype, "constructor" is Object, whose `length` is 1.
    const inherited = orkMotorSet({
      records: { length: motor({ meta: { autoDelay: true } }) }, tree, flown: {}, configKey: 'constructor',
      exLibrary: noLibrary, first: 'refs',
    });
    expect(inherited.length!.delay).toBe(5);
  });

  it('takes no flown figure that is not a delay', () => {
    const { tree, core } = podTree();
    const records = { [core]: motor({ meta: { autoDelay: true } }) };
    for (const bad of ['7', -1, NaN, Infinity, null]) {
      const flown = { '': { [core]: bad } } as unknown as Record<string, Record<string, number>>;
      const out = orkMotorSet({ records, tree, flown, configKey: '', exLibrary: noLibrary, first: 'records' });
      expect(out[core]!.delay, String(bad)).toBe(5);
    }
  });

  // The rank decides these, whichever order a caller hands the set in.
  for (const first of ['records', 'refs'] as const) {
    it(`keeps the weighed pad mass on the primary mount alone (${first} first)`, () => {
      const { tree, core } = podTree();
      const out = orkMotorSet({
        records: {
          'pod-mmt': motor({ padMassKg: 0.3 }), [core]: motor({ padMassKg: 0.25 }),
          // A record for a mount the tree no longer has can neither win nor keep one.
          gone: motor({ padMassKg: 0.4 }),
        },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(out[core]!.padMassKg).toBe(0.25);
      expect(out['pod-mmt']).not.toHaveProperty('padMassKg');
      expect(out.gone).not.toHaveProperty('padMassKg');
    });

    it(`writes a reference only on a mount the tree has, with nothing loaded on it (${first} first)`, () => {
      const { tree, core } = podTree();
      const out = orkMotorSet({
        records: { [core]: motor() },
        refs: { [core]: ref({ designation: 'LOSES' }), 'pod-mmt': ref(), gone: ref({ designation: 'GONE' }) },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(Object.fromEntries(Object.entries(out).map(([id, m]) => [id, m.designation])))
        .toEqual({ [core]: 'C6', 'pod-mmt': 'ZQ9999X' });
    });

    it(`keeps a reference’s pad mass when the reference is the primary (${first} first)`, () => {
      const { tree, core } = podTree();
      const out = orkMotorSet({
        records: { 'pod-mmt': motor({ padMassKg: 0.3 }) },
        refs: { [core]: ref({ padMassKg: 0.5 }) },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(out[core]!.padMassKg).toBe(0.5);
      expect(out['pod-mmt']).not.toHaveProperty('padMassKg');
    });
  }
});

/**
 * TWO MOUNTS IN THE SAME STAGE AND RANK (verifier's review of audit 2026-09-30,
 * item 23). primaryMountOf ranks a tie by the order it is handed, so whether a
 * set's loaded motors or its references come first decides which mount keeps
 * the weighed pad mass. App's two writers always built their sets in different
 * orders, and the first copy of this module wrote both loaded motors first: a
 * stored configuration whose pad mass the file put on a reference it named first
 * was saved without it.
 */
describe('orkMotorSet — a tie for the pad mass', () => {
  it('references first (a stored configuration): the reference keeps it', () => {
    const { tree, starter } = tieTree();
    const out = orkMotorSet({
      records: { 'mmt-b': motor() }, refs: { [starter]: ref({ padMassKg: 0.5 }) },
      tree, configKey: 'X', exLibrary: noLibrary, first: 'refs',
    });
    expect(out[starter]!.padMassKg).toBe(0.5);
    expect(out['mmt-b']).not.toHaveProperty('padMassKg');
  });

  it('references first: a mount with both writes its loaded motor, in its reference’s place', () => {
    const { tree, starter } = tieTree();
    const out = orkMotorSet({
      records: { 'mmt-b': motor({ padMassKg: 0.42 }) },
      refs: { 'mmt-b': ref({ designation: 'LOSES' }), [starter]: ref({ padMassKg: 0.5 }) },
      tree, configKey: 'X', exLibrary: noLibrary, first: 'refs',
    });
    expect(out['mmt-b']).toMatchObject({ designation: 'C6', padMassKg: 0.42 });
    expect(out[starter]).not.toHaveProperty('padMassKg');
  });

  it('loaded motors first (the working set): the loaded motor keeps it, where its card shows the field', () => {
    const { tree, starter } = tieTree();
    const out = orkMotorSet({
      records: { 'mmt-b': motor({ padMassKg: 0.42 }) }, refs: { [starter]: ref() },
      tree, configKey: '', exLibrary: noLibrary, first: 'records',
    });
    expect(out['mmt-b']!.padMassKg).toBe(0.42);
    expect(out[starter]).not.toHaveProperty('padMassKg');
  });

  // The file's pad mass on the reference it named first, the loaded motor
  // beside it carrying none: what importApply leaves when the file's first
  // mount could not be loaded. The import note promises it saves unchanged.
  for (const first of ['records', 'refs'] as const) {
    it(`a tied mount's pad mass is kept when the primary carries none (${first} first)`, () => {
      const { tree, starter } = tieTree();
      const out = orkMotorSet({
        records: { 'mmt-b': motor() }, refs: { [starter]: ref({ padMassKg: 0.5 }) },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(out[starter]!.padMassKg).toBe(0.5);
      expect(out['mmt-b']).not.toHaveProperty('padMassKg');
      // The same with the file's motor loaded later, which adopts the value
      // on its own record, behind the other mount's.
      const loaded = orkMotorSet({
        records: { 'mmt-b': motor(), [starter]: motor({ padMassKg: 0.5 }) },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(loaded[starter]!.padMassKg).toBe(0.5);
      expect(loaded['mmt-b']).not.toHaveProperty('padMassKg');
    });
  }

  // The value behind the tied mount, then a pad mass typed on the primary's
  // card and cleared: the typed value superseded the file's, so the clear
  // must not bring the file's back on the next Save (typedPadMass).
  it('a pad mass typed on the primary, then cleared, does not bring back a tied mount’s', () => {
    const { tree, starter } = tieTree();
    const save = (records: Record<string, MountMotor>) =>
      orkMotorSet({ records, tree, configKey: '', exLibrary: noLibrary, first: 'records' });
    const opened = { 'mmt-b': motor(), [starter]: motor({ padMassKg: 0.5 }) };
    expect(save(opened)[starter]!.padMassKg).toBe(0.5);
    const typed = typedPadMass(tree, 'mmt-b', 0.7, 'set')(opened);
    expect(typed['mmt-b']).toMatchObject({ padMassKg: 0.7, padMassWeighedWith: 'set' });
    expect(typed[starter]).not.toHaveProperty('padMassKg');
    expect(save(typed)['mmt-b']!.padMassKg).toBe(0.7);
    const cleared = typedPadMass(tree, 'mmt-b', null, 'set')(typed);
    for (const m of Object.values(save(cleared))) expect(m).not.toHaveProperty('padMassKg');
    // A clear on its own supersedes it too.
    for (const m of Object.values(save(typedPadMass(tree, 'mmt-b', null, 'set')(opened)))) {
      expect(m).not.toHaveProperty('padMassKg');
    }
  });

  it('a pad mass typed on the primary leaves a mount ranked below it alone', () => {
    const { tree, core } = podTree();
    const typed = typedPadMass(tree, core, 1.2, 'set')({ [core]: motor(), 'pod-mmt': motor({ padMassKg: 0.3 }) });
    expect(typed[core]!.padMassKg).toBe(1.2);
    expect(typed['pod-mmt']!.padMassKg).toBe(0.3);
  });

  it('never takes a pad mass from a mount ranked below the primary', () => {
    // A pod set's mount under a core mount carrying none: not a tie.
    const { tree, core } = podTree();
    for (const first of ['records', 'refs'] as const) {
      const out = orkMotorSet({
        records: { [core]: motor() }, refs: { 'pod-mmt': ref({ padMassKg: 0.3 }) },
        tree, configKey: '', exLibrary: noLibrary, first,
      });
      expect(out[core]).not.toHaveProperty('padMassKg');
      expect(out['pod-mmt']).not.toHaveProperty('padMassKg');
    }
  });
});

it('motor label migration preserves .ork, .rkt and .CDX1 export bytes', () => {
  const entry = MOTOR_DB.find(m => m.designation === 'F67C')!;
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const mm = motor({ spec: { designation: entry.designation, ejectionDelay: 9 },
    meta: { motorId: entry.motorId, manufacturer: entry.manufacturerAbbrev } });
  mm.label = 'F67-9';
  mm.meta.label = 'F67-9';
  const before = { [mount]: mm };
  const after = restoreMotorLabels(before);
  expect(after[mount]!.label).toBe('F67C-9');
  const oldMotor = toOrkMotor(mm, undefined, noLibrary);
  const newMotor = toOrkMotor(after[mount]!, undefined, noLibrary);
  expect(newMotor).toEqual(oldMotor);
  const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  try {
    for (const writer of [exportOrk, exportRkt, exportCdx1]) {
      const args = { name: 'Labels', tree, engineExport: true };
      expect(writer({ ...args, motors: { [mount]: newMotor } })).toBe(writer({ ...args, motors: { [mount]: oldMotor } }));
    }
  } finally { uuid.mockRestore(); }
});
