// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { countParts } from '../tree/sanitize.js';
import { engineTree } from '../tree/treeModel.js';
import { parseXml } from './xmlParse.js';

const here = dirname(fileURLToPath(import.meta.url));
const rkt = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount>
  <Stage3Parts>${parts}</Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const tube = (attached: string, extra = '') => `<BodyTube><Name>Host</Name><OD>40</OD><ID>38</ID><Len>300</Len>
  ${extra}<AttachedParts>${attached}</AttachedParts></BodyTube>`;
const fin = (tag: string, attached: string) => `<${tag}><Name>Wing</Name><RootChord>60</RootChord><TipChord>30</TipChord>
  <SemiSpan>40</SemiSpan><Thickness>3</Thickness><PointList>0,0|60,0|20,40|</PointList>
  <AttachedParts>${attached}</AttachedParts></${tag}>`;
const flatten = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap(n => [n, ...flatten(n.children ?? [])]);
const withoutIds = (key: string, value: unknown) => key === 'id' ? undefined : value;
const mass = (tree: Parameters<typeof engineTree>[0]) => {
  resetEngine();
  return OrkRocket.buildTree(engineTree(tree)).staticInfo().mass;
};

describe('RockSim discloses losses without moving or retaining the lost parts', () => {
  it.each(['FinSet', 'CustomFinSet', 'TubeFinSet'])('names every %s attachment, including unsupported parts and descendants', tag => {
    const attached = '<ExternalPod><Name>Engine pod</Name><AttachedParts><BodyTube><Name>Pod tube</Name></BodyTube>'
      + '</AttachedParts></ExternalPod><Mystery><Name>Antenna</Name></Mystery>';
    const result = importRkt(rkt(tube(fin(tag, attached))));
    const baseline = importRkt(rkt(tube(fin(tag, ''))));
    expect(JSON.stringify(result.tree, withoutIds)).toBe(JSON.stringify(baseline.tree, withoutIds));
    // Both trees build the same retained geometry and material; kg, allowing only roundoff.
    expect(mass(result.tree)).toBeCloseTo(mass(baseline.tree), 12);
    const loss = result.noteTiers?.find(n => n.kind === 'I03.fin-attached');
    expect(loss?.tier).toBe('caution');
    for (const name of ['Wing', 'Engine pod', 'Pod tube', 'Antenna']) expect(loss?.text).toContain(name);
  }, 30_000);

  it('does not disclose attachments on a fin in an inactive stage', () => {
    const xml = rkt(tube(fin('FinSet', ''))).replace('</Stage3Parts>', '</Stage3Parts><Stage2Parts>'
      + tube(fin('FinSet', '<MassObject><Name>Inactive mass</Name></MassObject>')) + '</Stage2Parts>');
    expect(importRkt(xml).noteTiers?.some(n => n.kind === 'I03.fin-attached')).toBe(false);
  });

  it('discloses fins judged by the inner-tube rule before a hostless stage tube becomes a body tube', () => {
    const result = importRkt(rkt(tube(fin('FinSet', ''), '<IsInsideTube>1</IsInsideTube>')));
    const baseline = importRkt(rkt(tube('', '<IsInsideTube>1</IsInsideTube>')));
    expect(flatten(result.tree.components).map(n => n.type)).toEqual(['stage', 'bodytube']);
    expect(JSON.stringify(result.tree, withoutIds)).toBe(JSON.stringify(baseline.tree, withoutIds));
    expect(mass(result.tree)).toBeCloseTo(mass(baseline.tree), 12);
    expect(result.noteTiers?.find(n => n.kind === 'I03.left-out')).toMatchObject({ tier: 'caution' });
    expect(result.notes.join('\n')).toMatch(/Wing.*inner tube.*Host/);
  }, 30_000);

  // Pre-change measurements: exact imported nodes (IDs removed), mass in kg.
  for (const [name, parts, massKg, digest] of [
    ['Examples of Complex Rockets/Centuri_Jayhawk.rkt', 17, 0.34982745861690456,
      'b91faa1bd9647cd85e0184f8828897a081f07fb92331a9595991c786e025ad4f'],
    ['DynaStar/LexxJet.rkt', 26, 0.15933711814860874,
      'e53b2988715ec6be04ed33478eceeafd2d8145704a54f8cb13d72dc99f0aed87'],
    ['Semroc/USS-Andromeda.rkt', 16, 0.04578676407442068,
      '02237f64282b2ee40ae45faab3a609141d52483528b72764b6e78fd144e3852a'],
  ] as const) {
    // Local-only corpus, as in the other corpus-backed suites. Prefer docs when present.
    const path = [join(here, '../../../../docs/User files/Rocksim Designs', name),
      ...(process.env.ROCKSIM_DESIGNS ? [join(process.env.ROCKSIM_DESIGNS, name)] : []),
      join('G:/Documents/Dropbox/Rocksim Designs', name)].find(p => existsSync(p));
    it.skipIf(!path)(`${name}: same parts and built mass, every fin-attached loss named`, () => {
      const xml = readFileSync(path!, 'utf8');
      // happy-dom needs the same CDATA inlining as the RockSim importer.
      const doc = parseXml(xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content: string) =>
        content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')), 'corpus parse error');
      const losses = [...doc.querySelectorAll('FinSet > AttachedParts'), ...doc.querySelectorAll('CustomFinSet > AttachedParts')]
        .filter(w => w.children.length > 0);
      expect(losses.length).toBeGreaterThan(0);
      const result = importRkt(xml);
      expect(countParts(result.tree.components)).toBe(parts);
      expect(createHash('sha256').update(JSON.stringify(result.tree.components, withoutIds)).digest('hex')).toBe(digest);
      // Kernel arithmetic can vary by Node version: 1e-9 kg is far below the files' precision.
      expect(mass(result.tree)).toBeCloseTo(massKg, 9);
      const notes = result.noteTiers?.filter(n => n.kind === 'I03.fin-attached') ?? [];
      for (const wrap of losses) {
        const finName = wrap.parentElement!.querySelector(':scope > Name')!.textContent!.trim();
        // A nested fin's whole subtree is disclosed by its retained ancestor's note.
        const names = [...wrap.querySelectorAll('Name')].map(n => n.textContent!.trim());
        for (const part of names) expect(notes.some(n => n.text.includes(part))).toBe(true);
        if (!wrap.parentElement!.parentElement!.closest('FinSet') && !wrap.parentElement!.parentElement!.closest('CustomFinSet')) {
          expect(notes.some(n => n.tier === 'caution' && n.text.includes(finName))).toBe(true);
        }
      }
      console.log(`${name}: ${countParts(result.tree.components)} retained nodes, ${mass(result.tree)} kg`);
    }, 30_000);
  }
});
