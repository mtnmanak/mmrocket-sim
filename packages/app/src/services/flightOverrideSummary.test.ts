import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightTree, IgnitionTuple, MountMotor } from '../model/design.js';
import { describeFlightOverrides, recordFlightOverrides } from './flightOverrideSummary.js';

const own: DeploymentTuple = { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 };
const flown: DeploymentTuple = { ...own, deployEvent: 'ejection' };
const tree: FlightTree = { components: [{ type: 'stage', id: 'sustainer', name: 'Sustainer' }, { type: 'stage', id: 'stage', name: 'Booster', children: [
  { type: 'parachute', id: 'a', name: 'Main', ...own },
  { type: 'parachute', id: 'b', name: 'Backup', ...own },
  { type: 'innertube', id: 'mount', name: 'Motor mount', motorMount: true },
] }], ignitionDefaults: { mount: { event: 'automatic', delay: 0 } } };
const motor = { ignition: { event: 'automatic', delay: 0 } } as MountMotor;

describe('launch override summary', () => {
  it('RES-1 batch drops only the swept mount ignition and preserves all other families', () => {
    const expanded: FlightTree = { ...tree, components: [...tree.components,
      { type: 'innertube', id: 'other', name: 'Other mount', motorMount: true }] };
    const records = recordFlightOverrides(expanded, {
      deployments: { a: flown },
      separations: { stage: { separationEvent: 'never', separationDelay: 0, separationAltitude: 0 } },
      ignitions: { mount: { event: 'never', delay: 0 }, other: { event: 'launch', delay: 2 } },
    }, { mount: motor, other: motor }, 'mount');
    expect(records.map(r => r.partName)).toEqual(['Booster', 'Main', 'Other mount']);
    expect(records.map(r => r.family)).toEqual(['separation', 'recovery', 'ignition']);
    expect(recordFlightOverrides(tree, {}, {})).toEqual([]);
  });
  it('RES-1 records detached SI tuples and names, never session component ids', () => {
    const overrides = { deployments: { a: { ...flown } } };
    const summary = describeFlightOverrides(tree, overrides, {}, 'Club flight', 'ft')!;
    expect(summary.records).toEqual([{ family: 'recovery', kind: 'parachute', partName: 'Main',
      flies: flown, own }]);
    overrides.deployments.a.deployAltitude = 999;
    expect(summary.records[0]!.flies).toEqual(flown);
    expect(JSON.stringify(summary.records)).not.toContain('"id"');
  });
  it.each(['launch', 'ignition', 'burnout', 'ejection', 'upperignition', 'apogee', 'never'])(
    'LW4 ignores dormant separation altitude for %s', separationEvent => {
      const defaults: FlightTree = { components: [{ type: 'stage', id: 'top' },
        { type: 'stage', id: 'stage', separationEvent, separationDelay: 2, separationAltitude: 200 }] };
      const overrides = { separations: { stage: { separationEvent, separationDelay: 2, separationAltitude: 300 } } };
      const before = structuredClone({ defaults, overrides });
      expect(describeFlightOverrides(defaults, overrides, {}, null, 'm')).toBeNull();
      expect({ defaults, overrides }).toEqual(before);
    });
  it.each(['BURNOUT', 'UPPER_IGNITION', 'ALTITUDE_ASCENDING', 'ALTITUDE_DESCENDING'])(
    'LW4 folds separation event %s like the bridge', separationEvent => {
      const defaults: FlightTree = { components: [{ type: 'stage', id: 'top' }, { type: 'stage', id: 'stage',
        separationEvent: separationEvent.toLowerCase().replaceAll('_', ''), separationDelay: 2, separationAltitude: 200 }] };
      expect(describeFlightOverrides(defaults, { separations: { stage: {
        separationEvent, separationDelay: 2, separationAltitude: 200,
      } } }, {}, null, 'm')).toBeNull();
    });
  it('LW4 ignores Never delays independently for all three families without changing stored tuples', () => {
    const defaults: FlightTree = { components: [{ type: 'stage', id: 'top' },
      { type: 'stage', id: 'stage', separationEvent: 'never', separationDelay: 0, separationAltitude: 200 },
      { type: 'parachute', id: 'a', ...own, deployEvent: 'never' },
      { type: 'innertube', id: 'mount', motorMount: true }],
    ignitionDefaults: { mount: { event: 'never', delay: 0 } } };
    const cases = [
      { deployments: { a: { ...own, deployEvent: 'NEVER', deployDelay: 2 } } },
      { separations: { stage: { separationEvent: 'NEVER', separationDelay: 2, separationAltitude: 200 } } },
      { ignitions: { mount: { event: 'never' as const, delay: 2 } } },
    ];
    const before = structuredClone({ defaults, cases });
    for (const overrides of cases) expect(describeFlightOverrides(defaults, overrides, { mount: motor }, null, 'm')).toBeNull();
    expect({ defaults, cases }).toEqual(before);
  });
  it.each(['altitudeascending', 'altitudedescending'])('LW4 retains active separation altitude and delay differences for %s', separationEvent => {
    const base = { separationEvent, separationDelay: 0, separationAltitude: 200 };
    const defaults: FlightTree = { components: [{ type: 'stage', id: 'top' }, { type: 'stage', id: 'stage', ...base }] };
    for (const tuple of [{ ...base, separationAltitude: 300 }, { ...base, separationDelay: 2 }]) {
      expect(describeFlightOverrides(defaults, { separations: { stage: tuple } }, {}, null, 'm')).not.toBeNull();
    }
  });
  it.each(['launch', 'ignition', 'burnout', 'ejection', 'upperignition', 'apogee'])(
    'LW4 retains active separation delay for %s', separationEvent => {
      const base = { separationEvent, separationDelay: 0, separationAltitude: 200 };
      const defaults: FlightTree = { components: [{ type: 'stage', id: 'top' }, { type: 'stage', id: 'stage', ...base }] };
      expect(describeFlightOverrides(defaults, { separations: { stage: { ...base, separationDelay: 2 } } }, {}, null, 'm')).not.toBeNull();
    });
  it.each(['launch', 'ejection', 'apogee', 'altitude'])('LW4 retains active recovery delay for %s', deployEvent => {
    const defaults: FlightTree = { components: [{ type: 'parachute', id: 'a', ...own, deployEvent }] };
    expect(describeFlightOverrides(defaults, { deployments: { a: { ...own, deployEvent, deployDelay: 2 } } }, {}, null, 'm')).not.toBeNull();
  });
  it.each(['automatic', 'launch', 'burnout', 'ejectioncharge'] as const)('LW4 retains active ignition delay for %s', event => {
    const defaults = { ...tree, ignitionDefaults: { mount: { event, delay: 0 } } };
    expect(describeFlightOverrides(defaults, { ignitions: { mount: { event, delay: 2 } } }, { mount: motor }, null, 'm')).not.toBeNull();
  });
  it.each(['LAUNCH', 'EJECTION_CHARGE', 'BURNOUT', 'NEVER', ' AUTOMATIC '])('LW4 folds ignition event %s like the flight runner', event => {
    const defaults = { ...tree, ignitionDefaults: { mount: { event: event.trim().toLowerCase().replaceAll('_', '') as IgnitionTuple['event'], delay: 2 } } };
    expect(describeFlightOverrides(defaults, { ignitions: { mount: { event: event as IgnitionTuple['event'], delay: 2 } } }, { mount: motor }, null, 'm')).toBeNull();
  });
  it.each(['flat', 'bottom', 'upper', 'parallel'] as const)('LW5 keeps automatic ignition distinct on the %s stage', kind => {
    const mount = { type: 'innertube' as const, id: 'mount', motorMount: true };
    const defaults: FlightTree = { components: kind === 'flat' ? [mount] : [
      { type: 'stage', id: 'top', children: kind === 'upper' ? [mount] : [] },
      { type: 'stage', id: 'bottom', children: kind === 'parallel' ? [{ type: 'parallelstage', id: 'strap', children: [mount] }] : kind === 'bottom' ? [mount] : [] },
    ], ignitionDefaults: { mount: { event: 'automatic', delay: 1 } } };
    const event = kind === 'upper' ? 'ejectioncharge' : 'launch';
    expect(describeFlightOverrides(defaults, { ignitions: { mount: { event, delay: 1 } } }, { mount: motor }, null, 'm')).not.toBeNull();
    // Equality must not depend on which spelling is the component default.
    expect(describeFlightOverrides({ ...defaults, ignitionDefaults: { mount: { event, delay: 1 } } },
      { ignitions: { mount: { event: 'automatic', delay: 1 } } }, { mount: motor }, null, 'm')).not.toBeNull();
    expect(describeFlightOverrides(defaults, { ignitions: { mount: { event, delay: 2 } } }, { mount: motor }, null, 'm')).not.toBeNull();
    expect(describeFlightOverrides(defaults, { ignitions: { mount: { event: event === 'launch' ? 'ejectioncharge' : 'launch', delay: 1 } } }, { mount: motor }, null, 'm')).not.toBeNull();
  });
  it('LW5 warns when retained strap-ons eject after the lower core separates', () => {
    const mount = (id: string): ComponentNode => ({ type: 'innertube', id, motorMount: true,
      length: 0.07, outerRadius: 0.0095, thickness: 0.0005, position: { method: 'bottom', offset: 0 } });
    const fins: ComponentNode = { type: 'freeformfinset', finCount: 3, thickness: 0.003, crossSection: 'airfoil',
      position: { method: 'bottom', offset: 0 },
      points: [[0, 0], [0.04, 0.06], [0.08, 0.06], [0.10, 0]] };
    const defaults: FlightTree = { components: [
      { type: 'stage', id: 'upper', children: [
        // Nose ballast keeps the staged fixture stable through the delayed ignition.
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, overrideMass: 0.06 },
        { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
          fins, mount('upper-mount'),
          { type: 'parallelstage', id: 'straps', instanceCount: 2, separationEvent: 'never',
            radiusMethod: 'relative', radiusOffset: 0, position: { method: 'bottom', offset: 0 }, children: [
              { type: 'nosecone', length: 0.04, aftRadius: 0.010, thickness: 0.001 },
              { type: 'bodytube', length: 0.15, outerRadius: 0.010, thickness: 0.0003, density: 950,
                children: [mount('strap-mount'), fins] },
            ] },
        ] },
      ] },
      { type: 'stage', id: 'lower', separationEvent: 'launch', separationDelay: 2, children: [
        { type: 'bodytube', length: 0.12, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [fins, mount('lower-mount')] },
      ] },
    ], ignitionDefaults: { 'upper-mount': { event: 'automatic', delay: 0 } } };
    const spec: MotorSpec = { designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 3,
      times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2], thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132] };
    const fly = (event: IgnitionTuple['event']) => {
      const rocket = OrkRocket.buildTree(defaults);
      for (const id of ['upper-mount', 'strap-mount', 'lower-mount']) rocket.setMotorById(id, spec);
      rocket.setMotorIgnitionById('upper-mount', event, 0);
      return rocket.simulate({ delayProbe: true, windAverage: 0, windStdDeviation: 0, maxTime: 15 }).delayProbe!.branches;
    };
    for (const event of ['automatic', 'ejectioncharge'] as const) {
      const branches = fly(event);
      const upper = branches.find(branch => branch.mountIds.includes('upper-mount'))!;
      const lower = branches.find(branch => branch.mountIds.includes('lower-mount'))!;
      // Event-time tolerance covers one 0.05 s integration step, not a trajectory literal.
      expect(Math.abs(lower.separationTime! - 2)).toBeLessThanOrEqual(0.05);
      expect(upper.mountIds).toContain('strap-mount');
      const charge = upper.events.find(e => e.type === 'EJECTION_CHARGE' && e.motorMountId === 'strap-mount')!;
      expect(charge).toBeDefined();
      expect(Math.abs(charge.time - 5)).toBeLessThanOrEqual(0.05);
      const ignition = upper.events.find(e => e.type === 'IGNITION' && e.motorMountId === 'upper-mount');
      if (event === 'automatic') expect(ignition).toBeUndefined();
      else {
        expect(ignition).toBeDefined();
        expect(Math.abs(ignition!.time - charge.time)).toBeLessThanOrEqual(0.05);
      }
    }
    const overrides = { ignitions: { 'upper-mount': { event: 'ejectioncharge' as const, delay: 0 } } };
    const summary = describeFlightOverrides(defaults, overrides, { 'upper-mount': motor }, null, 'm');
    expect(summary).not.toBeNull();
    expect(summary!.first).toEqual({ id: 'upper-mount', family: 'ignition' });
  }, 60_000);
  it('omits absent, equal, deleted and wrong-family entries', () => {
    expect(describeFlightOverrides(tree, {}, {}, '[F67C-9]', 'ft')).toBeNull();
    expect(describeFlightOverrides(tree, { deployments: { a: own, gone: flown, mount: flown } }, {}, null, 'ft')).toBeNull();
  });
  it('groups two parachutes but names both and says which setting flies', () => {
    const s = describeFlightOverrides(tree, { deployments: { a: flown, b: flown } }, {}, '[F67C-9]', 'ft')!;
    expect(s.text).toContain('Flight configuration “[F67C-9]” overrides 2 parachutes (Main and Backup)');
    expect(s.text).toContain('they deploy at Motor ejection charge');
    expect(s.text).toContain('own setting (Altitude (descending), 300 ft');
    expect(s.shortText).toBe('Flight configuration “[F67C-9]” overrides 2 parachutes (Main and Backup) — they deploy at Motor ejection charge.');
    expect(s.first).toEqual({ id: 'a', family: 'recovery' });
  });
  it.each(['Parachute', 'Shared name'])('omits redundant grouped names (%s) and dormant values in the LEM warning', name => {
    const defaults: FlightTree = { components: ['a', 'b'].map(id => ({ type: 'parachute', id, name, ...own })) };
    const overrides = { deployments: { a: { ...flown, deployAltitude: 200 }, b: { ...flown, deployAltitude: 200 } } };
    const summary = describeFlightOverrides(defaults, overrides, {}, '[F67C-9]', 'm')!;
    expect(summary.text).toBe('Flight configuration “[F67C-9]” overrides 2 parachutes: they deploy at Motor ejection charge, not at their own setting (Altitude (descending), 91.44 m).');
    expect(summary.shortText).toBe('Flight configuration “[F67C-9]” overrides 2 parachutes — they deploy at Motor ejection charge.');
  });
  it('omits generic single names and dormant default altitude while retaining nonzero delays on both sides', () => {
    const defaults: FlightTree = { components: [{ type: 'parachute', id: 'a', name: 'Parachute',
      deployEvent: 'ejection', deployAltitude: 200, deployDelay: 1.5 }] };
    const summary = describeFlightOverrides(defaults, { deployments: { a: { ...own, deployDelay: 2 } } }, {}, 'Test', 'ft')!;
    expect(summary.text).toBe('Flight configuration “Test” overrides parachute: it deploys at Altitude (descending), 300 ft, delay 2 s, not at its own setting (Motor ejection charge, delay 1.5 s).');
    expect(summary.shortText).not.toContain('own setting');
  });
  it('counts larger groups and keeps different types and settings distinct within one family sentence', () => {
    const expanded: FlightTree = { ...tree, components: [...tree.components,
      { type: 'parachute', id: 'c', name: 'Third', ...own },
      { type: 'streamer', id: 'd', name: 'Ribbon', ...own }] };
    const s = describeFlightOverrides(expanded, { deployments: { a: flown, b: flown, c: flown, d: { ...flown, deployDelay: 2 } } }, {}, null, 'ft')!;
    expect(s.text).toContain('3 parachutes:');
    expect(s.text).not.toContain('Third');
    expect(s.text).toContain('streamer “Ribbon”');
    expect(s.text).toContain('delay 2 s');
    expect(s.text.match(/The detached working settings/g)).toHaveLength(1);
  });
  it('includes lower-stage separation and ignores dormant recovery altitude differences', () => {
    const s = describeFlightOverrides(tree, { separations: { stage: {
      separationEvent: 'burnout', separationDelay: 2, separationAltitude: 200,
    } }, deployments: { a: { ...own, deployAltitude: 92 } } }, {}, null, 'm')!;
    expect(s.text).toContain('stage “Booster”');
    expect(s.text).toContain("This stage's motor burnout");
    expect(s.text).toContain('92 m');
    expect(s.text).toContain('The detached working settings');
    expect(s.first).toEqual({ id: 'stage', family: 'separation' });
    expect(describeFlightOverrides(tree, { separations: { stage: {
      separationEvent: 'ejection', separationDelay: 0, separationAltitude: 200,
    } } }, {}, null, 'm')).toBeNull();
    const dormant: FlightTree = { components: [{ type: 'parachute', id: 'a', ...own, deployEvent: 'apogee' }] };
    expect(describeFlightOverrides(dormant, { deployments: { a: {
      ...own, deployEvent: 'apogee', deployAltitude: 92,
    } } }, {}, null, 'm')).toBeNull();
  });
  it('omits a single top axial stage burnout separation override', () => {
    const single: FlightTree = { components: [{ type: 'stage', id: 'top', name: 'Sustainer' }] };
    expect(describeFlightOverrides(single, { separations: { top: {
      separationEvent: 'burnout', separationDelay: 2, separationAltitude: 200,
    } } }, {}, null, 'm')).toBeNull();
  });
  it('keeps a parallel stage separation override inside the top axial stage', () => {
    const parallel: FlightTree = { components: [{ type: 'stage', id: 'top', children: [
      { type: 'parallelstage', id: 'strap', name: 'Strap-on' },
    ] }] };
    const summary = describeFlightOverrides(parallel, { separations: { strap: {
      separationEvent: 'burnout', separationDelay: 2, separationAltitude: 200,
    } } }, {}, null, 'm')!;
    expect(summary.text).toContain('Strap-on');
    expect(summary.text).toContain("This stage's motor burnout");
    expect(summary.first).toEqual({ id: 'strap', family: 'separation' });
  });
  it('describes unsupported stored recovery events as motor ejection without changing tuples', () => {
    const imported: FlightTree = { components: [{ type: 'parachute', id: 'a', ...own, deployEvent: 'apogee' }] };
    const overrides = { deployments: { a: { ...own, deployEvent: 'lowerstageseparation' } } };
    const before = structuredClone({ imported, overrides });
    const summary = describeFlightOverrides(imported, overrides, {}, 'Imported', 'ft')!;
    expect(summary.text).toContain('it deploys at Motor ejection charge');
    expect(summary.text).toContain("the file's 'lower stage separation' is not supported here");
    expect(summary.text).toContain('own setting (Apogee');
    expect({ imported, overrides }).toEqual(before);
  });
  it.each([
    ['ejection', 'lowerstageseparation'],
    ['lowerstageseparation', 'ejection'],
    ['future-event', 'lowerstageseparation'],
    ['EJECTION', 'ejection'],
  ])('omits recovery events %s and %s that fly identically', (defaultEvent, overrideEvent) => {
    const defaults: FlightTree = { components: [{ type: 'parachute', id: 'a', ...own, deployEvent: defaultEvent }] };
    expect(describeFlightOverrides(defaults, { deployments: { a: {
      ...own, deployEvent: overrideEvent, deployAltitude: 200,
    } } }, {}, null, 'm')).toBeNull();
  });
  it('warns when fallback events have different flown delays and explains an unsupported default', () => {
    const defaults: FlightTree = { components: [{ type: 'parachute', id: 'a', ...own, deployEvent: 'lowerstageseparation' }] };
    const summary = describeFlightOverrides(defaults, { deployments: { a: {
      ...own, deployEvent: 'ejection', deployDelay: 2,
    } } }, {}, null, 'm')!;
    expect(summary.text).toContain('it deploys at Motor ejection charge');
    expect(summary.text).toContain('delay 2 s');
    expect(summary.text).toContain('own setting (Motor ejection charge');
    expect(summary.text).toContain("the file's 'lower stage separation' is not supported here");
    expect(summary.text).not.toContain('delay 0 s');
  });
  it('describes ignition only for loaded, existing mounts that differ from their default', () => {
    const overrides = { ignitions: { mount: { event: 'never' as const, delay: 1 }, gone: { event: 'never' as const, delay: 0 } } };
    expect(describeFlightOverrides(tree, overrides, {}, 'Test', 'm')).toBeNull();
    const s = describeFlightOverrides(tree, overrides, { mount: motor, gone: motor }, 'Test', 'm')!;
    expect(s.text).toContain('overrides motor mount:');
    expect(s.text).toContain('Never');
    expect(s.text).not.toContain('delay 1 s');
    expect(s.text).toContain("Automatic (launch / lower stage's ejection)");
    expect(s.text).not.toContain('delay 0 s');
    expect(s.first).toEqual({ id: 'mount', family: 'ignition' });
    expect(describeFlightOverrides(tree, { ignitions: { mount: motor.ignition } }, { mount: motor }, null, 'm')).toBeNull();
    expect(describeFlightOverrides({ components: tree.components }, { ignitions: { mount: motor.ignition } }, { mount: motor }, null, 'm')).toBeNull();
  });
  it('ignores retained motor records when the component is no longer a motor mount', () => {
    const overrides = { ignitions: { mount: { event: 'never' as const, delay: 0 } } };
    for (const node of [{ type: 'innertube' as const, motorMount: false }, { type: 'parachute' as const, motorMount: true }]) {
      expect(describeFlightOverrides({ components: [{ ...node, id: 'mount' }] }, overrides,
        { mount: motor }, 'Unmounted', 'm')).toBeNull();
    }
  });
  it('limits mixed-family output to three family sentences and leaves inputs untouched', () => {
    const overrides = { deployments: { a: flown }, separations: { stage: {
      separationEvent: 'never', separationDelay: 0, separationAltitude: 200,
    } }, ignitions: { mount: { event: 'launch' as const, delay: 2 } } };
    const before = structuredClone({ tree, overrides, motor });
    const s = describeFlightOverrides(tree, overrides, { mount: motor }, 'All families', 'ft')!;
    expect(s.text.match(/Flight configuration “All families”/g)).toHaveLength(3);
    for (const family of ['parachute', 'stage', 'motor mount']) expect(s.shortText).toContain(family);
    expect({ tree, overrides, motor }).toEqual(before);
  });
  it('explains unfamiliar events and formats ascent and delay with the shared unit formatter', () => {
    const s = describeFlightOverrides(tree, { deployments: { a: {
      deployEvent: 'future-event', deployAltitude: 91.44, deployDelay: 1.5,
    } }, separations: { stage: {
      separationEvent: 'altitudeascending', separationAltitude: 91.44, separationDelay: 2,
    } } }, {}, 'Future file', 'ft')!;
    expect(s.text).toContain('Motor ejection charge, delay 1.5 s');
    expect(s.text).not.toContain('stored altitude');
    expect(s.text).toContain("the file's 'future-event' is not supported here");
    expect(s.text).toContain('Altitude (ascending), 300 ft, delay 2 s');
  });
});
