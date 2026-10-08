// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importRkt } from './rocksimFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import { planImport, planConfigSwitch, resolveImportMotors } from './importApply.js';
import { withoutStoredRef, withActiveConfigSynced } from './configSync.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { simulateDesign } from './simulateDesign.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { motorMounts } from '../tree/treeModel.js';
import { designStateFromSession } from './sessionRestore.js';
import { autosaveToOrk } from './autosaveBackup.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '__fixtures__/ambiguous-motor-mounts.rkt'), 'utf8');
const stagedFixture = fixture.replace('<StageCount>1</StageCount>', '<StageCount>2</StageCount>')
  .replace('<Stage2Parts></Stage2Parts>', `<Stage2Parts><BodyTube><Name>Booster mount</Name>
    <SerialNo>20</SerialNo><OD>24.8</OD><ID>24.1</ID><Len>200</Len>
    <IsMotorMount>1</IsMotorMount></BodyTube></Stage2Parts>`);
const text = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
async function open(xml = fixture) {
  const imported = importRkt(xml);
  return planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS, text });
}
// Same opt-in corpus root as rocksimRecovery.test.ts; CI has no private corpus.
const corpusCases = [
  ['Quest/Quest_Lil_Grunt.rkt', 4],
  ['Semroc/Semroc-Hydra VII.rkt', 7],
] as const;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ambiguous RockSim motor loadouts', () => {
  it('opens the valid sustainer-only simulation after a refused first row and describes its motors', async () => {
    const valid = `<SimulationResults><SimulationName>Sustainer only</SimulationName><Stage3Engines>
      <EngineSet><EngineCount>1</EngineCount><EngineCode>B4</EngineCode><EngineMfg>Estes</EngineMfg>
      <MountSerialNo>7</MountSerialNo><EjectionDelay>4</EjectionDelay><IgnitionDelay>2</IgnitionDelay>
      </EngineSet></Stage3Engines></SimulationResults>`;
    const imported = importRkt(stagedFixture.replace('</SimulationResultsList>', `${valid}</SimulationResultsList>`));
    const motor = (await loadCatalogueMotor('Estes', 'B4', 4))!;
    expect(motor).toBeTruthy();
    const resolved = await resolveImportMotors(imported, async () => ({ motor, note: '' }));
    const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text });
    expect(imported.configs).toHaveLength(2);
    expect(imported.configs[0]!.motorLoadoutRefusal).toMatch(/4 motors/);
    expect(imported.configs[0]!.motors).toEqual({});
    expect.soft(imported.chosenConfigId).toBe('rocksim-sim-2');
    expect.soft(plan.snapshot.activeConfigId).toBe('rocksim-sim-2');
    expect.soft(Object.values(plan.snapshot.mountMotors).map(m => m.spec.designation)).toEqual(['B4']);
    expect.soft(plan.snapshot.savedConfigs.find(c => c.id === plan.snapshot.activeConfigId)?.motorLoadoutRefusal)
      .toBeUndefined();
    expect.soft(plan.note.text).toMatch(/Simulation 2 .*Sustainer only.*lowest stage's motors timed from launch/);
    expect.soft(plan.note.text).not.toMatch(/Simulation 1 .*lowest stage's motors timed from launch/);
    expect(plan.note.text).toMatch(/Launch refused for Simulation 1/);
    expect(plan.note.severity).toBe('warn');
    expect(Object.values(imported.configs[1]!.motors)[0]).toMatchObject({ ignitionEvent: 'launch', ignitionDelay: 2 });
  });

  it('opens a refused row when all staged configurations are refused without claiming motor timing', async () => {
    const plan = await open(stagedFixture);
    expect(plan.snapshot.activeConfigId).toBe('rocksim-sim-1');
    expect(plan.snapshot.mountMotors).toEqual({});
    expect(plan.note.severity).toBe('warn');
    expect(plan.note.text).toMatch(/Launch refused for Simulation 1/);
    expect(plan.note.text).toMatch(/Simulation 1 .*was opened with no motors loaded/);
    expect(plan.note.text).not.toMatch(/lowest stage's motors timed from launch|flies along unpowered/);
  });

  it('keeps valid and ambiguous simulations separate, even with the same final motor', () => {
    const sim = fixture.match(/<SimulationResults>[\s\S]*?<\/SimulationResults>/)![0];
    const valid = sim.replace(/<EngineSet>[\s\S]*?<\/EngineSet>/g, set =>
      set.includes('<MountSerialNo>100</MountSerialNo>') ? set : '');
    const r = importRkt(fixture.replace('</SimulationResultsList>', `${valid}</SimulationResultsList>`));
    expect(r.configs).toHaveLength(2);
    expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/4 motors/);
    expect(r.configs[1]!.motorLoadoutRefusal).toBeUndefined();
    expect(r.chosenConfigId).toBe(r.configs[1]!.id);
    expect(Object.values(r.motors).map(m => m.designation)).toEqual(['B4']);
  });

  it('counts real mounts before regrouping and does not refuse four stale sets with four real tubes', () => {
    const mount = fixture.match(/<BodyTube>\s*<Name>Motor mount<\/Name>[\s\S]*?<\/BodyTube>/)![0];
    const xml = fixture.replace(mount, [7, 8, 9, 10].map(serial =>
      mount.replace('<SerialNo>7</SerialNo>', `<SerialNo>${serial}</SerialNo>`)).join(''));
    const r = importRkt(xml);
    expect(r.configs[0]!.motorLoadoutRefusal).toBeUndefined();
    expect(Object.keys(r.motors)).toHaveLength(4);
  });

  it('refuses a missing stage mount even when another stage has spare mounts', () => {
    const xml = fixture.replace('<StageCount>1</StageCount>', '<StageCount>2</StageCount>')
      .replace(/<Stage3Engines>/g, '<Stage2Engines>').replace(/<\/Stage3Engines>/g, '</Stage2Engines>');
    const r = importRkt(xml);
    expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/4 motors/);
    expect(r.motors).toEqual({});
  });

  it('warns with configuration and missing motor count, and refuses a guessed flight', async () => {
    const plan = await open();
    expect(plan.note.text).toMatch(/Missing mounts.*4 motors.*mounts that no longer exist/);
    expect(plan.note.text).toMatch(/will not guess which tube each motor belongs in/);
    expect(plan.note.text).toMatch(/Motors & Launch/);
    expect(plan.note.severity).toBe('warn');
    expect(plan.snapshot.mountMotors).toEqual({});
    await expect(simulateDesign(plan.snapshot)).rejects.toThrow(/Launch refused.*Missing mounts/);
  }, 60000);

  it('keeps an unambiguous stale serial flyable', async () => {
    const xml = fixture.replace(/<EngineSet>[\s\S]*?<\/EngineSet>/g, (set) =>
      set.includes('<MountSerialNo>100</MountSerialNo>') ? set : '');
    const plan = await open(xml);
    expect(Object.values(plan.snapshot.mountMotors).map(m => m.spec.designation)).toEqual(['B4']);
    expect(plan.note.text).not.toMatch(/Launch refused/);
    const flight = await simulateDesign(plan.snapshot);
    expect(flight.result.summary.maxAltitude).toBeGreaterThan(0);
  }, 60000);

  it('keeps refusal through switching, syncing, session restore and .ork; assigning a motor clears it', async () => {
    const plan = await open();
    const state = plan.snapshot;
    const config = state.savedConfigs[0]!;
    const switched = planConfigSwitch({ ...state, unmatchedRefs: {} }, config, text);
    expect(switched.note.text).toMatch(/Launch refused/);
    const synced = withActiveConfigSynced(state.savedConfigs, state.activeConfigId, {}, {});
    const session = { ...state, savedConfigs: synced.map(c => ({ ...c, name: null })), savedAt: Date.now() };
    const restored = designStateFromSession(session, { legacyMaxMotorLengthM: null });
    await expect(simulateDesign(restored.state)).rejects.toThrow(/Launch refused/);
    const xml = exportOrk({ name: 'Refusal', tree: state.tree,
      configs: synced.map(c => ({ ...c, name: null, motors: {} })), activeConfigId: state.activeConfigId });
    const reopened = importOrk(xml);
    expect(importOrk(autosaveToOrk(session)).configs[0]!.motorLoadoutRefusal).toMatch(/Launch refused/);
    const replan = planImport(reopened, await resolveImportMotors(reopened), { launch: DEFAULT_CONDITIONS, text });
    await expect(simulateDesign(replan.snapshot)).rejects.toThrow(/Launch refused/);
    const id = motorMounts(state.tree)[0]!.id!;
    const motors = { [id]: (await loadCatalogueMotor('Estes', 'B4', 4))! };
    const repaired = { ...state, mountMotors: motors,
      savedConfigs: withoutStoredRef(state.savedConfigs, state.activeConfigId, id) };
    expect((await simulateDesign(repaired)).result.summary.maxAltitude).toBeGreaterThan(0);
    expect(planConfigSwitch({ ...repaired, unmatchedRefs: {} }, repaired.savedConfigs[0]!, text).note.text)
      .not.toMatch(/Launch refused/);
  }, 60000);

  for (const [name, count] of corpusCases) {
    const path = process.env.ROCKSIM_DESIGNS ? join(process.env.ROCKSIM_DESIGNS, name) : undefined;
    it.skipIf(!path || !existsSync(path))(`refuses ${name} from the local corpus`, async () => {
      const plan = await open(readFileSync(path!, 'utf8'));
      expect(motorMounts(plan.snapshot.tree)).toHaveLength(1);
      expect(plan.note.text).toMatch(new RegExp(`${count} motors.*mounts that no longer exist`));
      const active = plan.snapshot.savedConfigs.find(c => c.id === plan.snapshot.activeConfigId)!;
      if (name === 'Quest/Quest_Lil_Grunt.rkt') {
        expect(plan.snapshot.savedConfigs.every(c => !!c.motorLoadoutRefusal)).toBe(true);
        expect(active.motorLoadoutRefusal).toMatch(/Launch refused/);
        expect(plan.snapshot.mountMotors).toEqual({});
        expect(plan.note.severity).toBe('warn');
        expect(plan.note.text).toMatch(/was opened with no motors loaded/);
      } else {
        expect(active.motorLoadoutRefusal).toBeUndefined();
        expect(Object.keys(plan.snapshot.mountMotors)).toHaveLength(1);
      }
      // Hydra also has valid configurations: open may prefer one of those.
      // Applying the refused row must still refuse, without blocking the others.
      const blocked = plan.snapshot.savedConfigs.find(c => c.motorLoadoutRefusal)!;
      const switched = planConfigSwitch({ ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs }, blocked, text);
      await expect(simulateDesign({ ...plan.snapshot, tree: switched.tree,
        savedConfigs: switched.savedConfigs, activeConfigId: switched.activeConfigId,
        mountMotors: switched.mountMotors })).rejects.toThrow(/Launch refused/);
    }, 60000);
  }
});
