// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { explanationFor } from './noteExplanations.js';

const nodes = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap(n => [n, ...nodes(n.children ?? [])]);

it.each([0, 1, 2])('C-F4-5 sibling: warns when RockSim fin shape %s has an unknown section code', shape => {
  const xml = `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount><Stage3Parts>
    <BodyTube><OD>100</OD><ID>96</ID><Len>800</Len><AttachedParts>
    <FinSet><ShapeCode>${shape}</ShapeCode><TipShapeCode>17</TipShapeCode>
      <RootChord>100</RootChord><TipChord>50</TipChord><SemiSpan>60</SemiSpan><Thickness>3</Thickness>
      <PointList>0,0|100,0|80,60|30,60|</PointList>
    </FinSet></AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
  const r = importRkt(xml);
  const f = nodes(r.tree.components).find(n => n.type.endsWith('finset'))!;
  expect(f['crossSection'] ?? 'square').toBe('square');
  expect(r.noteTiers?.find(n => n.kind === 'I04.fin-section')?.text)
    .toContain('Unknown RockSim fin section code 17');
  expect(r.noteTiers?.find(n => n.kind === 'I04.fin-section')?.text).toContain('imported as Square');
  expect(explanationFor('I04.fin-section').meaning).toContain('section named in the note');
});
