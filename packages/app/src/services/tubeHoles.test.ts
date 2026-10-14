// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { allowedChildren, FIELDS } from '../tree/schema.js';
import { engineTree, makeNode, normalizeTree } from '../tree/treeModel.js';
import { layoutSchematic } from '../tree/schematicLayout.js';
import { tubeHoleMarks } from '../tree/tubeHoles.js';
import { scaleRocket } from '../tree/scaleRocket.js';
import { exportOrk, importOrk } from './orkFile.js';
import { tubeWrapGeometry, tubeWrapPages } from './tubeWrapGuide.js';
import { browserXmlParser, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

const hole = (props = {}) => ({ type: 'tubehole', id: 'holes', name: 'Vent marks', holeDiameter: 0.003,
  holePosition: 0.025, angleOffset: -Math.PI / 2, holeCount: 4, ...props }) as unknown as ComponentNode;
const tube = (children: ComponentNode[] = []) => ({ id: 'tube', type: 'bodytube', name: 'Tube', length: 0.3,
  outerRadius: 0.012, thickness: 0.0003, density: 950, children }) as ComponentNode;
const tree = (children: ComponentNode[] = []) => ({ name: 'Marked rocket', components: [{ id: 'stage', type: 'stage', children: [
  { id: 'nose', type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' }, tube(children),
] }] }) as RocketTree;

describe('N045 fabrication-only tube holes', () => {
  it('offers the component only on body tubes with bounded, finite defaults', () => {
    expect(allowedChildren('bodytube')).toContain('tubehole');
    expect(allowedChildren('transition')).not.toContain('tubehole');
    const n = makeNode('tubehole');
    expect(FIELDS[n.type].map(f => f.key)).toEqual(['holeDiameter', 'holePosition', 'angleOffset', 'holeCount']);
    const marks = tubeHoleMarks(n);
    expect(marks).toHaveLength(1);
    const repaired = normalizeTree(tree([hole({ holeCount: 1e9, holeDiameter: -1 })]));
    const stored = repaired.components[0]!.children![1]!.children![0]!;
    expect(stored['holeCount']).toBe(64);
    expect(stored['holeDiameter']).toBeGreaterThan(0);
    expect(tubeHoleMarks(hole({ holeCount: Infinity, angleOffset: NaN }))).toHaveLength(1);
    expect(tubeHoleMarks(hole({ holeCount: 1e9 }))).toHaveLength(64);
    const invalid = normalizeTree(tree([hole({ holeCount: 'many', holeDiameter: Infinity, holePosition: NaN, angleOffset: null })]));
    expect(invalid.components[0]!.children![1]!.children![0]).toMatchObject({ holeCount: 1, holeDiameter: 0.003, holePosition: 0.025, angleOffset: 0 });
  });

  it('marks equally spaced holes in the side view and on the wrap, including the seam and page joins', () => {
    const design = tree([hole()]);
    const body = design.components[0]!.children![1]!;
    const g = tubeWrapGeometry(design, body);
    expect(g.holes).toHaveLength(4);
    expect(g.holes.map(h => h.angle)).toEqual([3 * Math.PI / 2, 0, Math.PI / 2, Math.PI]);
    expect(g.holes[1]!.x).toBe(0);
    expect(g.holes[0]!.station).toBe(0.025);
    const layout = layoutSchematic(design, { scale: 1000, cy: 100, x0: 0, roll: 0, idPrefix: 'holes' });
    const drawn = layout.shapes.filter(s => s.attrs['data-part'] === 'tube-hole');
    expect(drawn).toHaveLength(4);
    expect(drawn[0]!.part!.id).toBe('holes');
    expect(drawn[0]!.attrs['cx']).toBeCloseTo(95, 9);
    const pages = tubeWrapPages(g, 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(pages[0]!.svg, 'image/svg+xml');
    expect(doc.querySelectorAll('.drilling-mark')).toHaveLength(5); // zero-angle mark at both seam edges
    expect(pages.every(p => p.svg.includes('Fabrication only'))).toBe(true);
    const joined = tree([hole({ holePosition: 0.19 })]);
    expect(tubeWrapPages(tubeWrapGeometry(joined, joined.components[0]!.children![1]!), 'Rocket', { length: 'mm', angle: '°' })
      .every(p => p.svg.includes('class="drilling-mark"'))).toBe(true);
  });

  it.each([['browser', browserXmlParser], ['JavaScript', jsXmlParser]] as const)('round-trips metadata outside desktop subcomponents with the %s parser', (_, parser) => {
    setXmlParser(parser);
    try {
    const xml = exportOrk({ tree: tree([hole({ comment: 'Drill & measure', color: '#123456' })]), name: 'Marked rocket' });
    expect(xml).toContain('<mmrsim-tube-holes>');
    // happy-dom refuses desktop's single-quoted declaration; importOrk applies the same strip.
    const doc = new DOMParser().parseFromString(xml.replace(/^\s*<\?xml[^?]*\?>/, ''), 'text/xml');
    expect(doc.querySelectorAll('subcomponents > tubehole, subcomponents > mmrsim-tube-holes')).toHaveLength(0);
    expect(doc.querySelector('bodytube > mmrsim-tube-holes > hole')).not.toBeNull();
    // The writer mints desktop UUIDs on each save; all physical XML must otherwise match.
    const desktopXml = (value: string) => value.replace(/\s*<mmrsim-tube-holes>[\s\S]*?<\/mmrsim-tube-holes>/, '')
      .replace(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/gi, 'UUID');
    expect(desktopXml(xml)).toBe(desktopXml(exportOrk({ tree: tree(), name: 'Marked rocket' })));
    const imported = importOrk(xml).tree.components[0]!.children![1]!.children![0]!;
    expect(imported).toMatchObject({ type: 'tubehole', name: 'Vent marks', holeDiameter: 0.003, holePosition: 0.025,
      holeCount: 4, angleOffset: -Math.PI / 2, comment: 'Drill & measure', color: '#123456' });
    expect(importOrk(exportOrk({ tree: importOrk(xml).tree, name: 'Marked rocket' })).tree.components[0]!.children![1]!.children)
      .toHaveLength(1);
    } finally { setXmlParser(browserXmlParser); }
  });

  it('keeps kernel inputs, mass, CG, drag and the entire seeded flight identical even with stale overrides', () => {
    resetEngine();
    const fins = { id: 'fins', type: 'freeformfinset', finCount: 3, thickness: 0.003, crossSection: 'rounded',
      points: [[0, 0], [0.02, 0.03], [0.045, 0.03], [0.05, 0]], position: { method: 'bottom', offset: 0 } } as ComponentNode;
    const mount = { id: 'mount', type: 'innertube', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true } as ComponentNode;
    const chute = { type: 'parachute', diameter: 0.3 } as ComponentNode;
    const plain = tree([fins, mount, chute]);
    const marked = tree([fins, mount, chute, hole({ mass: 1, overrideMass: 2, overrideCD: 5, overrideCGX: 0.2 })]);
    expect(engineTree(marked)).toEqual(engineTree(plain));
    const motor: MotorSpec = { designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
      times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2], thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132] };
    const run = (design: RocketTree) => {
      const r = OrkRocket.buildTree(engineTree(design));
      r.setMotorById('mount', motor);
      return { stat: r.staticInfo(), drag: r.dragSweep({ machMin: 0.1, machMax: 1, machStep: 0.1 }),
        flight: r.simulate({ randomSeed: 42, windAverage: 2, windStdDeviation: 0, series: 'full' }) };
    };
    const a = run(plain), b = run(marked);
    expect(b).toEqual(a); // Differential equality on this runtime; no hard-coded kernel floats or computation-time series.
    expect(a.flight.summary.maxAltitude).toBeGreaterThan(0);
    console.info('N045 flight identity:', JSON.stringify({ runtime: process.version, summary: a.flight.summary,
      series: Object.keys(a.flight.series).length, samples: a.flight.series.time.length }));
  }, 60000);

  it('excludes annotations before the body-area reference for other app parts is computed', () => {
    const bump = { id: 'bump', type: 'protuberance', width: 0.01, height: 0.004, length: 0.02,
      cdFrontal: 0.5, mass: 0.005 } as unknown as ComponentNode;
    const stale = hole({ children: [{ type: 'bodytube', outerRadius: 0.5, length: 0.1 }] });
    expect(engineTree(tree([bump, stale]))).toEqual(engineTree(tree([bump])));
  });

  it('scales implicit hole dimensions from their fabrication defaults, retaining angles and count', () => {
    const scaled = scaleRocket(tree([hole({ holeDiameter: undefined, holePosition: undefined })]), 2).tree;
    const mark = scaled.components[0]!.children![1]!.children![0]!;
    expect(mark['holeDiameter']).toBeCloseTo(0.006, 12); // Twice the 3 mm fabrication default, pure SI arithmetic.
    expect(mark['holePosition']).toBeCloseTo(0.05, 12);
    expect(mark['holeCount']).toBe(4);
    expect(mark['angleOffset']).toBe(-Math.PI / 2);
    expect(engineTree(scaled)).toEqual(engineTree(scaleRocket(tree(), 2).tree));
  });
});
