import { describe, expect, it, vi } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { addChild, defaultTree, motorMounts } from '../tree/treeModel.js';
import { orkMotorSet, toOrkMotor, type ExLibrary } from './orkExportMotors.js';
import type { OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';

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

  it('is found by designation when no entry is pinned, or the pinned one is gone', () => {
    expect(toOrkMotor(exMotor(), undefined, library).manufacturer).toBe('Acme');
    expect(toOrkMotor(exMotor({ exMotorId: 'ex:deleted' }), undefined, library).manufacturer).toBe('Acme');
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
  it('writes the file’s own manufacturer, type and digest over the catalogue’s', () => {
    expect(toOrkMotor(motor({ meta: { orkManufacturer: 'Estes Industries', orkType: 'reload', orkDigest: 'abc' } }),
      undefined, noLibrary)).toMatchObject({ manufacturer: 'Estes Industries', type: 'reload', digest: 'abc' });
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
});
