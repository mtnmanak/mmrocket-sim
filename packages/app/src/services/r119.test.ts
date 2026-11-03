// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS, kernelSimOptions } from './launchConditions.js';
import { applyPresetLinks, type Preset } from './presets.js';
import type { ComponentNode } from '@online-openrocket/engine';

const row: Preset = { kind: 'Parachute', manufacturer: 'Test', partNo: 'P', description: 'Test canopy',
  diameter: 0.4, dragCoefficient: 1.5, spillHoleDiameter: 0.08, mass: 0.03 };
const source = (type = 'parachute', extra = '<cd>auto</cd><spillholediameter>0.04</spillholediameter>') =>
  `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Test</name><subcomponents><stage><subcomponents><${type}><name>Main</name><preset manufacturer="Test" partno="P"/><diameter>0.4</diameter>${extra}</${type}></subcomponents></stage></subcomponents></rocket></openrocket>`;
const part = (r: ReturnType<typeof importOrk>) => r.tree.components[0]!.children![0]!;

it.each([
  { windLevels: undefined, launchRodAngleDeg: 5, launchAltitudeM: 500 },
  { windLevels: [{ altitude: 0, speed: 2, direction: 0.4 }], launchRodAngleDeg: 0, launchAltitudeM: 500 },
  { windLevels: [], launchRodAngleDeg: 5, launchAltitudeM: 500 },
  { windLevels: undefined, launchRodAimDeg: NaN },
  { windLevels: [{ altitude: 0, speed: 2, direction: 0.4 }], launchRodAngleDeg: NaN, launchAltitudeM: 500 },
])('keeps exact legacy XML for unaffected conditions %j', conditions => {
  let id = 0;
  expect(exportOrk({ name: 'Legacy', tree: { components: [] },
    launch: { ...DEFAULT_CONDITIONS, ...conditions }, newId: () => `fixed-${++id}` })).toMatchSnapshot();
});

it.each([
  { windLevels: [{ altitude: 0, speed: 2, direction: 0.4 }] },
  { windLevels: [{ altitude: -100, speed: 2, direction: 0 }, { altitude: 100, speed: 4, direction: 0.8 }] },
])('states the manual rod at sea level over turned surface winds %j', ({ windLevels }) => {
  for (const launchRodAimDeg of [0, NaN]) {
    let id = 0;
    const xml = exportOrk({ name: 'Surface', tree: { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.03 }] }] }, newId: () => `surface-${++id}`, launch: {
      ...DEFAULT_CONDITIONS, windLevels, launchAltitudeM: 0, launchRodAngleDeg: 5, launchRodAimDeg,
    } });
    expect(xml).toContain('<launchintowind>false</launchintowind>');
    expect(xml).toContain('<launchroddirection>90</launchroddirection>');
    expect(importOrk(xml).launch!.launchRodAimDeg).toBe(0);
    expect(xml).toMatchSnapshot();
  }
});

it.each([
  { label: 'sea-level forecast', launchAltitudeM: 0, windLevels: [{ altitude: 0, speed: 2, direction: 0 }] },
  { label: 'calm', launchAltitudeM: 0, windLevels: [{ altitude: 0, speed: 0, direction: 0 }] },
  { label: 'turbulent straddling', launchAltitudeM: 0, windLevels: [
    { altitude: -100, speed: 2, direction: 0, standardDeviation: 1 },
    { altitude: 100, speed: 2, direction: 0, standardDeviation: 1 },
  ] },
  { label: 'nonfinite altitude', launchAltitudeM: NaN, windLevels: [{ altitude: 0, speed: 2, direction: 0 }] },
])('states the manual rod for $label winds aloft', ({ launchAltitudeM, windLevels }) => {
  for (const launchRodAimDeg of [0, NaN, 25]) {
    let id = 0;
    const xml = exportOrk({ name: 'Profile', tree: { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.03 }] }] }, newId: () => `profile-${++id}`, launch: {
      ...DEFAULT_CONDITIONS, windLevels, launchAltitudeM, launchRodAngleDeg: 5, launchRodAimDeg,
    } });
    const aim = Number.isFinite(launchRodAimDeg) ? launchRodAimDeg : 0;
    expect(xml).toContain('<launchintowind>false</launchintowind>');
    expect(xml).toContain(`<launchroddirection>${90 + aim}</launchroddirection>`);
    expect(importOrk(xml).launch!.launchRodAimDeg).toBe(aim);
    expect(xml).toMatchSnapshot();
  }
});

it('uses the old surface reference after a desktop bearing edit, but keeps the app frame after a speed edit', () => {
  const launch = { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchAltitudeM: 0,
    windLevels: [{ altitude: 0, speed: 2, direction: 0.4 }, { altitude: 500, speed: 4, direction: 1 }] };
  const xml = exportOrk({ name: 'Edits', tree: { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.03 }] }] }, launch });
  expect(xml).toContain('<launchintowind>false</launchintowind>');
  const bearingEdit = xml.replace(`direction="${Math.PI / 2 + 1}"`, `direction="${Math.PI / 2 + 1.2}"`);
  expect(bearingEdit).not.toBe(xml);
  const bearings = importOrk(bearingEdit).launch!;
  expect(bearings.windLevels![0]!.direction).toBe(0);
  expect(bearings.windLevels![1]!.direction).toBeCloseTo(0.8, 12);
  expect(bearings.launchRodAimDeg).toBeCloseTo(-0.4 * 180 / Math.PI, 8);
  const speedEdit = xml.replace('speed="2"', 'speed="3"');
  expect(speedEdit).not.toBe(xml);
  const speeds = importOrk(speedEdit).launch!;
  expect(speeds.windLevels).toEqual(launch.windLevels.map((l, i) => ({ ...l, speed: i === 0 ? 3 : l.speed, standardDeviation: 0 })));
  expect(speeds.launchRodAimDeg).toBe(0);
});

it('clears the subtree mass flag when filling a recovery leaf mass', () => {
  const r = importOrk(source('parachute', '<cd>auto</cd><overridesubcomponentsmass>true</overridesubcomponentsmass>'), { presets: [row] });
  expect(part(r).overrideMass).toBe(0.03);
  expect(part(r).overrideSubcomponentsMass).not.toBe(true);
  expect(exportOrk({ name: r.name, tree: r.tree })).not.toContain('<overridesubcomponentsmass>true</overridesubcomponentsmass>');
});

it.each(['bodytube', 'nosecone'])('never fills recovery mass on foreign ork %s', type => {
  const r = importOrk(source(type, ''), { presets: [{ ...row, kind: type === 'bodytube' ? 'BodyTube' : 'NoseCone' }] });
  expect(part(r).presetPartNo).toBe('P');
  expect(part(r).overrideMass).toBeUndefined();
});

it.each([undefined, 0.08, 0.04])('reports only actual spill-hole fills or replacements (file vent %s)', vent => {
  const r = importOrk(source('parachute', `<cd>auto</cd>${vent === undefined ? '' : `<spillholediameter>${vent}</spillholediameter>`}`), { presets: [row] });
  const note = r.notes.find(n => n.includes('matched the parts catalogue'))!;
  expect(note).toBeDefined();
  expect(/took[^—]*spill hole/.test(note)).toBe(vent === undefined);
  expect(note.includes('replaced the file’s spill hole')).toBe(vent === 0.04);
  if (vent === 0.04) expect(note).not.toContain("The file's own values stand, including");
});

it.each([0, 0.4])('writes and reopens the flown rod with lowest relative direction %s', direction => {
  const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 500, launchRodAngleDeg: 5,
    windLevels: [{ altitude: 0, speed: 2, direction }, { altitude: 500, speed: 4, direction: 1 }] };
  expect(kernelSimOptions(launch).launchRodDirection ?? Math.PI / 2).toBe(Math.PI / 2);
  const xml = exportOrk({ name: 'Wind', tree: { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.03 }] }] }, launch });
  expect(xml).toContain('<launchintowind>false</launchintowind>');
  expect(xml).toContain('<launchroddirection>90</launchroddirection>');
  const reopened = importOrk(xml).launch!;
  expect(reopened.launchRodAimDeg).toBe(0);
  expect(reopened.windLevels).toEqual(launch.windLevels.map(l => ({ ...l, standardDeviation: 0 })));
});

it('takes the foreign ork recovery pair and mass, and preserves them on own reopen', () => {
  const r = importOrk(source(), { presets: [row] });
  expect(part(r)).toMatchObject({ cd: 1.5, spillHoleDiameter: 0.08, overrideMass: 0.03 });
  expect(r.notes.join(' ')).toMatch(/replaced.*spill hole/i);
  const reopened = importOrk(exportOrk({ name: r.name, tree: r.tree }), { presets: [row] });
  expect(part(reopened)).toMatchObject({ cd: 1.5, spillHoleDiameter: 0.08, overrideMass: 0.03 });
});

it('keeps explicit values and own-file automatic choices', () => {
  const explicit = importOrk(source('parachute', '<cd>0.9</cd><overridemass>0.02</overridemass><spillholediameter>0.04</spillholediameter>'), { presets: [row] });
  expect(part(explicit)).toMatchObject({ cd: 0.9, overrideMass: 0.02, spillHoleDiameter: 0.04 });
  const own = importOrk(exportOrk({ name: 'Own', tree: { components: [{ type: 'stage', children: [
    { type: 'parachute', presetManufacturer: 'Test', presetPartNo: 'P' },
  ] }] } }), { presets: [row] });
  expect(part(own).cd).toBeUndefined();
  expect(part(own).overrideMass).toBeUndefined();
});

it('takes streamer Cd and mass; a vent-only row supplies neither canopy half', () => {
  const streamer = importOrk(source('streamer', '<cd>auto</cd>'), { presets: [{ ...row, kind: 'Streamer' }] });
  expect(part(streamer)).toMatchObject({ cd: 1.5, overrideMass: 0.03 });
  const ventOnly = importOrk(source(), { presets: [{ ...row, dragCoefficient: undefined }] });
  expect(part(ventOnly).cd).toBeUndefined();
  expect(part(ventOnly).spillHoleDiameter).toBe(0.04);
});

it('takes an unvented pair, fills wholly missing values, and respects zero mass', () => {
  const unvented = importOrk(source(), { presets: [{ ...row, spillHoleDiameter: undefined }] });
  expect(part(unvented).cd).toBe(1.5);
  expect(part(unvented).spillHoleDiameter).toBeUndefined();
  const missing = importOrk(source('parachute', ''), { presets: [row] });
  expect(part(missing)).toMatchObject({ cd: 1.5, spillHoleDiameter: 0.08, overrideMass: 0.03 });
  const zero = importOrk(source('parachute', '<overridemass>0</overridemass>'), { presets: [row] });
  expect(part(zero).overrideMass).toBe(0);
});

it('keeps the non-ork recovery mass and half-pair rule', () => {
  const node: ComponentNode = { type: 'parachute', spillHoleDiameter: 0.04 };
  applyPresetLinks([{ node, manufacturer: 'Test', partNo: 'P' }], [row], []);
  expect(node.overrideMass).toBeUndefined();
  expect(node.cd).toBeUndefined();
  expect(node.spillHoleDiameter).toBe(0.04);
});
