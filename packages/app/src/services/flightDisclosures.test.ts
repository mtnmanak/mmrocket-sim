// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { describeFile, motorFreeProjection } from './describeFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { currentPlacementStamp, legacyPositionCandidates, pendingLegacyPositions } from './legacyPositionCheck.js';
import { designStateFromSession } from './sessionRestore.js';
import { resetKernelForTests } from './simulateDesign.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { delayMountsOf, solveAutoDelays } from './autoDelaySolver.js';
import { probeFlight, testMotor } from './autoDelay.testSupport.js';

afterEach(() => resetKernelForTests());

it('J23 describes the static base-drag caution beside finite stability', async () => {
  const tree: RocketTree = { name: 'Base cone', components: [{ type: 'stage', id: 's', children: [
    { type: 'nosecone', id: 'n', length: 0.2, aftRadius: 0.05, thickness: 0.002 },
    { type: 'bodytube', id: 'b', length: 0.7, outerRadius: 0.05, thickness: 0.002 },
    { type: 'transition', id: 'tail', name: 'Base drag cone', length: 0.32, axialMethod: 'after',
      foreRadius: 1.27e-6, aftRadius: 0.05, thickness: 2.54e-8, overrideMass: 0 },
  ] }] };
  const bytes = zipSync({ 'rocket.ork': strToU8(exportOrk({ name: 'Base cone', tree })) });
  const out = await describeFile(bytes, 'base.ork');
  expect(Number.isFinite(out.analysis.stabilityCalibers)).toBe(true);
  expect(out.notes.analysis.join(' ')).toContain('Possible base-drag model:');
  expect(out.notes.analysis.join(' ')).toMatch(/stability/i);
}, 60_000);

const rkt = `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign><Name>Pod</Name>
  <Stage3Parts><BodyTube><Name>Core</Name><Len>700</Len><OD>100</OD><ID>96</ID><AttachedParts>
  <ExternalPod><Name>Pod</Name><AttachedParts><NoseCone><Name>Pod nose</Name><Len>100</Len><BaseDia>30</BaseDia></NoseCone>
  <BodyTube><Name>Pod tube</Name><Len>300</Len><OD>30</OD><ID>28</ID><AttachedParts>
  <BodyTube><Name>Inner</Name><Len>100</Len><OD>20</OD><ID>18</ID><IsMotorMount>1</IsMotorMount></BodyTube>
  </AttachedParts></BodyTube></AttachedParts></ExternalPod></AttachedParts></BodyTube></Stage3Parts>
  </RocketDesign></DesignInformation></RockSimDocument>`;
const cdx = `<RASAeroDocument><RocketDesign><NoseCone><Length>6</Length><Diameter>4</Diameter></NoseCone>
  <BodyTube><Length>20</Length><Diameter>4</Diameter></BodyTube>
  <FinCan><Length>6</Length><Diameter>4</Diameter><ShoulderLength>1</ShoulderLength>
  <Fin><Count>3</Count><RootChord>4</RootChord><TipChord>2</TipChord><Span>3</Span><SweepDistance>1</SweepDistance></Fin>
  </FinCan></RocketDesign></RASAeroDocument>`;
it.each([['rkt', () => importRkt(rkt)], ['cdx1', () => importCdx1(cdx)]] as const)(
  'J23 %s imports retain current placement through save and restore', (_format, read) => {
    const imported = read();
    expect(legacyPositionCandidates(imported.tree).length).toBeGreaterThan(0);
    expect(currentPlacementStamp(imported.tree)).toContain('mmrsim-placement="current"');
    expect(importOrk(exportOrk({ name: imported.name, tree: imported.tree })).notes.join(' ')).not.toContain('Possible pre-v0.138');
    const restored = designStateFromSession({ tree: imported.tree, savedAt: 1, launch: DEFAULT_CONDITIONS }, { legacyMaxMotorLengthM: null });
    expect(pendingLegacyPositions(restored.state.tree)).toEqual([]);
    expect(restored.restoreNotes.join(' ')).not.toContain('Possible pre-v0.138');
    expect(JSON.stringify(restored)).not.toContain('Possible pre-v0.138');
  });

it('J23 motor-free projection remaps pending placement identities on a private clone', () => {
  const tree = { name: 'Pending', components: [{ type: 'stage', id: 'c123' } as ComponentNode],
    legacyPositionCheck: { pending: ['c123'], provenance: 'current' } };
  const projected = motorFreeProjection({ tree, mountMotors: {}, savedConfigs: [], activeConfigId: null,
    launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null } });
  expect((projected.tree as typeof tree).legacyPositionCheck.pending).toEqual(['n1']);
  expect(tree.legacyPositionCheck.pending).toEqual(['c123']);
});

it('J23 a truncated Auto target names Maximum flight time', async () => {
  const result = probeFlight(['a']);
  result.delayProbe!.branches[0]!.events = result.delayProbe!.branches[0]!.events.filter(e => e.type !== 'GROUND_HIT');
  await expect(solveAutoDelays({ mounts: delayMountsOf([['a', testMotor()]]), probe: () => result,
    budget: { probes: 0 }, yieldToUi: () => Promise.resolve() })).rejects.toThrow(/Maximum flight time/);
});

it('J23 committed foreign fixtures also record current provenance', () => {
  for (const [name, read] of [['rocksimTestRocket1.rkt', importRkt], ['Show-off.CDX1', importCdx1]] as const) {
    const result = read(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8'));
    expect(result.tree).toHaveProperty('legacyPositionCheck.provenance', 'current');
  }
});
