import { describe, expect, it } from 'vitest';
import type {
  FlightResult, IgnitionEvent, MotorSpec, RocketTree, StaticInfo,
} from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { defaultTree, motorMounts, normalizeTree, primaryMountOf } from '../tree/treeModel.js';
import {
  buildDesign, KERNEL_HANDLES, type BuildHandle, type DesignBuildInput, type HandleFactory,
} from './buildDesign.js';
import { padMassSetKey } from './configSync.js';
import { catalogueMotorMass } from './hardwareMass.js';
import { findDbMotor } from './motorDb.js';
import { fetchMotorSpec } from './thrustcurve.js';

/**
 * THE DESIGN BUILD (audit 2026-09-22, row 494, extraction #2). App's build
 * memo carried two orderings that decide numbers and that only its comments
 * pinned; these pin them by what the build DOES — against a handle that
 * records every call, and on the real kernel.
 */

// ---------------------------------------------------------------------------
// A handle that records what it is told.
// ---------------------------------------------------------------------------

type Call =
  | ['reset'] | ['build']
  | ['kbf', boolean] | ['supersonic', boolean]
  | ['motor', string, number] // mount, the spec's loaded mass (so the hardware write shows)
  | ['ignition', string, IgnitionEvent, number]
  | ['staticInfo'];

function recordingFactory(opts: {
  warningTexts?: string[];
  massEmpty?: number;
  /** Refuse to build any engine tree holding a component of this name. */
  refuseNamed?: string;
} = {}): { handles: HandleFactory<BuildHandle>; calls: Call[] } {
  const calls: Call[] = [];
  const holds = (nodes: RocketTree['components'], name: string): boolean =>
    nodes.some((n) => n.name === name || holds(n.children ?? [], name));
  const handle: BuildHandle = {
    setRogersModifiedBarrowman: (on: boolean) => { calls.push(['kbf', on]); },
    setSupersonicAero: (on: boolean) => { calls.push(['supersonic', on]); },
    setMotorById: (id: string, spec: MotorSpec) => { calls.push(['motor', id, spec.masses[0]!]); },
    setMotorIgnitionById: (id: string, event: IgnitionEvent, delay = 0) => { calls.push(['ignition', id, event, delay]); },
    simulate: () => { throw new Error('a build never flies'); },
    staticInfo: () => {
      calls.push(['staticInfo']);
      return {
        massEmpty: opts.massEmpty ?? 0.03, mass: 0.05, warningTexts: [...(opts.warningTexts ?? [])],
      } as unknown as StaticInfo;
    },
  };
  return {
    calls,
    handles: {
      reset: () => { calls.push(['reset']); },
      build: (engine) => {
        calls.push(['build']);
        if (opts.refuseNamed && holds(engine.components, opts.refuseNamed)) {
          throw new Error('Unknown component type: \'widget\'');
        }
        return handle;
      },
    },
  };
}

const SPEC: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.2, 1.8], thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122],
  cgX: 0.035, ejectionDelay: 5,
};

function starter(ignition: MountMotor['ignition'], padOverKg: number | null, massEmpty = 0.03) {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const base: MountMotor = { label: 'C6-5', spec: SPEC, meta: { label: 'C6-5' }, ignition };
  const key = padMassSetKey(tree, { [mount]: base });
  const rec: MountMotor = padOverKg === null ? base : {
    ...base, padMassKg: massEmpty + catalogueMotorMass(tree, [[mount, base]])! + padOverKg, padMassWeighedWith: key,
  };
  const input: DesignBuildInput = {
    tree, assigned: [[mount, rec]], kbf: true, supersonic: false, measuredDryMassKg: null,
    primaryMountId: mount, currentSetKey: key,
  };
  return { input, mount };
}

describe('buildDesign — the order of the calls it makes', () => {
  it('sets both model flags before the first staticInfo, from a fresh engine', () => {
    const { handles, calls } = recordingFactory();
    const { input } = starter({ event: 'automatic', delay: 0 }, null);
    buildDesign({ ...input, kbf: false, supersonic: true }, handles);
    expect(calls.slice(0, 4)).toEqual([['reset'], ['build'], ['kbf', false], ['supersonic', true]]);
    // No pad mass: ONE staticInfo, as it always was.
    expect(calls.filter((c) => c[0] === 'staticInfo')).toHaveLength(1);
  });

  it('re-applies the primary’s ignition AFTER the weighed-hardware write, before the second staticInfo', () => {
    const { handles, calls } = recordingFactory();
    const { input, mount } = starter({ event: 'launch', delay: 2 }, 0.02);
    const built = buildDesign(input, handles);
    expect('error' in built ? built.error : built.hardware.state).toBe('ok');
    const firstInfo = calls.findIndex((c) => c[0] === 'staticInfo');
    const after = calls.slice(firstInfo + 1);
    // The shifted motor goes on (heavier than the catalogue by the 20 g of hardware)…
    expect(after[0]?.[0]).toBe('motor');
    expect(after[0]?.[1]).toBe(mount);
    expect(after[0]?.[2] as number).toBeCloseTo(SPEC.masses[0]! + 0.02, 9);
    // …and its ignition straight after it, or the mount is back on AUTOMATIC
    // for the static analysis and every flight on this handle.
    expect(after[1]).toEqual(['ignition', mount, 'launch', 2]);
    expect(after[2]).toEqual(['staticInfo']);
    expect(after).toHaveLength(3);
  });

  it('writes the catalogue motor first, with its ignition, before any analysis', () => {
    const { handles, calls } = recordingFactory();
    const { input, mount } = starter({ event: 'burnout', delay: 1 }, 0.02);
    buildDesign(input, handles);
    const firstInfo = calls.findIndex((c) => c[0] === 'staticInfo');
    expect(calls.slice(4, firstInfo)).toEqual([
      ['motor', mount, SPEC.masses[0]],
      ['ignition', mount, 'burnout', 1],
    ]);
  });

  it('a motor the kernel cannot light is reported, left off the handle and out of the arithmetic', () => {
    const { handles, calls } = recordingFactory();
    const { input, mount } = starter({ event: 'bogus' as IgnitionEvent, delay: 0 }, 0.02);
    const built = buildDesign(input, handles);
    if ('error' in built) throw new Error(built.error);
    expect(built.motorFailures.map((f) => f.mountId)).toEqual([mount]);
    expect(calls.some((c) => c[0] === 'motor')).toBe(false);
    // The primary still holds the value, so the arithmetic says why nothing is carried.
    expect(built.hardware).toEqual({ state: 'none', why: 'no-motor' });
  });
});

/**
 * A camera shroud lowers to a deliberately thick strake "fin", so the kernel's
 * THICK_FIN warning naming it is dropped. The wake sentence the app appends
 * names the shroud too — so it must be appended AFTER that filter, or a shroud
 * whose name happens to carry the kernel's token is filtered out of its own
 * sentence.
 */
describe('buildDesign — the warning strip', () => {
  const camTree = (name: string): RocketTree => normalizeTree({
    name: 'T', components: [{ type: 'stage', id: 's1', children: [
      { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
      { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, thickness: 0.001, children: [
        { type: 'fairing', id: 'cam', name, length: 0.08, width: 0.025, height: 0.02, angleOffset: 0,
          position: { method: 'top', offset: 0.30 } },
        { type: 'trapezoidfinset', id: 'f1', name: 'Fins', finCount: 3, rootChord: 0.10, height: 0.055,
          position: { method: 'bottom', offset: 0 } },
      ] },
    ] }],
  } as unknown as RocketTree);
  const noMotors = (tree: RocketTree): DesignBuildInput => ({
    tree, assigned: [], kbf: true, supersonic: false, measuredDryMassKg: null, primaryMountId: null,
    currentSetKey: '',
  });

  it('drops the kernel’s THICK_FIN about a shroud, keeps the rest, and appends the wake sentence after', () => {
    const name = 'THICK_FIN cam';
    const kernelThick = `[Warning.THICK_FIN]:  "${name}"`;
    const { handles } = recordingFactory({ warningTexts: [kernelThick, '[Warning.DISCONTINUITY]:  "Body tube"'] });
    const built = buildDesign(noMotors(camTree(name)), handles);
    if ('error' in built) throw new Error(built.error);
    expect(built.info.warningTexts).not.toContain(kernelThick);
    expect(built.info.warningTexts[0]).toBe('[Warning.DISCONTINUITY]:  "Body tube"');
    // The wake sentence names the shroud — and the token — and survives.
    expect(built.info.warningTexts).toHaveLength(2);
    expect(built.info.warningTexts[1]).toContain(`"${name}" at 0° sits 220 mm ahead of a fin of "Fins"`);
  });

  it('the same on the real kernel', () => {
    const built = buildDesign(noMotors(camTree('THICK_FIN cam')), KERNEL_HANDLES);
    if ('error' in built) throw new Error(built.error);
    expect(built.info.warningTexts.filter((w) => w.includes('"THICK_FIN cam" at 0° sits 220 mm ahead')))
      .toHaveLength(1);
  }, 60_000);
});

describe('buildDesign — a design the kernel refuses', () => {
  it('names the blocking part, found with trial builds through the SAME factory', () => {
    const { handles, calls } = recordingFactory({ refuseNamed: 'Widget' });
    const tree: RocketTree = {
      name: 'R', components: [{ id: 's1', type: 'stage', name: 'Sustainer', children: [
        { id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.012, thickness: 0.002 },
        { id: 'b1', type: 'bodytube', name: 'Body tube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          children: [{ id: 'w', type: 'widget', name: 'Widget' } as unknown as RocketTree['components'][number]] },
      ] }],
    } as RocketTree;
    const built = buildDesign({
      tree, assigned: [], kbf: true, supersonic: false, measuredDryMassKg: null, primaryMountId: null, currentSetKey: '',
    }, handles);
    expect(built).toEqual({
      error: 'This design could not be built. The likely cause: “Widget” — the rest of the design builds without it.'
        + ' (The simulation reported: Unknown component type: \'widget\')',
    });
    // Every trial started from a fresh engine, like the build itself.
    const builds = calls.filter((c) => c[0] === 'build').length;
    expect(builds).toBeGreaterThan(1);
    expect(calls.filter((c) => c[0] === 'reset')).toHaveLength(builds);
  });
});

/**
 * The first ordering, on the real kernel. A motor set NEVER to ignite, with a
 * weighed pad mass the arithmetic accepts: the hardware write installs a fresh
 * motor configuration on the mount, so unless the build re-applies the
 * ignition after it, the motor is back on AUTOMATIC and flies.
 */
describe('buildDesign — on the real kernel, the weighed motor keeps its ignition', () => {
  async function c6Design(ignition: MountMotor['ignition']) {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const spec = await fetchMotorSpec(findDbMotor('C6', undefined, undefined, 'Estes')!, 5);
    const base: MountMotor = { label: 'C6-5', spec, meta: { label: 'C6-5', manufacturer: 'Estes' }, ignition };
    const dry = (() => {
      const b = buildDesign({
        tree, assigned: [], kbf: true, supersonic: false, measuredDryMassKg: null, primaryMountId: null, currentSetKey: '',
      }, KERNEL_HANDLES);
      if ('error' in b) throw new Error(b.error);
      return b.info.massEmpty;
    })();
    const key = padMassSetKey(tree, { [mount]: base });
    const rec: MountMotor = {
      ...base, padMassKg: dry + catalogueMotorMass(tree, [[mount, base]])! + 0.02, padMassWeighedWith: key,
    };
    const assigned: [string, MountMotor][] = [[mount, rec]];
    return buildDesign({
      tree, assigned, kbf: true, supersonic: false, measuredDryMassKg: null,
      primaryMountId: primaryMountOf(tree, [mount]), currentSetKey: key,
    }, KERNEL_HANDLES);
  }
  const apogee = (b: Awaited<ReturnType<typeof c6Design>>): number => {
    if ('error' in b) throw new Error(b.error);
    expect(b.hardware.state).toBe('ok');
    return (b.rocket.simulate(kernelSimOptions(DEFAULT_CONDITIONS)) as FlightResult).summary.maxAltitude;
  };

  it('a motor set never to light stays unlit through the hardware write', async () => {
    // The control: the same weighed design on AUTOMATIC flies.
    expect(apogee(await c6Design({ event: 'automatic', delay: 0 }))).toBeGreaterThan(100);
    expect(apogee(await c6Design({ event: 'never', delay: 0 }))).toBeLessThan(1);
  }, 120_000);
});
