// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportOrk, importOrk, type OrkExportMotor } from './orkFile.js';
import { resolveFlightState } from './flightState.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { planImport } from './importApply.js';
import { engineTree } from '../tree/treeModel.js';
import type { IgnitionTuple } from '../model/design.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = (name: string) => readFileSync(join(here, '__fixtures__', name));
const flat = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flat(n.children ?? [])]);
const selected = (r: ReturnType<typeof importOrk>) => resolveFlightState(r.tree,
  r.configs.map(c => ({ ...c, motors: {} })), r.chosenConfigId, {}, {}).tree;
const save = (r: ReturnType<typeof importOrk>) => exportOrk({ ...r, activeConfigId: r.chosenConfigId,
  launch: r.launch ? { ...DEFAULT_CONDITIONS, ...r.launch } : undefined });
const wrap = (parts: string, configs = '<motorconfiguration configid="one" default="true"/>') =>
  `<openrocket version="1.10"><rocket><name>Layers</name>${configs}<subcomponents><stage><subcomponents>${parts}</subcomponents></stage></subcomponents></rocket></openrocket>`;

describe('FC-2 configuration layers', () => {
  it.each(['EJECTION_CHARGE', 'unknown'])('writes a desktop ignition default for legacy %s', event => {
    const tree = { components: [{ type: 'bodytube' as const, id: 'mount', motorMount: true }] };
    // Legacy autosaves can carry spellings outside today's canonical type.
    const xml = exportOrk({ name: 'Legacy', tree: { ...tree,
      ignitionDefaults: { mount: { event: event as IgnitionTuple['event'], delay: 2 } } } });
    expect(xml).toContain(`<ignitionevent>${event === 'EJECTION_CHARGE' ? 'ejectioncharge' : 'automatic'}</ignitionevent>`);
    expect(xml).not.toContain(`<ignitionevent>${event}</ignitionevent>`);
  });

  it.each(['EJECTION_CHARGE', 'unknown'])('normalizes legacy %s in motor fallbacks and configuration overrides', event => {
    const motor: OrkExportMotor = { designation: 'Test', manufacturer: 'Test', diameter: 0.018,
      length: 0.07, delay: 5, ignitionEvent: event, ignitionDelay: 0 };
    const tree = { components: [{ type: 'bodytube' as const, id: 'mount', motorMount: true }] };
    const expected = event === 'EJECTION_CHARGE' ? 'ejectioncharge' : 'automatic';
    const fallback = exportOrk({ name: 'Legacy fallback', tree, motors: { mount: motor } });
    expect(fallback).toContain(`<ignitionevent>${expected}</ignitionevent>`);
    expect(fallback).not.toContain(`<ignitionevent>${event}</ignitionevent>`);
    for (const loaded of [true, false]) {
      const xml = exportOrk({ name: 'Legacy override', tree: { ...tree,
        ignitionDefaults: { mount: { event: 'launch', delay: 0 } } }, configs: [{ id: 'A', name: 'A', isDefault: true,
        motors: loaded ? { mount: motor } : {},
        ignitions: { mount: { event: event as IgnitionTuple['event'], delay: 2 } } }] });
      if (loaded) expect(xml).toContain(`<ignitionevent>${expected}</ignitionevent>`);
      else expect(xml).toContain(`&quot;${expected}&quot;`);
      expect(xml).not.toContain(`<ignitionevent>${event}</ignitionevent>`);
    }
  });

  it('writes the flown rod bearing with elevated winds aloft', () => {
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 500, launchRodAngleDeg: 5,
      windLevels: [{ altitude: 0, speed: 2, direction: 0 }, { altitude: 500, speed: 4, direction: 1 }] };
    const notes: string[] = [];
    const xml = exportOrk({ name: 'Wind', tree: { components: [] }, launch, notes });
    expect(notes.join(' ')).not.toContain('wrong height');
    expect(xml).toContain('<launchintowind>false</launchintowind>');
    expect(xml).toContain('<launchroddirection>90</launchroddirection>');
    for (const changed of [{ launchAltitudeM: 0 }, { launchRodAngleDeg: 0 }, { launchRodAimDeg: 10 }, { windLevels: [] }]) {
      const quiet: string[] = [];
      exportOrk({ name: 'Wind', tree: { components: [] }, launch: { ...launch, ...changed }, notes: quiet });
      expect(quiet.join(' ')).not.toContain('desktop OR');
    }
  });
  it('keeps the two LEM component defaults and resolves the selected ejection overrides through save/reopen', () => {
    let r = importOrk(file('config-layers/lem-recovery.xml').toString());
    for (let pass = 0; pass < 2; pass++) {
      const chutes = flat(r.tree.components).filter(n => n.type === 'parachute');
      expect(chutes).toHaveLength(2);
      for (const n of chutes) expect(n).toMatchObject({ deployEvent: 'altitude', deployAltitude: 91.44 });
      expect(chutes.map(n => n['deployDelay'] ?? 0)).toEqual([0, 0]);
      expect(r.chosenConfigId).toBe('365b8430-de05-45ee-a421-5142de1fd1ae');
      expect(Object.values(r.configs.find(c => c.id === r.chosenConfigId)!.deployments)).toEqual([
        { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 },
        { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 },
      ]);
      expect(r.configs.find(c => c.id !== r.chosenConfigId)!.deployments).toEqual({});
      expect(flat(selected(r).components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['ejection', 'ejection']);
      expect(r.notes.join('\n')).toContain('The Recovery section on Motors & Configuration shows both');
      expect(r.notes.join('\n')).toContain('Reset');
      expect(r.expand).toBe(true);
      const xml = save(r);
      expect(xml.match(/<deploymentconfiguration configid="365b8430-de05-45ee-a421-5142de1fd1ae">/g)).toHaveLength(2);
      r = importOrk(xml);
    }
  });

  it('keeps an unnamed, motorless single configuration with an override', () => {
    const r = importOrk(wrap('<parachute><deployevent>altitude</deployevent><deployaltitude>91.44</deployaltitude><deploymentconfiguration configid="one"><deployevent>ejection</deployevent></deploymentconfiguration></parachute>'));
    expect(r.configs).toHaveLength(1);
    const xml = save(r);
    expect(xml).toContain('<deploymentconfiguration configid="one">');
    const again = importOrk(xml);
    expect(Object.values(again.configs[0]!.deployments)).toEqual([{ deployEvent: 'ejection', deployAltitude: 91.44, deployDelay: 0 }]);
  });

  // Both creator names the app has written (before and after the 2026-08 rename) keep the app's own reading.
  it.each(['MMRocket Sim', 'Online OpenRocket'])('layers partial ignition blocks over mount defaults, including unloaded mounts, and writes only overrides (creator %s)', (creator) => {
    const r = importOrk(wrap(`<bodytube><name>Mount</name><motormount><ignitionevent>burnout</ignitionevent><ignitiondelay>4</ignitiondelay>
      <motor configid="one"><designation>X</designation><delay>none</delay></motor>
      <ignitionconfiguration configid="one"><ignitiondelay>1</ignitiondelay></ignitionconfiguration>
      <ignitionconfiguration configid="empty"><ignitionevent>never</ignitionevent></ignitionconfiguration>
      </motormount></bodytube>`, '<motorconfiguration configid="one" default="true"/><motorconfiguration configid="empty"/><motorconfiguration configid="inherit"/>').replace('<openrocket ', `<openrocket creator="${creator}" `));
    const id = Object.keys(r.motors)[0]!;
    expect(r.tree.ignitionDefaults?.[id]).toEqual({ event: 'burnout', delay: 4 });
    expect(r.configs[0]!.ignitions?.[id]).toEqual({ event: 'burnout', delay: 1 });
    expect(r.motors[id]).toMatchObject({ ignitionEvent: 'burnout', ignitionDelay: 1 });
    expect(r.configs[1]!.ignitions?.[id]).toEqual({ event: 'never', delay: 4 });
    expect(r.configs[2]!.ignitions).toBeUndefined();
    const xml = save(r);
    expect(xml.match(/<ignitionconfiguration /g)).toHaveLength(1);
    expect(xml).not.toContain('<mmrignitionconfiguration');
    expect(xml).toContain('mmrignitions=');
    expect(xml).not.toContain('<ignitionconfiguration configid="inherit">');
    const again = importOrk(xml);
    expect(Object.values(again.tree.ignitionDefaults!)).toEqual([{ event: 'burnout', delay: 4 }]);
    expect(Object.values(again.configs[1]!.ignitions!)).toEqual([{ event: 'never', delay: 4 }]);
    expect(r.notes.join('\n')).toContain('ignition');
    expect(r.expand).toBe(true);
    // The temporary legacy projection exports its resolved motors correctly too.
    const legacy = { tree: r.tree, configs: r.configs };
    const legacyBack = importOrk(exportOrk({ name: r.name, ...legacy, motors: r.motors, activeConfigId: r.chosenConfigId }));
    expect(Object.values(legacyBack.motors)[0]).toMatchObject({ ignitionEvent: 'burnout', ignitionDelay: 1 });
  });

  it('does not recreate a reset ignition override from a stale resolved motor reference', () => {
    const r = importOrk(wrap('<bodytube><motormount><ignitionevent>launch</ignitionevent><ignitiondelay>2</ignitiondelay><motor configid="one"><designation>X</designation><delay>5</delay></motor><ignitionconfiguration configid="one"><ignitionevent>never</ignitionevent></ignitionconfiguration></motormount></bodytube>'));
    r.configs[0]!.ignitions = {};
    expect(save(r)).not.toContain('<ignitionconfiguration');
  });

  it('does not give equal deployment, separation or ignition blocks ownership', () => {
    const r = importOrk(wrap('<parachute><deploymentconfiguration configid="one"><deployevent>ejection</deployevent><deployaltitude>200</deployaltitude><deploydelay>0</deploydelay></deploymentconfiguration></parachute><parallelstage><separationconfiguration configid="one"><separationevent>ejection</separationevent><separationdelay>0</separationdelay><separationaltitude>200</separationaltitude></separationconfiguration><subcomponents><bodytube><motormount><ignitionconfiguration configid="one"><ignitionevent>automatic</ignitionevent><ignitiondelay>0</ignitiondelay></ignitionconfiguration></motormount></bodytube></subcomponents></parallelstage>', '<motorconfiguration configid="one" default="true"><name>Default flight</name></motorconfiguration>'));
    expect(r.configs[0]!.deployments).toEqual({});
    expect(r.configs[0]!.separations).toEqual({});
    expect(r.configs[0]!.ignitions).toBeUndefined();
    expect(save(r)).not.toMatch(/<(deployment|separation|ignition)configuration/);
    expect(r.expand).toBeUndefined();
  });

  it('hands layered defaults directly to import-plan consumers', () => {
    const r = importOrk(file('config-layers/lem-recovery.xml').toString());
    const plan = planImport(r, { working: {}, configs: {} }, { launch: DEFAULT_CONDITIONS,
      text: { mass: n => `${n} kg`, length: n => `${n} m` } });
    expect(flat(plan.snapshot.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['altitude', 'altitude']);
    expect(flat(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['altitude', 'altitude']);
    expect(plan.note).toMatchObject({ expand: true, severity: 'info' });
    expect(plan.snapshot.savedConfigs[0]!.deployments).toBeUndefined();
    expect(Object.values(plan.snapshot.savedConfigs[1]!.deployments!)).toEqual([
      { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 },
      { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 },
    ]);
  });

  it('names the stage default and separation override, and keeps both layers after reopening', () => {
    const r = importOrk(wrap('<parallelstage><name>Booster</name><separationevent>never</separationevent><separationdelay>4</separationdelay><separationaltitude>350</separationaltitude><separationconfiguration configid="one"><separationevent>burnout</separationevent><separationdelay>1</separationdelay></separationconfiguration><subcomponents><bodytube/></subcomponents></parallelstage>'));
    const stage = flat(r.tree.components).find(n => n.type === 'parallelstage')!;
    expect(stage).toMatchObject({ separationEvent: 'never', separationDelay: 4 });
    expect(r.configs[0]!.separations[stage.id!]).toEqual({ separationEvent: 'burnout', separationDelay: 1, separationAltitude: 350 });
    expect(r.notes.join('\n')).toContain("stage's own setting (Never + 4 s)");
    expect(r.notes.join('\n')).toContain('The Stages section on Motors & Configuration shows both');
    expect(r.expand).toBe(true);
    expect(Object.values(importOrk(save(r)).configs[0]!.separations)).toEqual(Object.values(r.configs[0]!.separations));
  });

  it('pins pre-FC-2 canonical XML for an existing no-override fixture', () => {
    const b = file('auto-radius-15.03.ork');
    const r = importOrk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    expect(r.configs.every(c => !Object.keys(c.deployments).length && !Object.keys(c.separations).length && !c.ignitions)).toBe(true);
    expect(save(r).replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, 'UUID')).toMatchSnapshot();
    // This is the document passed to the kernel builder, not a flown result.
    expect(JSON.parse(JSON.stringify(engineTree(r.tree), (key, value: unknown) => key === 'id' ? 'ID' : value))).toMatchSnapshot('kernel document before FC-2');
  });
});
