import { describe, expect, it } from 'vitest';
import type { DeploymentTuple, FlightTree, MountMotor } from '../model/design.js';
import { describeFlightOverrides } from './flightOverrideSummary.js';

const own: DeploymentTuple = { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 };
const flown: DeploymentTuple = { ...own, deployEvent: 'ejection' };
const tree: FlightTree = { components: [{ type: 'stage', id: 'sustainer', name: 'Sustainer' }, { type: 'stage', id: 'stage', name: 'Booster', children: [
  { type: 'parachute', id: 'a', name: 'Main', ...own },
  { type: 'parachute', id: 'b', name: 'Backup', ...own },
  { type: 'innertube', id: 'mount', name: 'Motor mount', motorMount: true },
] }], ignitionDefaults: { mount: { event: 'automatic', delay: 0 } } };
const motor = { ignition: { event: 'automatic', delay: 0 } } as MountMotor;

describe('launch override summary', () => {
  it('omits absent, equal, deleted and wrong-family entries', () => {
    expect(describeFlightOverrides(tree, {}, {}, '[F67C-9]', 'ft')).toBeNull();
    expect(describeFlightOverrides(tree, { deployments: { a: own, gone: flown, mount: flown } }, {}, null, 'ft')).toBeNull();
  });
  it('groups two parachutes but names both and says which setting flies', () => {
    const s = describeFlightOverrides(tree, { deployments: { a: flown, b: flown } }, {}, '[F67C-9]', 'ft')!;
    expect(s.text).toContain('Flight configuration “[F67C-9]” overrides 2 parachutes (Main and Backup)');
    expect(s.text).toContain('they deploy at Motor ejection charge');
    expect(s.text).toContain('own setting (Altitude (descending) 300 ft');
    expect(s.shortText).toBe('Overrides in “[F67C-9]”: 2 parachutes');
    expect(s.first).toEqual({ id: 'a', family: 'recovery' });
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
    expect(summary.text).toContain('delay 0 s');
  });
  it('describes ignition only for loaded, existing mounts that differ from their default', () => {
    const overrides = { ignitions: { mount: { event: 'never' as const, delay: 1 }, gone: { event: 'never' as const, delay: 0 } } };
    expect(describeFlightOverrides(tree, overrides, {}, 'Test', 'm')).toBeNull();
    const s = describeFlightOverrides(tree, overrides, { mount: motor, gone: motor }, 'Test', 'm')!;
    expect(s.text).toContain('motor mount “Motor mount”');
    expect(s.text).toContain('Never, delay 1 s');
    expect(s.text).toContain("Automatic (launch / lower stage's ejection)");
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
    expect(s.text).toContain('Motor ejection charge (stored altitude 300 ft), delay 1.5 s');
    expect(s.text).toContain("the file's 'future-event' is not supported here");
    expect(s.text).toContain('Altitude (ascending) 300 ft, delay 2 s');
  });
});
