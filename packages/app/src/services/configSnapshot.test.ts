import { expect, it } from 'vitest';
import { snapshotLoadedConfig } from './configSnapshot.js';

it.each(['__proto__', 'constructor', 'toString'])('serializes configuration families for id %s', id => {
  const config = snapshotLoadedConfig({ components: [{ type: 'stage', id, nozzleExitDiameter: 0.01,
    children: [{ type: 'parachute', id, deployEvent: 'apogee', deployDelay: 2 }] }] }, {});
  for (const family of ['deployments', 'separations', 'nozzles'] as const) {
    expect(Object.hasOwn(config[family], id)).toBe(true);
    expect(Object.hasOwn(JSON.parse(JSON.stringify(config[family])), id)).toBe(true);
  }
});
