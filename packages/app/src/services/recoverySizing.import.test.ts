// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { importOrk } from './orkFile.js';
import { classifyRecoveryDevices, recoverySizing } from './recoverySizing.js';

it.each([false, true])('S7b-3 withholds only unusable size lines for an imported zero Cd (other chute fitted: %s)', otherFitted => {
  const imported = importOrk(`<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>
    <bodytube><length>1</length><radius>0.15</radius><thickness>0.001</thickness><subcomponents>
    <parachute><name>Main</name><diameter>1</diameter><cd>0</cd><deployevent>altitude</deployevent></parachute>
    ${otherFitted ? '<parachute><name>Drogue</name><diameter>0.2</diameter><cd>0.8</cd><deployevent>apogee</deployevent></parachute>' : ''}
    </subcomponents></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`);
  const main = classifyRecoveryDevices(imported.tree).main!;
  expect(main['cd']).toBe(0);
  const before = structuredClone(imported.tree);
  const result = recoverySizing({ tree: imported.tree,
    recovery: { state: 'ok', mass: 8.786, multiStage: false }, deviceMass: () => null, presets: [],
    launch: { launchAltitudeM: 0, temperatureC: null, pressureHPa: null },
  });
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('expected per-band sizing');
  expect(result.main.diameter).toBeNull();
  expect(result.main.reason).toContain('the main canopy needs an effective Cd greater than zero');
  if (otherFitted) expect(result.drogue.diameter).toBeGreaterThan(0);
  else {
    expect(result.drogue.diameter).toBeNull();
    expect(result.drogue.cdSource).toBe('the design’s other chute');
    expect(result.drogue.reason).toContain('there is no drogue parachute in this design');
    expect(result.drogue.reason).toContain('the Cd it borrows from the main canopy is not greater than zero after its spill hole');
    expect(result.drogue.reason).toContain("check the main canopy's Cd and spill hole");
    expect(result.drogue.reason).not.toContain('the drogue canopy needs');
  }
  expect(imported.tree).toEqual(before);
});
