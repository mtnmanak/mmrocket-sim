// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { engineTree } from '../tree/treeModel.js';

/**
 * A BAFFLE WITH A HOLE FLIES WITH ITS HOLE (KB5). US Rockets' "2.25 V2"
 * (RockSim library) carries a plywood baffle: a <Ring> with <UsageCode>1</>
 * and an <ID>, which the reader opens as a centering ring with that bore
 * (`holedBulkhead`). RockSim weighs it 4.40215 g, the annulus; this app flew it
 * 5.569 g, a solid disc. Its stated bore (25.4 mm) is the motor tube's outer
 * diameter, and that tube lay across the baffle's raw position while the
 * kernel built it, so the bore matched the automatic one, setInnerRadius
 * returned early, and the bore stayed automatic — at the baffle's real station
 * the tube only touches it, and the automatic bore is 0. The fields below are
 * the file's own, trimmed to what the importer reads.
 */
const RKT = `<RockSimDocument><DesignInformation><RocketDesign>
  <Name>US Rockets 2.25 V2</Name><StageCount>1</StageCount>
  <Stage3Parts>
    <BodyTube><Name>Body tube</Name><OD>57.531</OD><ID>55.499</ID><Len>228.6</Len>
      <Xb>0.</Xb><LocationMode>0</LocationMode>
      <AttachedParts>
        <BodyTube><Name>Enging Mount tube</Name><Density>1121.29</Density><Material>Paper</Material>
          <Xb>-127.</Xb><LocationMode>2</LocationMode><OD>25.4</OD><ID>24.13</ID><Len>203.2</Len>
          <IsMotorMount>1</IsMotorMount><MotorDia>24.</MotorDia><EngineOverhang>12.7</EngineOverhang>
          <IsInsideTube>1</IsInsideTube><AttachedParts></AttachedParts></BodyTube>
        <Ring><Name>Baffle Bulkhead</Name><Density>724.996</Density><Material>Aircraft plywood (LOC)</Material>
          <DensityType>0</DensityType><Xb>149.225</Xb><LocationMode>0</LocationMode>
          <OD>55.499</OD><ID>25.4</ID><Len>3.175</Len><UsageCode>1</UsageCode><AutoSize>1</AutoSize>
          <CalcMass>4.40215</CalcMass><AttachedParts></AttachedParts></Ring>
      </AttachedParts>
    </BodyTube>
  </Stage3Parts><Stage2Parts/><Stage1Parts/>
</RocketDesign></DesignInformation></RockSimDocument>`;

const flatten = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap((n) => [n, ...flatten(n.children ?? [])]);

describe('a RockSim baffle with a hole', () => {
  it('weighs what RockSim weighs it, the annulus, not the solid disc', () => {
    resetEngine();
    const tree = importRkt(RKT).tree;
    const baffle = flatten(tree.components).find((n) => n.name === 'Baffle Bulkhead')!;
    expect(baffle.type).toBe('centeringring');
    expect(baffle['innerRadius']).toBeCloseTo(0.0127, 12);
    const grams = OrkRocket.buildTree(engineTree(tree)).componentInfo(baffle.id!).mass * 1000;
    expect(grams).toBeCloseTo(4.40215, 3); // the file's own <CalcMass>
  });
});
