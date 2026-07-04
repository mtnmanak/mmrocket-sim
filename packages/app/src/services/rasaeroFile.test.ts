// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', name), 'utf8');

function flatten(nodes: ComponentNode[]): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

describe('RASAero import — desktop fixture files', () => {
  it('imports the three-stage rocket as three stages', () => {
    const r = importCdx1(fixture('Three-stage rocket.CDX1'));
    expect(r.tree.components.length).toBe(3);
    expect(r.tree.components.map((s) => s.name)).toEqual(['Sustainer', 'Booster', 'Booster 2']);
    // Every booster stage has a body tube.
    for (const st of r.tree.components.slice(1)) {
      expect((st.children ?? []).some((c) => c.type === 'bodytube')).toBe(true);
    }
  });

  it('imports the complex two-stage design with inch→meter conversion', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(r.tree.components.length).toBe(2);
    const all = flatten(r.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    // Tangent Ogive → ogive with shape parameter 1.
    expect(nose['shape']).toBe('ogive');
    // RASAero geometry is inches: every radius must be plausible meters.
    for (const c of all) {
      for (const k of ['aftRadius', 'outerRadius', 'foreRadius']) {
        if (typeof c[k] === 'number') {
          expect(c[k] as number).toBeGreaterThan(0.001);
          expect(c[k] as number).toBeLessThan(0.5);
        }
      }
    }
    // Fins exist, and fins on the boat tail became freeform.
    expect(all.some((c) => c.type === 'trapezoidfinset')).toBe(true);
    const transitions = all.filter((c) => c.type === 'transition');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every((t) => t['shape'] === 'conical')).toBe(true);
    const transFins = transitions.flatMap((t) => (t.children ?? []).filter((c) => c.type.endsWith('finset')));
    expect(transFins.every((f) => f.type === 'freeformfinset')).toBe(true);

    // Recovery slots became parachutes with deployment settings.
    const chutes = all.filter((c) => c.type === 'parachute');
    expect(chutes.length).toBe(2);
    expect(chutes.some((c) => c['deployEvent'] === 'apogee')).toBe(true);
    expect(chutes.some((c) => c['deployEvent'] === 'altitude')).toBe(true);

    // Honest notes: mass caveat + the motors RASAero listed.
    expect(r.notes.join(' ')).toMatch(/no material or wall data/);
    expect(r.notes.join(' ')).toMatch(/Motors in the RASAero file/);
  });

  it('imports the show-off design with its launch lug', () => {
    const r = importCdx1(fixture('Show-off.CDX1'));
    const all = flatten(r.tree.components);
    expect(all.some((c) => c.type === 'launchlug')).toBe(true);
  });
});

describe('RASAero export', () => {
  const design = {
    name: 'CdxOut',
    tree: {
      name: 'CdxOut',
      components: [
        {
          type: 'stage' as const, id: 's0', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.3, aftRadius: 0.0508, thickness: 0.002, shape: 'haack', shapeParameter: 0 },
            {
              type: 'bodytube' as const, id: 'b', length: 1.0, outerRadius: 0.0508, thickness: 0.001,
              children: [
                { type: 'trapezoidfinset' as const, id: 'f', finCount: 4, rootChord: 0.15, tipChord: 0.07, sweep: 0.05, height: 0.11, thickness: 0.004, crossSection: 'airfoil', position: { method: 'bottom' as const, offset: 0 } },
                { type: 'parachute' as const, id: 'p', diameter: 0.9, deployEvent: 'apogee' },
              ],
            },
          ],
        },
      ],
    },
    launchMassKg: 4.5,
    launchCgM: 0.85,
  };

  it('writes a valid CDX1 that round-trips through our importer', () => {
    const xml = exportCdx1(design);
    expect(xml).toContain('<FileVersion>2</FileVersion>');
    expect(xml).toContain('<Shape>Von Karman Ogive</Shape>');
    // 4-inch airframe: 0.0508 m radius → 4 in diameter (trailing zeros stripped).
    expect(xml).toMatch(/<Diameter>4(\.000\d?)?<\/Diameter>/);
    expect(xml).toContain('<AirfoilSection>Subsonic NACA</AirfoilSection>');
    expect(xml).toContain('<SustainerLaunchWt>9.9208</SustainerLaunchWt>');

    const back = importCdx1(xml);
    const all = flatten(back.tree.components);
    const nose = all.find((c) => c.type === 'nosecone')!;
    expect(nose['shape']).toBe('haack');
    expect(nose['length']).toBeCloseTo(0.3, 3);
    const fins = all.find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['finCount']).toBe(4);
    expect(fins['rootChord']).toBeCloseTo(0.15, 3);
    const chute = all.find((c) => c.type === 'parachute')!;
    expect(chute['deployEvent']).toBe('apogee');
  });

  it('rejects fin counts RASAero cannot hold (3–8)', () => {
    const bad = structuredClone(design);
    (bad.tree.components[0]!.children![1]!.children![0] as ComponentNode)['finCount'] = 2;
    expect(() => exportCdx1(bad)).toThrow(/3–8 fins/);
  });

  it('converts trapezoid-shaped freeform fins instead of dropping them', () => {
    const d = {
      name: 'FF',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001,
              children: [{
                type: 'freeformfinset' as const, id: 'f', finCount: 3, thickness: 0.003,
                points: [[0, 0], [0.04, 0.06], [0.09, 0.06], [0.12, 0]] as [number, number][],
                position: { method: 'bottom' as const, offset: 0 },
              }],
            },
          ],
        }],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<Fin>');
    const back = importCdx1(xml);
    const fins = flatten(back.tree.components).find((c) => c.type === 'trapezoidfinset')!;
    expect(fins['rootChord']).toBeCloseTo(0.12, 3);
    expect(fins['tipChord']).toBeCloseTo(0.05, 3);
    expect(fins['sweep']).toBeCloseTo(0.04, 3);
    expect(fins['height']).toBeCloseTo(0.06, 3);
  });

  it('throws (never silently drops) fins RASAero cannot represent', () => {
    const withFin = (fin: ComponentNode) => ({
      name: 'X',
      tree: {
        components: [{
          type: 'stage' as const, id: 's', name: 'Sustainer',
          children: [
            { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
            { type: 'bodytube' as const, id: 'b', length: 0.6, outerRadius: 0.025, thickness: 0.001, children: [fin] },
          ],
        }],
      },
    });
    expect(() => exportCdx1(withFin({
      type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.02, 0.04], [0.05, 0.06], [0.09, 0.05], [0.12, 0]],
    } as ComponentNode))).toThrow(/trapezoid/i);
    expect(() => exportCdx1(withFin({
      type: 'ellipticalfinset', id: 'f', finCount: 3, rootChord: 0.08, height: 0.05, thickness: 0.003,
    } as ComponentNode))).toThrow(/elliptical/i);
  });

  it('round-trips booster shoulder and boat-tail geometry', () => {
    const d = {
      name: 'B',
      tree: {
        components: [
          {
            type: 'stage' as const, id: 's0', name: 'Sustainer',
            children: [
              { type: 'nosecone' as const, id: 'n', length: 0.2, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b0', length: 0.5, outerRadius: 0.02, thickness: 0.001 },
            ],
          },
          {
            type: 'stage' as const, id: 's1', name: 'Booster',
            children: [
              { type: 'transition' as const, id: 'sh', length: 0.05, foreRadius: 0.02, aftRadius: 0.03, thickness: 0.002, shape: 'conical' },
              { type: 'bodytube' as const, id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001 },
              { type: 'transition' as const, id: 'bt', length: 0.06, foreRadius: 0.03, aftRadius: 0.02, thickness: 0.002, shape: 'conical' },
            ],
          },
        ],
      },
    };
    const xml = exportCdx1(d);
    expect(xml).toContain('<ShoulderLength>1.9685</ShoulderLength>'); // 0.05 m in inches
    const back = importCdx1(xml);
    const booster = back.tree.components[1]!;
    const trans = (booster.children ?? []).filter((c) => c.type === 'transition');
    expect(trans.length).toBe(2);
    expect(trans[0]!['length']).toBeCloseTo(0.05, 3);
    expect(trans[1]!['length']).toBeCloseTo(0.06, 3);
    expect(trans[1]!['aftRadius']).toBeCloseTo(0.02, 3);
  });

  it('rejects non-conical transitions', () => {
    const bad = structuredClone(design);
    const children = bad.tree.components[0]!.children! as ComponentNode[];
    children.push({
      type: 'transition', id: 't', length: 0.1, foreRadius: 0.0508, aftRadius: 0.03, shape: 'ogive',
    } as ComponentNode);
    expect(() => exportCdx1(bad)).toThrow(/conical/);
  });
});
