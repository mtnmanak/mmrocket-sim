import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { exportOrk } from './orkFile.js';
import { exportRkt } from './rocksimFile.js';

/**
 * RECOV-CASE in the file writers. The kernel lower-cases a recovery device's
 * deploy event (ComponentFactory.deployEventOf), so a hand-edited "Altitude"
 * flies as altitude; desktop OR matches the .ork text case-sensitively
 * (DocumentConfig.findEnum) and would drop it, and the .rkt writer refused it
 * as a deployment it "cannot faithfully save".
 */
const design = (events: { main: string; drogue?: string }): RocketTree => ({
  name: 'Case',
  components: [{
    type: 'stage', id: 's0', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n', length: 0.2, aftRadius: 0.03, thickness: 0.002, shape: 'ogive' },
      {
        type: 'bodytube', id: 'b', length: 0.6, outerRadius: 0.03, thickness: 0.001,
        children: [
          { type: 'parachute', id: 'main', name: 'Main', diameter: 0.6, deployEvent: events.main, deployAltitude: 150 },
          ...(events.drogue ? [{ type: 'parachute', id: 'drogue', name: 'Drogue', diameter: 0.3, deployEvent: events.drogue }] : []),
        ],
      },
    ],
  } as unknown as ComponentNode],
});

const deployEvents = (xml: string) => [...xml.matchAll(/<deployevent>([^<]*)<\/deployevent>/g)].map((m) => m[1]);

describe('RECOV-CASE .ork writer', () => {
  it('writes a mixed-case event in the spelling desktop OR reads', () => {
    const xml = exportOrk({ name: 'Case', tree: design({ main: 'Altitude', drogue: 'APOGEE' }) });
    expect(deployEvents(xml)).toEqual(['altitude', 'apogee']);
  });

  it('keeps a value the kernel does not name as the file wrote it', () => {
    // Desktop 24.12's sixth event; the app flies it as the ejection charge, but
    // writing "ejection" would lose it from a desktop file on save (schema.ts).
    const xml = exportOrk({ name: 'Case', tree: design({ main: 'lowerstageseparation' }) });
    expect(deployEvents(xml)).toEqual(['lowerstageseparation']);
  });

  it('folds the case in every configuration it replays, too', () => {
    const xml = exportOrk({
      name: 'Case', tree: design({ main: 'altitude' }), motors: {}, activeConfigId: 'a',
      configs: [
        { id: 'a', name: 'A', isDefault: true, motors: {} },
        { id: 'b', name: 'B', isDefault: false, motors: {},
          deployments: { main: { deployEvent: 'Apogee', deployAltitude: 200, deployDelay: 0 } } },
      ],
    });
    const blocks = [...xml.matchAll(/<deploymentconfiguration configid="(\w)">\s*<deployevent>([^<]*)</g)]
      .map((m) => [m[1], m[2]]);
    expect(blocks).toEqual([['b', 'apogee']]); // A inherits the bare altitude default.
    expect(deployEvents(xml)).toContain('altitude');
  });
});

describe('RECOV-CASE .rkt writer', () => {
  it('saves a mixed-case event as the event it flies rather than refusing it', () => {
    const xml = exportRkt({ name: 'Case', tree: design({ main: 'Altitude', drogue: 'APOGEE' }) });
    const types = [...xml.matchAll(/<SimulationEvent><PartSerialNo>\d+<\/PartSerialNo><Type>(\d)<\/Type><DeployAltitude>([^<]*)</g)]
      .map((m) => [m[1], m[2]]);
    // Type 5 is altitude, 4 apogee; each written once per event list.
    expect(types).toContainEqual(['5', '150']);
    expect(types).toContainEqual(['4', '0']);
  });

  it('still refuses an event it cannot express', () => {
    expect(() => exportRkt({ name: 'Case', tree: design({ main: 'lowerstageseparation' }) }))
      .toThrow(/cannot faithfully save lowerstageseparation deployment/);
  });
});
