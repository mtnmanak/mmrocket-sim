// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { inlineXmlCdata } from '../src/services/xmlUtil.ts';
import { simulationNumbers } from './matcher-inventory.mjs';

it('preserves comments containing CDATA openers while inlining real text', () => {
  const xml = '<r><!-- example <![CDATA[ --><Name><![CDATA[Fabric & thread]]></Name></r>';
  const doc = new DOMParser().parseFromString(inlineXmlCdata(xml), 'text/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelector('Name').textContent).toBe('Fabric & thread');
});

it('numbers motor elements by their owning simulation in one traversal', () => {
  const xml = '<r><EngineSet/>' + '<SimulationResults><x><EngineSet/></x></SimulationResults>'.repeat(3000) + '</r>';
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const numbers = simulationNumbers(doc, 'SimulationResults');
  const motors = [...doc.querySelectorAll('EngineSet')];
  expect(numbers.get(motors[0])).toBeUndefined();
  expect(motors.slice(1).map(el => numbers.get(el))).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1));
});

it('indexes RASAero owners through deep unknown subtrees and nested simulations', () => {
  const doc = new DOMParser().parseFromString('<r><SustainerEngine>orphan</SustainerEngine>'
    + '<Simulation><IncludeBooster1>true</IncludeBooster1>' + '<unknown>'.repeat(60)
    + '<Booster1Engine>E20</Booster1Engine>'.repeat(80) + '</unknown>'.repeat(60)
    + '<Simulation><SustainerEngine>F20</SustainerEngine></Simulation></Simulation></r>', 'text/xml');
  const owners = new WeakMap();
  const numbers = simulationNumbers(doc, 'Simulation', owners);
  const sims = [...doc.querySelectorAll('Simulation')];
  const engines = [...doc.querySelectorAll('SustainerEngine, Booster1Engine')];
  expect(owners.get(engines[0])).toBeUndefined();
  for (const engine of engines.slice(1, -1)) {
    expect(owners.get(engine)).toBe(sims[0]);
    expect(numbers.get(engine)).toBe(1);
  }
  expect(owners.get(engines.at(-1))).toBe(sims[1]);
  expect(numbers.get(engines.at(-1))).toBe(2);
});
