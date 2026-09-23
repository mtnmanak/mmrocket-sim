// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import type { MotorMatchResult } from './motorMatch.js';
import type { OrkFlightConfig, OrkMotorRef } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { planImport, resolveImportMotors, type ImportedDesign } from './importApply.js';
import { primaryMountOf } from '../tree/treeModel.js';

/**
 * WHICH CONFIGURATION AN OPEN SHOWS (seam review of audit 2026-09-22, the
 * blocker). The .rkt reader makes every stored simulation a configuration and
 * opens the first that motors the launch stage — before any motor is matched.
 * 31 real designs that flew on open at v0.137, seven of them the owner's,
 * opened on a first simulation whose motor is not in the catalogue: no motor
 * loaded, no primary mount, Launch unavailable, and a note sending the user to
 * Browse motor database while other configurations of the same file fly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TEXT = {
  mass: (kg: number) => `${(kg * 1000).toFixed(0)} g`,
  length: (m: number) => `${(m * 1000).toFixed(1)} mm`,
};

/** A loaded catalogue motor, as far as planning an open reads one. */
const motor = (designation: string): MountMotor => ({
  label: designation,
  spec: {
    designation, diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
    times: [0, 1], thrusts: [0, 0], masses: [0.02, 0.01],
  },
  meta: { label: designation, manufacturer: 'Estes', motorId: `db-${designation}` },
  ignition: { event: 'automatic', delay: 0 },
});

/** What App does with a file: read, resolve every motor, plan. */
async function open(imported: ImportedDesign, match?: (ref: OrkMotorRef) => Promise<MotorMatchResult>) {
  const resolved = await resolveImportMotors(imported, match);
  return planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: TEXT });
}

describe('planImport — opens a configuration that can leave the pad', () => {
  it('passes over simulations whose launch motors cannot load, and says which and why', async () => {
    const r = importRkt(readFileSync(join(here, '__fixtures__', 'first-sim-unloadable.rkt'), 'utf8'));
    // The reader's own pick, made blind: simulation 1.
    expect(r.chosenConfigId).toBe('rocksim-sim-1');
    const plan = await open(r);
    // The first configuration whose motor loads — simulation 3's C6 — is the one on screen.
    expect(plan.snapshot.activeConfigId).toBe('rocksim-sim-3');
    const loaded = Object.values(plan.snapshot.mountMotors);
    expect(loaded.map((m) => m.spec.designation)).toEqual(['C6']);
    expect(primaryMountOf(plan.snapshot.tree, Object.keys(plan.snapshot.mountMotors))).not.toBeNull();
    expect(plan.unmatchedRefs).toEqual({});
    const lines = plan.note.text.split('\n');
    // Named, with the motor and the reason — never the matcher's "pick one via
    // Browse motor database", the wrong fix when another configuration flies.
    expect(lines).toContain('Simulation 1 (“[ZQ240-RL-None]”) was not opened: ZQ240-RL matched no motor in the motor '
      + 'database, so it could not leave the pad.');
    expect(plan.note.text).not.toMatch(/pick one via Browse motor database/);
    // The reader's "which simulation" sentence names the one opened, not the one skipped …
    expect(plan.note.text).toMatch(/Simulation 3 \(“\[C6-\*\]”\) was opened — switch under Flight configurations/);
    expect(plan.note.text).not.toMatch(/Simulation 1 \(“\[ZQ240-RL-None\]”\) was opened/);
    // … and the notes about the skipped simulation's motor went with it: its
    // plugged ZQ240-RL is not on screen, the C6's "every delay" is.
    expect(plan.note.text).not.toMatch(/ZQ240-RL: plugged/);
    expect(plan.note.text).toMatch(/Motor C6: the file asks for RockSim's “every delay” run/);
    expect(plan.note.severity).toBe('warn');
    // Every simulation is still a configuration; the skipped ones carry their debt.
    const byId = Object.fromEntries(plan.snapshot.savedConfigs.map((c) => [c.id, c]));
    expect(Object.keys(byId)).toEqual(['rocksim-sim-1', 'rocksim-sim-2', 'rocksim-sim-3']);
    expect(byId['rocksim-sim-1']!.unmatched).toEqual(['ZQ240-RL']);
    expect(byId['rocksim-sim-2']!.unmatched).toEqual(['ZQ9999X']);
    expect(byId['rocksim-sim-3']!.motors).toEqual(plan.snapshot.mountMotors);
  });

  it('keeps the reader’s pick when it flies, and when nothing else does', async () => {
    const xml = readFileSync(join(here, '__fixtures__', 'first-sim-unloadable.rkt'), 'utf8');
    // Simulation 3 made unloadable too: nothing flies, so simulation 1 stays, as before.
    const none = importRkt(xml.replace('<EngineCode>C6</EngineCode>', '<EngineCode>ZQ8888X</EngineCode>'));
    const kept = await open(none);
    expect(kept.snapshot.activeConfigId).toBe('rocksim-sim-1');
    expect(kept.note.text).toMatch(/Motor “ZQ240-RL” matched no motor in the motor database — pick one via Browse motor database/);
    expect(kept.note.text).not.toMatch(/was not opened/);
    // Simulation 1 given a loadable motor: it flies, and it is opened.
    const flies = importRkt(xml.replace('<EngineCode>ZQ240-RL</EngineCode>', '<EngineCode>D12</EngineCode>')
      .replace('<EngineMfg>AeroTech</EngineMfg>', '<EngineMfg>Estes</EngineMfg>'));
    expect((await open(flies)).snapshot.activeConfigId).toBe('rocksim-sim-1');
  });

  /**
   * A .ork NAMES its default configuration: the author's choice, made in
   * desktop OpenRocket, and a Save writes the one on screen back as the
   * selected one. So a .ork (no `configSources`) is opened on it even when its
   * motor cannot load here.
   */
  it('leaves a .ork on the configuration the file names', async () => {
    const tree: RocketTree = {
      name: 'ork',
      components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.0124, thickness: 0.0004, children: [
          { type: 'innertube', id: 'm', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true } as ComponentNode,
        ] } as ComponentNode,
      ] } as ComponentNode],
    };
    const ref = (designation: string): OrkMotorRef => ({ designation, manufacturer: 'Estes', diameter: 0, length: 0, delay: 5, mountId: 'm' });
    const cfg = (id: string, d: string): OrkFlightConfig => ({ id, name: null, isDefault: id === 'A', motors: { m: ref(d) }, deployments: {}, separations: {} });
    const imported: ImportedDesign = {
      name: 'ork', tree, notes: [], motors: { m: ref('ZQ9999X') },
      configs: [cfg('A', 'ZQ9999X'), cfg('B', 'C6')], chosenConfigId: 'A',
    };
    const stub = async (r: OrkMotorRef): Promise<MotorMatchResult> => (r.designation === 'C6'
      ? { motor: motor('C6'), note: '' }
      : { note: `Motor “${r.designation}” matched no motor in the motor database — pick one via Browse motor database.`, missing: 'database' });
    expect((await open(imported, stub)).snapshot.activeConfigId).toBe('A');
    // The same file read by a reader that CHOSE (configSources): re-picked.
    const chose = await open({ ...imported, configSources: { A: 'Simulation 1', B: 'Simulation 2' } }, stub);
    expect(chose.snapshot.activeConfigId).toBe('B');
    expect(chose.note.text).toContain('Simulation 1 was not opened: ZQ9999X matched no motor in the motor database');
  });

  /**
   * One that motors the tree's BOTTOM stage is preferred to one that motors
   * only a stage above it — the reader's own preference — so a re-pick never
   * trades an unloadable booster for a sustainer lit on the pad while the
   * booster rides along unpowered.
   */
  it('prefers a configuration that motors the bottom stage', async () => {
    const tree: RocketTree = {
      name: 'two',
      components: [
        { type: 'stage', id: 's0', children: [
          { type: 'bodytube', id: 'm0', length: 0.3, outerRadius: 0.0124, thickness: 0.0004, motorMount: true } as ComponentNode,
        ] } as ComponentNode,
        { type: 'stage', id: 's1', children: [
          { type: 'bodytube', id: 'm1', length: 0.3, outerRadius: 0.0124, thickness: 0.0004, motorMount: true } as ComponentNode,
        ] } as ComponentNode,
      ],
    };
    const ref = (designation: string, mountId: string): OrkMotorRef => ({ designation, manufacturer: 'Estes', diameter: 0, length: 0, delay: 5, mountId });
    const cfg = (id: string, motors: Record<string, OrkMotorRef>): OrkFlightConfig => ({ id, name: null, isDefault: false, motors, deployments: {}, separations: {} });
    const imported: ImportedDesign = {
      name: 'two', tree, notes: [], motors: { m1: ref('ZQ1', 'm1'), m0: ref('C6', 'm0') },
      configs: [
        cfg('first', { m1: ref('ZQ1', 'm1'), m0: ref('C6', 'm0') }),
        cfg('upperOnly', { m0: ref('C6', 'm0') }),
        cfg('both', { m1: ref('D12', 'm1'), m0: ref('C6', 'm0') }),
      ],
      chosenConfigId: 'first',
      configSources: { first: 'Simulation 1', upperOnly: 'Simulation 2', both: 'Simulation 3' },
    };
    const stub = async (r: OrkMotorRef): Promise<MotorMatchResult> => (r.designation.startsWith('ZQ')
      ? { note: 'no', missing: 'database' }
      : { motor: motor(r.designation), note: '' });
    // `first` has its sustainer motor loaded, but its BOOSTER — what lifts off — is not.
    expect((await open(imported, stub)).snapshot.activeConfigId).toBe('both');
  });

  /**
   * A SUSTAINER-ONLY SIMULATION IS OPENED ONLY WHEN NOTHING THAT MOTORS THE
   * BOOSTER FLIES (review of the seam fixes). The reader's sentence for it
   * ended "switch under Flight configurations to fly one that motors it" —
   * sending the user to the configurations that had just been passed over
   * because they cannot leave the pad.
   */
  it('does not send the user to a configuration that cannot fly', async () => {
    const set = (code: string, mfg: string, serial: number) => `<EngineSet><EngineCount>1</EngineCount>
      <EngineCode>${code}</EngineCode><EngineMfg>${mfg}</EngineMfg><IgnitionDelay>0.</IgnitionDelay>
      <MountSerialNo>${serial}</MountSerialNo><EjectionDelay>7.</EjectionDelay></EngineSet>`;
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>Two</Name><StageCount>2</StageCount>
      <Stage3Parts><BodyTube><Name>Upper</Name><OD>24.8</OD><ID>24.1</ID><Len>250</Len><IsMotorMount>1</IsMotorMount>
        <SerialNo>3</SerialNo></BodyTube></Stage3Parts>
      <Stage2Parts><BodyTube><Name>Lower</Name><OD>24.8</OD><ID>24.1</ID><Len>200</Len><IsMotorMount>1</IsMotorMount>
        <SerialNo>2</SerialNo></BodyTube></Stage2Parts>
      </RocketDesign></DesignInformation><SimulationResultsList>
      <SimulationResults><Stage2Engines>${set('ZQ9999X', 'Estes', 2)}</Stage2Engines>
        <Stage3Engines>${set('C6', 'Estes', 3)}</Stage3Engines></SimulationResults>
      <SimulationResults><Stage3Engines>${set('C6', 'Estes', 3)}</Stage3Engines></SimulationResults>
      </SimulationResultsList></RockSimDocument>`);
    expect(r.chosenConfigId).toBe('rocksim-sim-1');
    const plan = await open(r);
    expect(plan.snapshot.activeConfigId).toBe('rocksim-sim-2');
    expect(plan.note.text).toContain('Simulation 1 was not opened: ZQ9999X matched no motor in the motor '
      + 'database, so it could not leave the pad.');
    expect(plan.note.text).not.toMatch(/switch under Flight configurations/);
    expect(plan.note.text).toContain('Simulation 2 puts no motor on Booster, and no simulation in this file '
      + 'that motors Booster has a motor there the app can load. It was opened with its lowest stage\'s motors timed '
      + 'from launch, so Booster flies along unpowered. Delete that stage in the Design tab to fly without it, or '
      + 'select its mount there and pick a motor.');
  });
});

/**
 * THE OWNER'S OWN FILES — local-only (docs/ is gitignored and the corpus lives
 * in Dropbox), so skipped wherever they are absent. Each flew on open at
 * v0.137 and opened on an unloadable first simulation after the per-simulation
 * configurations landed.
 */
describe('planImport — the owner’s designs open flyable', () => {
  const repo = join(here, '../../../..');
  const corpora = ['G:/Documents/Dropbox/Rocksim Designs', 'C:/Users/peltz/Dropbox/Rocksim Designs'];
  const find = (...candidates: string[]) => candidates.find((p) => existsSync(p));
  const cases: [string, string | undefined, string][] = [
    ['4in WM Extreme.rkt', find(join(repo, 'docs/User files/4in WM Extreme.rkt')), 'M2700W'],
    ['Mach 3.rkt', find(join(repo, 'docs/User files/TRF RASAero Files/Mach 3.rkt')), '4LC'],
  ];
  for (const [label, path, missing] of cases) {
    it.skipIf(!path)(`${label}: a motor on the pad and Launch available`, async () => {
      const r = importRkt(readFileSync(path!, 'latin1'));
      const plan = await open(r);
      expect(plan.snapshot.activeConfigId).not.toBe(r.chosenConfigId);
      // App's Launch gate is a built design with a primary mount.
      expect(primaryMountOf(plan.snapshot.tree, Object.keys(plan.snapshot.mountMotors))).not.toBeNull();
      expect(plan.note.text).toMatch(new RegExp(`^Simulation 1 \\(“.*”\\) was not opened: ${missing} matched no motor in the motor database`, 'm'));
    });
  }

  /**
   * Two more needed the re-pick only because their first simulation's motor
   * was named by Cesaroni's common name and propellant code, which the matcher
   * could not read until audit 2026-09-23. It finds them now, so each opens on
   * the simulation the reader picked, and flies it — Wildman_2stage's on BOTH
   * stages since the review of that audit read “L640-DT” (Dual Thrust): with
   * only the booster's L1030-RL found, it opened a two-stage simulation and
   * flew the booster alone, 2375.5 m against RockSim's stored 7679.2 m.
   */
  const named: [string, string | undefined, string[]][] = [
    ['Level2-PELTZER.rkt', find(...corpora.map((c) => `${c}/Apogee Components/Level2-PELTZER.rkt`)), ['806J240-16A']],
    ['Wildman_2stage.rkt', find(...corpora.map((c) => `${c}/Wildman/Wildman_2stage.rkt`)), ['2772L640-P', '2788L1030-P']],
  ];
  for (const [label, path, loaded] of named) {
    it.skipIf(!path)(`${label}: its first simulation, on the Cesaroni motors it names`, async () => {
      const r = importRkt(readFileSync(path!, 'latin1'));
      const plan = await open(r);
      expect(plan.snapshot.activeConfigId).toBe(r.chosenConfigId);
      expect(primaryMountOf(plan.snapshot.tree, Object.keys(plan.snapshot.mountMotors))).not.toBeNull();
      expect(Object.values(plan.snapshot.mountMotors).map((m) => m.spec.designation).sort()).toEqual(loaded);
      expect(plan.note.text).not.toMatch(/was not opened|matched no motor/);
    });
  }
});
