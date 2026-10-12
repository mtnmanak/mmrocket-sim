// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { importRkt } from './rocksimFile.js';
import * as nodeNumbers from '../tree/nodeNum.js';

// Count the real node reads, including each grouping/de-collision comparison,
// rather than timing the machine (audit 2026-10-11, S1b-3).
describe('RockSim refuses large designs before quadratic passes', () => {
  it.each(['BodyTube', 'FinSet'])('bounds reads for 2,001 distinct %s children', tag => {
    const children = Array.from({ length: 2001 }, (_, i) => `<${tag}><Xb>${i * 100}</Xb>
      <OD>20</OD><ID>18</ID><Len>50</Len><RootChord>50</RootChord><TipChord>20</TipChord>
      <SemiSpan>20</SemiSpan><FinCount>3</FinCount><ShapeCode>0</ShapeCode></${tag}>`).join('');
    const xml = `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><OD>60</OD><ID>58</ID><Len>400</Len><AttachedParts>${children}
      </AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
    const original = nodeNumbers.num;
    let reads = 0;
    const spy = vi.spyOn(nodeNumbers, 'num').mockImplementation((...args) => {
      reads++;
      return original(...args);
    });
    try {
      expect(() => importRkt(xml)).toThrow(/2,003 parts, past the 2,000/);
      // Conversion can read dimensions, but millions of pairwise comparisons cannot pass.
      expect(reads).toBeLessThan(20 * 2001);
    } finally {
      spy.mockRestore();
    }
  });
});
