// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { loadSession } from './session.js';
import { noteFlags } from './importNotes.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { simulateFile } from './simulateFile.js';

const ork = (delay: string) => `<openrocket version="1.10"><rocket><name>Delay</name>
  <motorconfiguration configid="one" default="true"/><subcomponents><stage><subcomponents><bodytube>
  <length>0.4</length><radius>0.025</radius><motormount><motor configid="one"><designation>C6</designation>
  <delay>${delay}</delay></motor></motormount></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
afterEach(() => localStorage.clear());

it.each(['-2', '-0.25', '-1e999'])('B-S3-1 clamps ork delay %s with a Caution naming the original value', delay => {
  const r = importOrk(ork(delay));
  expect(Object.values(r.configs[0]!.motors)[0]!.delay).toBe(0);
  expect(r.noteTiers).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringContaining(delay) }));
  expect(r.notes.join('\n')).toMatch(/0 s.*burnout/);
});

it('uses the same clamp after decoding a share link', async () => {
  const r = importOrk(await decodeShareFragment(await encodeShareFragment(ork('-2'))));
  expect(Object.values(r.configs[0]!.motors)[0]!.delay).toBe(0);
  expect(r.noteTiers).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringContaining('-2') }));
});

it.each([['-3', Infinity], ['-0.5', Infinity], ['-1.4', 'every'], ['-2.5', Infinity], ['-1e999', 0]])('keeps base RockSim delay convention for %s', (delay, expected) => {
  const xml = (d: number | string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Delay</Name><StageCount>1</StageCount>
    <Stage3Parts><BodyTube><Name>Mount</Name><SerialNo>1</SerialNo><OD>24</OD><ID>22</ID><Len>300</Len><IsMotorMount>1</IsMotorMount></BodyTube></Stage3Parts>
    </RocketDesign></DesignInformation><SimulationResultsList><SimulationResults><Stage3Engines><EngineSet><EngineCode>C6</EngineCode>
    <EngineMfg>Estes</EngineMfg><MountSerialNo>1</MountSerialNo><EjectionDelay>${d}</EjectionDelay></EngineSet></Stage3Engines>
    </SimulationResults></SimulationResultsList></RockSimDocument>`;
  const r = importRkt(xml(delay));
  const motor = Object.values(r.configs[0]!.motors)[0]!;
  if (expected === 'every') expect(motor.rktEveryDelay).toBe(true);
  else expect(motor.delay).toBe(expected);
  expect(r.notes.join('\n')).not.toMatch(/0 s.*burnout/);
  expect(Object.values(importRkt(xml(-2)).configs[0]!.motors)[0]!.delay).toBe(Infinity);
  expect(Object.values(importRkt(xml(-1)).configs[0]!.motors)[0]!.rktEveryDelay).toBe(true);
});

it('clamps through the shared app/API file-to-flight path and reports ejection at burnout', async () => {
  const tree = defaultTree();
  const source = exportOrk({ name: 'Negative delay flight', tree, motors: {
    [motorMounts(tree)[0]!.id!]: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: -2 },
  } });
  const out = await simulateFile(new TextEncoder().encode(source), 'negative.ork');
  const burnout = out.result.events.find(e => e.type === 'BURNOUT')!;
  const ejection = out.result.events.find(e => e.type === 'EJECTION_CHARGE')!;
  expect(ejection.time).toBeCloseTo(burnout.time, 9);
  expect(out.importNote.text).toMatch(/-2 s.*negative/);
  expect(out.plan.note.group.lines).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringMatching(/-2 s.*negative/) }));
}, 20_000);

it('repairs current, legacy, inactive and unmatched autosaved motor delays with Caution notes', () => {
  const motor = { designation: 'C6', ejectionDelay: -2 };
  const mm = { label: 'C6', spec: motor, meta: {} };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
    tree: { components: [] }, launch: DEFAULT_CONDITIONS, savedAt: 1,
    motor, motorLabel: 'Legacy', mountMotors: { mount: mm },
    unmatchedRefs: { missing: { designation: 'Missing', manufacturer: 'Test', diameter: 0.018, length: 0.07, delay: -3 } },
    savedConfigs: [{ id: 'inactive', name: 'Inactive', motors: { mount: mm },
      unmatchedRefs: { missing: { designation: 'Missing', manufacturer: 'Test', diameter: 0.018, length: 0.07, delay: -4 } } }],
  }));
  const s = loadSession()!;
  expect(s.motor!.ejectionDelay).toBe(0);
  expect(s.mountMotors!['mount']!.spec.ejectionDelay).toBe(0);
  expect(s.savedConfigs![0]!.motors['mount']!.spec.ejectionDelay).toBe(0);
  expect(s.unmatchedRefs!['missing']!.delay).toBe(0);
  expect(s.savedConfigs![0]!.unmatchedRefs!['missing']!.delay).toBe(0);
  expect(noteFlags(s.treeRestoreNotes!)).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringContaining('-2') }));
});
