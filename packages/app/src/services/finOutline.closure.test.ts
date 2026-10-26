// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { engineTree, normalizeTree } from '../tree/treeModel.js';
import { treeProblems } from '../tree/sanitize.js';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { tubeFinWall } from '../tree/tubefins.js';
import { importCdx1 } from './rasaeroFile.js';

it.each(['rounded', 'airfoil'])('ignores collapsed %s fins during RockSim import alignment', crossSection => {
  const outline = [[0, 0], [0.02, 0.03], [0.06, 0]];
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.3,
    outerRadius: 0.025, children: [0, 0.003].map((thickness, i) => ({
      type: 'freeformfinset', name: i === 0 ? 'Phantom' : 'Real', crossSection, thickness,
      finCount: 3, rotation: 0, points: outline,
    })) }] }] };
  const result = importRkt(exportRkt({ name: 'Collapsed', tree }));
  const real = fins(result.tree.components).find(n => n.name === 'Real')!;
  expect(real['rotation'] ?? 0).toBe(0);
  expect(result.notes.join(' ')).not.toMatch(/rotat|interleav/i);
});

it('snaps an oversized RASAero transition fin through the same load boundary', () => {
  const result = importCdx1(`<RASAeroDocument><RocketDesign>
    <BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>
    <Transition><Length>10</Length><RearDiameter>2</RearDiameter>
    <Fin><Chord>2.3622047244</Chord><TipChord>0</TipChord><SweepDistance>0.7874015748</SweepDistance>
    <Span>118.11023622</Span><Count>3</Count></Fin></Transition>
    </RocketDesign></RASAeroDocument>`);
  expect((fins(result.tree.components)[0]!['points'] as number[][])[1]![1]).toBe(2.5);
  expect(result.notes.join(' ')).toMatch(/2.5/);
});

it.each(['tf', undefined])('preserves inherited tube-fin wall thickness through an ork save (id %s)', id => {
  const fin: ComponentNode = { type: 'tubefinset', id, length: 0.08 };
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.4,
    outerRadius: 0.025, thickness: 0.0008, children: [fin] }] }] };
  const loaded = importOrk(exportOrk({ name: 'R', tree }));
  const body = loaded.tree.components[0]!.children![0]!;
  expect(tubeFinWall(body.children![0]!, 0.02, body['thickness'] as number)).toBeCloseTo(0.0008, 12);
});

it('measures each imported RockSim freeform span once during de-collision', () => {
  const outline = Array.from({ length: 200 }, (_, i) => [i * 0.0001, i === 0 || i === 199 ? 0 : 0.02]);
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 10, outerRadius: 0.025,
    children: Array.from({ length: 40 }, (_, i): ComponentNode => ({ type: 'freeformfinset', points: outline,
      position: { method: 'top', offset: i * 0.1 }, finCount: 1 })),
  }] }] };
  const xml = exportRkt({ name: 'R', tree });
  const max = vi.spyOn(Math, 'max');
  try {
    const imported = importRkt(xml);
    expect(fins(imported.tree.components)).toHaveLength(40);
    expect(max.mock.calls.filter(args => args.length === 200).length).toBeLessThan(200);
  } finally { max.mockRestore(); }
});

const points = [[0, 0], [0.02, 3], [0.06, 0]];
const fixture = (crossSection: string): RocketTree => ({ components: [{ type: 'stage', children: [
  { type: 'bodytube', length: 0.4, outerRadius: 0.025, children: [
    { type: 'freeformfinset', id: 'fin', name: 'Fins', crossSection, points },
  ] },
] }] });
const fins = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [
  ...(n.type === 'freeformfinset' ? [n] : []), ...fins(n.children ?? []),
]);

it.each(['rounded', 'airfoil'].flatMap(section => [
  [[0, 0], [2.5, 2.5], [3, 2.6], [3.5, 0]],
  [[0, 0], [3, 3], [3.5, 0]],
].map(outline => [section, outline] as const)))(
  'preserves the single-pass kernel geometry of a two-axis oversized %s fin %j', (section, outline) => {
    const raw = fixture(section);
    fins(raw.components)[0]!['points'] = outline;
    resetEngine();
    const before = OrkRocket.buildTree(engineTree(raw)).staticInfo();
    const notes: string[] = [];
    const once = normalizeTree(raw, notes);
    const twice = normalizeTree(once);
    expect(fins(once.components)[0]!['points']).toEqual(outline);
    expect(fins(twice.components)[0]!['points']).toEqual(outline);
    expect(notes.join(' ')).toMatch(/2.5/);
    expect(treeProblems(twice).join(' ')).toMatch(/2.5/);
    resetEngine();
    const after = OrkRocket.buildTree(engineTree(twice)).staticInfo();
    expect(after.mass).toBeCloseTo(before.mass, 10);
    expect(after.cg).toBeCloseTo(before.cg, 10);
  });

it.each(['rounded', 'airfoil'])('snaps restored and imported %s fins to the outline actually flown', crossSection => {
  const raw = fixture(crossSection);
  expect(treeProblems(raw).join(' ')).toMatch(/2.5/);
  const notes: string[] = [];
  const normalized = normalizeTree(raw, notes);
  expect((fins(normalized.components)[0]!['points'] as number[][])[1]![1]).toBe(2.5);
  expect(notes.join(' ')).toMatch(/2.5/);
  const ork = importOrk(exportOrk({ name: 'R', tree: raw }));
  const rkt = importRkt(exportRkt({ name: 'R', tree: raw }));
  for (const imported of [ork, rkt]) {
    expect((fins(imported.tree.components)[0]!['points'] as number[][])[1]![1]).toBe(2.5);
    expect(imported.notes.join(' ')).toMatch(/2.5/);
  }
});
