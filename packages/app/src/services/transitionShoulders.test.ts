import { afterAll, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { OrkRocket, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { FIELDS, applyFieldLimit, blankValue, fieldLimit } from '../tree/schema.js';
import { sanitizeTree } from '../tree/sanitize.js';
import { scaleRocket } from '../tree/scaleRocket.js';
import { engineTree } from '../tree/treeModel.js';
import presetsJson from '../data/presets.json';
import { presetPatch, type Preset } from './presets.js';

// Keep Node's native compression streams/Blob for the real share-link codec.
const window = new Window();
vi.stubGlobal('DOMParser', window.DOMParser);
afterAll(() => { vi.unstubAllGlobals(); window.close(); });

const transition: ComponentNode = {
  type: 'transition', id: 'tr', name: 'Reducer', length: 0.08,
  foreRadius: 0.025, aftRadius: 0.015, thickness: 0.001, shape: 'conical',
  foreShoulderRadius: 0.024, foreShoulderLength: 0.02, foreShoulderThickness: 0.0015,
  aftShoulderRadius: 0.0145, aftShoulderLength: 0.03, aftShoulderThickness: 0.002,
  foreShoulderCapped: true, aftShoulderCapped: true,
};
const treeOf = (node: ComponentNode): RocketTree => ({
  name: 'K15', components: [{ type: 'stage', id: 'stage', children: [node] }],
});
const part = (tree: RocketTree) => tree.components[0]!.children![0]!;

describe('catalogue-linked shoulder import precedence', () => {
  const presets = (presetsJson as { presets: Preset[] }).presets;
  const mass = (node: ComponentNode) => OrkRocket.buildTree(engineTree(treeOf(node))).staticInfo().mass;
  for (const [type, manufacturer, partNo, shoulders] of [
    ['nosecone', 'Estes', 'BNC-50K, 70262', ['shoulder']],
    ['transition', 'SEMROC', 'TA-2050', ['foreShoulder', 'aftShoulder']],
  ] as const) {
    const row = presets.find((p) => p.manufacturer === manufacturer && p.partNo === partNo)!;
    const picked = (): ComponentNode => ({ type, id: 'part', ...presetPatch(type, row) });
    const write = (node: ComponentNode, format: 'ork' | 'rkt') => format === 'ork'
      // Exercise foreign-file enrichment, not the app-owned identity-only path.
      ? exportOrk({ name: 'Shoulders', tree: treeOf(node) }).replace(/creator="[^"]*"/, 'creator="OpenRocket 24.12"')
      : exportRkt({ name: 'Shoulders', tree: treeOf(node) });
    const read = (xml: string, format: 'ork' | 'rkt') => format === 'ork'
      ? importOrk(xml, { presets }) : importRkt(xml, { presets });

    it.each([0, 0.001])(`${type} .rkt uses its hollow wall when the catalogue supplies missing shoulder geometry (%s m)`, (thickness) => {
      const node: ComponentNode = { ...picked(), filled: false, thickness };
      for (const shoulder of shoulders) node[`${shoulder}Thickness`] = thickness;
      const xml = write(node, 'rkt').replace(/<([a-zA-Z]*[Ss]houlder[a-zA-Z]*)>[^<]*<\/\1>/g, '');
      const result = read(xml, 'rkt');
      const got = part(result.tree);
      for (const shoulder of shoulders) expect(got[`${shoulder}Thickness`]).toBe(thickness);
      expect(Math.abs(mass(got) - mass(node))).toBeLessThan(Math.max(mass(node) * 1e-6, 1e-12));
      expect(result.notes.find((n) => n.includes('matched the parts catalogue'))).not.toMatch(/took [^;]*shoulder thickness/);
    });

    it(`${type} .rkt keeps its solid construction when a hollow catalogue row supplies shoulder geometry`, () => {
      const node = picked();
      const xml = write(node, 'rkt').replace(/<([a-zA-Z]*[Ss]houlder[a-zA-Z]*)>[^<]*<\/\1>/g, '');
      const got = part(importRkt(xml, { presets: [{ ...row, filled: false }] }).tree);
      for (const shoulder of shoulders) expect(got[`${shoulder}Thickness`]).toBe(node[`${shoulder}Radius`]);
      expect(Math.abs(mass(got) - mass(node))).toBeLessThan(mass(node) * 1e-6);
    });

    for (const format of ['ork', 'rkt'] as const) {
      for (const dimension of ['Length', 'Radius', 'Thickness'] as const) {
        it(`${type} .${format} keeps explicit zero ${dimension}, geometry and kernel mass on import and round trip`, () => {
          const node = picked();
          expect(row.mass).toBeUndefined();
          for (const shoulder of shoulders) node[`${shoulder}${dimension}`] = 0;
          if (format === 'rkt' && dimension === 'Thickness') {
            // RockSim has one WallThickness and ConstructionType for the whole part.
            node['filled'] = false;
            node['thickness'] = 0;
          }
          if (format === 'rkt' && dimension === 'Radius') {
            for (const shoulder of shoulders) node[`${shoulder}Thickness`] = 0;
          }
          const expectedMass = mass(node);
          let xml = write(node, format);
          for (let pass = 0; pass < 2; pass++) {
            const result = read(xml, format);
            const got = part(result.tree);
            expect(got['presetPartNo']).toBe(partNo);
            for (const shoulder of shoulders) {
              for (const field of ['Length', 'Radius', 'Thickness']) {
                expect.soft(got[`${shoulder}${field}`]).toBeCloseTo(node[`${shoulder}${field}`] as number, 12);
              }
            }
            // Same shipped kernel, before/after serialization; 1 ppm accommodates rounding.
            expect.soft(Math.abs(mass(got) - expectedMass)).toBeLessThan(Math.max(expectedMass * 1e-6, 1e-12));
            const matchNote = result.notes.find((n) => n.includes('matched the parts catalogue'))!;
            expect(matchNote).not.toMatch(/took [^;]*shoulder/);
            xml = write(got, format);
          }
        });
      }

      it(`${type} .${format} enriches genuinely omitted shoulder dimensions`, () => {
        const xml = write(picked(), format).replace(/<([a-zA-Z]*[Ss]houlder[a-zA-Z]*)>[^<]*<\/\1>/g, '');
        const got = part(read(xml, format).tree);
        for (const shoulder of shoulders) {
          expect(got[`${shoulder}Length`]).toBe(picked()[`${shoulder}Length`]);
          expect(got[`${shoulder}Radius`]).toBe(picked()[`${shoulder}Radius`]);
        }
      });

      for (const absentBy of ['Length', 'Radius'] as const) {
        it(`${type} .${format} does not fill a shoulder explicitly absent by zero ${absentBy}`, () => {
          const node = picked();
          for (const shoulder of shoulders) node[`${shoulder}${absentBy}`] = 0;
          const xml = write(node, format).replace(/<([a-zA-Z]*[Ss]houlder[a-zA-Z]*)>([^<]*)<\/\1>/g,
            (whole, _tag, value) => Number(value) === 0 ? whole : '');
          const result = read(xml, format);
          const got = part(result.tree);
          for (const shoulder of shoulders) {
            expect(got[`${shoulder}${absentBy}`]).toBe(0);
            expect(got[`${shoulder}${absentBy === 'Length' ? 'Radius' : 'Length'}`]).toBeUndefined();
          }
          expect(result.notes.find((n) => n.includes('matched the parts catalogue'))).not.toMatch(/took [^;]*shoulder/);
        });
      }
    }
  }
});

describe('K15 transition shoulder thickness', () => {
  it.each(['fore', 'aft'])('%s field uses the nose thickness units, limits and zero default', (side) => {
    const key = `${side}ShoulderThickness`;
    const fields = FIELDS.transition;
    const f = fields.find((field) => field.key === key)!;
    const nose = FIELDS.nosecone.find((field) => field.key === 'shoulderThickness')!;
    expect(f).toEqual({ ...nose, key, label: `${side === 'fore' ? 'Fore' : 'Aft'} shoulder thickness` });
    expect(fields[fields.indexOf(f) - 1]!.key).toBe(`${side}ShoulderLength`);
    expect(blankValue('transition', key)).toBe(0);
    expect(fieldLimit('transition', key)).toEqual(fieldLimit('nosecone', 'shoulderThickness'));
    expect(applyFieldLimit(fieldLimit('transition', key)!, -0.001)).toBe(0);
  });

  it('sanitizes both walls with named repair notes and preserves omitted keys', () => {
    const notes: string[] = [];
    const fixed = part(sanitizeTree(treeOf({ ...transition,
      foreShoulderThickness: -0.001, aftShoulderThickness: -0.002,
    }), notes));
    expect(fixed['foreShoulderThickness']).toBe(0);
    expect(fixed['aftShoulderThickness']).toBe(0);
    expect(notes.join(' ')).toContain('fore shoulder thickness');
    expect(notes.join(' ')).toContain('aft shoulder thickness');
    const omitted = part(sanitizeTree(treeOf({ type: 'transition' })));
    expect(omitted).not.toHaveProperty('foreShoulderThickness');
    expect(omitted).not.toHaveProperty('aftShoulderThickness');
  });

  it.each([false, true])('preserves independent walls and caps through .ork (share link: %s)', async (share) => {
    const xml = exportOrk({ name: 'K15', tree: treeOf(transition) });
    const payload = share ? await decodeShareFragment(await encodeShareFragment(xml)) : xml;
    const got = part(importOrk(payload).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness', 'Capped']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe(transition[key]);
      }
    }
  });

  it('scales each wall with its shoulder and leaves cap flags and input unchanged', () => {
    const tree = treeOf(transition);
    const got = part(scaleRocket(tree, 2).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe((transition[key] as number) * 2);
      }
      expect(got[`${side}ShoulderCapped`]).toBe(true);
    }
    expect(part(tree)['aftShoulderThickness']).toBe(0.002);
  });

  it.each([false, true])('imports .rkt shoulder walls using desktop rules (filled: %s)', (filled) => {
    const xml = `<RockSimDocument><DesignInformation><RocketDesign><Name>K15</Name>
      <StageCount>1</StageCount><Stage3Parts><Transition><Name>Reducer</Name>
      <Len>80</Len><FrontDia>50</FrontDia><RearDia>30</RearDia><WallThickness>2</WallThickness>
      <ConstructionType>${filled ? 0 : 1}</ConstructionType>
      <FrontShoulderLen>20</FrontShoulderLen><FrontShoulderDia>48</FrontShoulderDia>
      <RearShoulderLen>30</RearShoulderLen><RearShoulderDia>29</RearShoulderDia>
      </Transition></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
    const got = part(importRkt(xml).tree);
    expect(got['foreShoulderThickness']).toBe(filled ? 0.024 : 0.002);
    expect(got['aftShoulderThickness']).toBe(filled ? 0.0145 : 0.002);
  });

  it.each([false, true])('exports .rkt shoulder geometry and its representable thickness (filled: %s)', (filled) => {
    const node = { ...transition, filled, foreShoulderCapped: false, aftShoulderCapped: false,
      foreShoulderThickness: filled ? 0.024 : 0.001,
      aftShoulderThickness: filled ? 0.0145 : 0.001 };
    const notes: string[] = [];
    const xml = exportRkt({ name: 'K15', tree: treeOf(node), notes });
    expect(notes).toEqual([]);
    const got = part(importRkt(xml).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe(node[key as keyof typeof node]);
      }
    }
  });

  it.each(['fore', 'aft'])('reports .rkt loss of independent %s wall or cap', (side) => {
    const base = { ...transition, foreShoulderThickness: 0.001, aftShoulderThickness: 0.001,
      foreShoulderCapped: false, aftShoulderCapped: false };
    for (const extra of [{ [`${side}ShoulderThickness`]: 0.002 }, { [`${side}ShoulderCapped`]: true }]) {
      const notes: string[] = [];
      exportRkt({ name: 'K15', tree: treeOf({ ...base, ...extra }), notes });
      expect(notes.join(' ')).toContain('cannot keep their end caps');
      expect(notes.join(' ')).toContain('Use .ork');
    }
  });

  it('does not report .rkt shoulder loss when neither shoulder has length', () => {
    const notes: string[] = [];
    exportRkt({ name: 'K15', tree: treeOf({ ...transition, foreShoulderLength: 0, aftShoulderLength: 0 }), notes });
    expect(notes).toEqual([]);
  });
});
