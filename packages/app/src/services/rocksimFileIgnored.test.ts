// @vitest-environment happy-dom
/**
 * A RockSim part the importer does not model is skipped AND named, never
 * dropped silently. Pinned before the importer's `case 'RingTail'` — a copy of
 * its `default` branch — was folded into that branch (audit 2026-09-22, Dead
 * code row 580), so the fold is shown to change nothing.
 */
import { describe, expect, it } from 'vitest';
import { importRkt } from './rocksimFile';

const design = (attached: string) => `<RockSimDocument><DesignInformation><RocketDesign>
  <Name>Ignored parts</Name><StageCount>1</StageCount>
  <Stage3Parts>
    <BodyTube><Name>Body</Name><OD>41.6</OD><ID>40.5</ID><Len>300</Len>
      <AttachedParts>${attached}</AttachedParts>
    </BodyTube>
  </Stage3Parts><Stage2Parts/><Stage1Parts/>
</RocketDesign></DesignInformation></RockSimDocument>`;

describe('RockSim parts the importer does not model', () => {
  it('skips a RingTail, lists it as ignored, and says so in the notes', () => {
    const r = importRkt(design('<RingTail><Name>Ring</Name><OD>60</OD><ID>41.6</ID><Len>20</Len></RingTail>'));
    expect(r.ignored).toEqual(['RingTail']);
    expect(r.notes).toContain('Ignored unsupported RockSim components: RingTail.');
    expect(r.tree.components[0]!.children![0]!.children ?? []).toEqual([]);
  });

  it('treats a tag it has never heard of the same way', () => {
    const r = importRkt(design('<RingTail><Name>Ring</Name></RingTail><Widget><Name>W</Name></Widget>'));
    expect(r.ignored).toEqual(['RingTail', 'Widget']);
    expect(r.notes).toContain('Ignored unsupported RockSim components: RingTail, Widget.');
  });
});
