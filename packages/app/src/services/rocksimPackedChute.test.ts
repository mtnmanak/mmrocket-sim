// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { importRkt, rktPackedChuteSize } from './rocksimFile.js';
import { engineTree } from '../tree/treeModel.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

/**
 * A RockSim parachute's PACKED size (board Tier 2, v0.147's claim check).
 * RockSim files carry none, so desktop's ParachuteHandler makes one up when
 * <Dia> closes: 0.9 of a parent body tube's OUTER radius, 0.9 of a parent
 * inner tube's INNER radius, else 2.5 % of the canopy's diameter — and uses
 * that one number for the packed radius AND the packed length. The app kept
 * the kernel's 25 mm x 12.5 mm, so every .rkt chute's CG sat elsewhere.
 */
const rkt = (inner: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Chutes</Name>
  <StageCount>1</StageCount><Stage3Parts>
    <NoseCone><Name>Nose</Name><Len>200</Len><BaseDia>98</BaseDia><ShapeCode>1</ShapeCode>
      <AttachedParts>
        <Parachute><Name>Nose chute</Name><Dia>600</Dia><Xb>10</Xb><LocationMode>0</LocationMode></Parachute>
      </AttachedParts></NoseCone>
    <BodyTube><Name>Body</Name><OD>98</OD><ID>96</ID><Len>800</Len>
      <AttachedParts>
        <Parachute><Name>Main</Name><Dia>1200</Dia><Xb>20</Xb><LocationMode>0</LocationMode></Parachute>
        ${inner}
      </AttachedParts></BodyTube>
  </Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;

const flatten = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const byName = (xml: string, name: string) => flatten(importRkt(xml).tree.components).find((n) => n.name === name)!;

describe('a .rkt parachute packs as desktop packs it', () => {
  it('in a body tube: 0.9 x the tube’s OUTER radius, for radius and length alike', () => {
    const main = byName(rkt(''), 'Main');
    expect(main['packedRadius']).toBeCloseTo(0.049 * 0.9, 12);
    expect(main['packedLength']).toBeCloseTo(0.049 * 0.9, 12);
  });

  it('in an inner tube: 0.9 x the tube’s INNER radius', () => {
    const xml = rkt(`<BodyTube><Name>Bay</Name><OD>54</OD><ID>50</ID><Len>300</Len><IsInsideTube>1</IsInsideTube>
      <AttachedParts><Parachute><Name>Drogue</Name><Dia>450</Dia></Parachute></AttachedParts></BodyTube>`);
    const drogue = byName(xml, 'Drogue');
    expect(drogue['packedRadius']).toBeCloseTo(0.025 * 0.9, 12);
    expect(drogue['packedLength']).toBeCloseTo(0.025 * 0.9, 12);
  });

  it('anywhere else: 2.5 % of the canopy diameter', () => {
    const nose = byName(rkt(''), 'Nose chute');
    expect(nose['packedRadius']).toBeCloseTo(0.6 * 0.025, 12);
    expect(nose['packedLength']).toBeCloseTo(0.6 * 0.025, 12);
  });

  it('a chute with no <Dia> keeps the kernel’s own 25 mm x 12.5 mm, as desktop does', () => {
    const xml = rkt('<Parachute><Name>Bare</Name></Parachute>');
    const bare = byName(xml, 'Bare');
    expect(bare['packedRadius']).toBeUndefined();
    expect(bare['packedLength']).toBeUndefined();
  });

  it('the kernel flies it: the chute’s CG sits half the packed length behind its front', () => {
    resetEngine();
    const tree = importRkt(rkt('')).tree;
    const main = flatten(tree.components).find((n) => n.name === 'Main')!;
    const info = OrkRocket.buildTree(engineTree(tree)).componentInfo(main.id!);
    expect(info.length).toBeCloseTo(0.0441, 9);
    expect(info.cgX).toBeCloseTo(0.0441 / 2, 9);
  }, 30_000);

  it('the helper is the one rule', () => {
    expect(rktPackedChuteSize({ type: 'bodytube', outerRadius: 0.05, thickness: 0.002 }, 1)).toBeCloseTo(0.045, 12);
    expect(rktPackedChuteSize({ type: 'innertube', outerRadius: 0.05, thickness: 0.002 }, 1)).toBeCloseTo(0.0432, 12);
    expect(rktPackedChuteSize({ type: 'innertube', outerRadius: 0.05, thickness: 0.06 }, 1)).toBe(0);
    expect(rktPackedChuteSize({ type: 'transition' }, 0.8)).toBeCloseTo(0.02, 12);
    expect(rktPackedChuteSize(null, 0.8)).toBeCloseTo(0.02, 12);
  });

  // A .rkt re-read packs every chute by that rule, so the save names only the
  // chutes whose packed size the rule will not give back.
  const loss = (tree: RocketTree) => checkFormatLoss('rkt', {
    tree, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null, flightData: {}, measured: { massKg: null, cgM: null },
  }).losses.find((l) => l.startsWith('Packed recovery'));
  it('a .rkt save names a chute whose packed size will not come back, and only that one', () => {
    const tree = importRkt(rkt('')).tree;
    expect(loss(tree)).toBeUndefined();
    const main = flatten(tree.components).find((n) => n.name === 'Main')!;
    main['packedLength'] = 0.254;
    expect(loss(tree)).toContain('“Main”');
    // A chute left on the kernel's default no longer reopens on it either.
    delete main['packedLength']; delete main['packedRadius'];
    expect(loss(tree)).toContain('“Main”');
  });
});
