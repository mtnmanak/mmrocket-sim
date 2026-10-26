// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { FlightTree } from '../model/design.js';
import { exportOrk, importOrk } from './orkFile.js';
import { orkMotorSet } from './orkExportMotors.js';
import { decodeXml } from './xmlUtil.js';
import { currentXmlParser, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

const xml = (parts: string, sims = '') => `<openrocket version="1.10"><rocket><name>Audit</name>
  <subcomponents><stage><name>Sustainer</name><subcomponents>${parts}</subcomponents></stage></subcomponents>
  </rocket>${sims}</openrocket>`;
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);

describe('audit import/export regressions', () => {
  it('F5 density accepts legal zero without an invalid-number caution', () => {
    const r = importOrk(xml(`<nosecone><name>Nose cone</name><thickness>filled</thickness>
      <material type="bulk" density="0.0" group="Custom">Custom</material></nosecone>
      <bodytube><subcomponents><parachute><name>Chute</name>
      <material type="surface" density="0.0">Fabric</material>
      <linematerial type="line" density="0.0">Cord</linematerial></parachute></subcomponents></bodytube>`));
    const nodes = all(r.tree.components);
    expect(r.notes.join('\n')).not.toMatch(/invalid.*density/);
    // Bulk zero still uses the existing default material; soft zero is supported.
    expect(nodes.find(n => n.name === 'Nose cone')!['density']).toBeUndefined();
    expect(nodes.find(n => n.name === 'Chute')!['surfaceDensity']).toBe(0);
    expect(nodes.find(n => n.name === 'Chute')!['lineDensity']).toBe(0);
  });

  it('F5 density cautions on negative bulk, surface and line densities', () => {
    const r = importOrk(xml(`<bodytube><name>Tube</name><material type="bulk" density="-1">Named</material>
      <subcomponents><parachute><name>Chute</name><material type="surface" density="-1">Fabric</material>
      <linematerial type="line" density="-1">Cord</linematerial></parachute></subcomponents></bodytube>`));
    expect(r.notes.join('\n')).toMatch(/Tube.*invalid.*density/);
    expect(r.notes.join('\n')).toMatch(/Chute.*invalid.*material.*density/);
    expect(r.notes.join('\n')).toMatch(/Chute.*invalid.*linematerial.*density/);
    expect(all(r.tree.components).find(n => n.name === 'Tube')!['density']).toBeUndefined();
  });

  it('S1a-b1 packs inside a neighbour-resolved tube with an empty radius element', () => {
    const r = importOrk(xml(`<nosecone><aftradius>0.05</aftradius></nosecone>
      <bodytube><name>Tube</name><radius/><subcomponents><parachute><name>Chute</name>
      <packedradius>auto</packedradius></parachute></subcomponents></bodytube>`));
    const nodes = all(r.tree.components);
    expect(nodes.find(n => n.name === 'Tube')!['outerRadius']).toBeCloseTo(0.05, 12);
    expect(nodes.find(n => n.name === 'Chute')!['packedRadius']).toBeCloseTo(0.048, 12);
    const again = importOrk(exportOrk({ name: r.name, tree: r.tree }));
    expect(all(again.tree.components).find(n => n.name === 'Chute')!['packedRadius']).toBeCloseTo(0.048, 12);
  });

  it('S1a-3 cautions when a malformed density or offset falls back', () => {
    const r = importOrk(xml(`<bodytube><name>Tube</name><radius>0.05</radius>
      <material type="bulk" density="0.002junk">Named</material><subcomponents>
      <parachute><name>Chute</name><axialoffset method="top">0.1junk</axialoffset>
      <material type="surface" density="0.002junk">Fabric</material>
      <linematerial type="line" density="0.002junk">Cord</linematerial></parachute>
      </subcomponents></bodytube>`));
    const nodes = all(r.tree.components);
    expect(nodes.find(n => n.name === 'Tube')!.density).toBeUndefined();
    expect(nodes.find(n => n.name === 'Chute')!.position).toEqual({ method: 'top', offset: 0 });
    expect(r.notes.join('\n')).toMatch(/Tube.*invalid.*density/);
    expect(r.notes.join('\n')).toMatch(/Chute.*invalid.*axialoffset/);
    expect(r.notes.join('\n')).toMatch(/Chute.*invalid.*material.*density/);
    expect(r.notes.join('\n')).toMatch(/Chute.*invalid.*linematerial.*density/);
  });

  it.each([['', '', 0.048], ['<tubecoupler><outerradius>auto</outerradius><subcomponents>',
    '</subcomponents></tubecoupler>', 0.0475],
  ['<tubecoupler><outerradius>auto</outerradius><subcomponents><tubecoupler><outerradius>auto</outerradius><subcomponents>',
    '</subcomponents></tubecoupler></subcomponents></tubecoupler>', 0.047],
  ])('S1a-b1 packs inside default walls (%s)', (open, close, bore) => {
    const r = importOrk(xml(`<bodytube><radius>0.05</radius><subcomponents>${open}
      <parachute><name>Chute</name><packedradius>auto</packedradius></parachute>${close}</subcomponents></bodytube>`));
    const chute = all(r.tree.components).find(n => n.name === 'Chute')!;
    expect(chute['packedRadius']).toBeCloseTo(bore, 12);
    const again = importOrk(exportOrk({ name: r.name, tree: r.tree }));
    expect(all(again.tree.components).find(n => n.name === 'Chute')!['packedRadius']).toBeCloseTo(bore, 12);
  });

  it('S1a-b2 reads encoding through a long XML declaration', () => {
    const text = `<?xml version="1.0" ${' '.repeat(260)}encoding="windows-1252"?><name>Cr\xe9ateur</name>`;
    const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
    expect(decodeXml(bytes)).toEqual({ xml: text });
  });

  it.each(['constructor', '__proto__'])('S1a-g4 round trips a mount named %s', id => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', children: [
      { type: 'bodytube', id, motorMount: true, length: 0.3, outerRadius: 0.05 },
    ] }] };
    const empty = exportOrk({ name: 'Empty', tree, motors: {} });
    expect(Object.keys(importOrk(empty).motors)).toHaveLength(0);
    const motors = orkMotorSet({ tree, records: {}, refs: Object.fromEntries([[id,
      { designation: 'AuditMotor', manufacturer: 'Home', diameter: 0.029, length: 0.1, delay: 5 }]]),
    configKey: '', first: 'refs', exLibrary: () => [] });
    expect(Object.hasOwn(motors, id)).toBe(true);
    const again = importOrk(exportOrk({ name: 'Loaded', tree, motors }));
    expect(Object.values(again.motors).map(m => m.designation)).toEqual(['AuditMotor']);
  });

  it.each(['constructor', '__proto__'])('S1a-g4 ignores inherited configuration entries for %s', id => {
    const tree: FlightTree = { components: [{ type: 'stage', id: 'sustainer' }, { type: 'stage', id, children: [
      { type: 'bodytube', id: 'mount', motorMount: true, length: 0.3, outerRadius: 0.05 },
    ] }], ignitionDefaults: Object.create({ mount: { event: 'never', delay: 9 } }) };
    const config = { id: 'cfg', name: null, isDefault: true, motors: {}, ignitions: {}, separations: {} };
    const stageXml = exportOrk({ name: 'Stage', tree, configs: [config] });
    expect(stageXml).not.toContain('<separationconfiguration');
    expect(stageXml).not.toContain('<ignitionevent>never</ignitionevent>');
    const mountTree: RocketTree = { components: [{ type: 'stage', id: 'stage', children: [
      { type: 'bodytube' as const, id, motorMount: true, length: 0.3, outerRadius: 0.05 },
    ] }] };
    const mountXml = exportOrk({ name: 'Mount', tree: mountTree, configs: [config] });
    expect(mountXml).not.toContain('<ignitionconfiguration');
    expect(Object.keys(importOrk(mountXml).motors)).toHaveLength(0);
  });

  it.each([
    '<p:simulations xmlns:p="urn:x"><p:simulation><p:extension extensionid="x"/></p:simulation></p:simulations>',
    '<simulations><simulation><p:extension xmlns:p="urn:x" extensionid="x"/></simulation></simulations>',
    '<simulations><p:simulation xmlns:p="urn:x"/></simulations>',
  ])('S1a-g6 ignores namespace-prefixed simulation metadata', sims => {
    const previous = currentXmlParser();
    try {
      setXmlParser(jsXmlParser);
      expect(() => importOrk(xml('<bodytube/>', sims))).not.toThrow();
    } finally { setXmlParser(previous); }
  });
});
