import { expect, it } from 'vitest';
import { exportIgnitions } from './foreignConfigLayers.js';

it.each(['constructor', 'toString'])('ignores inherited ignition defaults for mount %s', id => {
  const motors = { [id]: { ignitionEvent: 'launch', ignitionDelay: 2 } };
  expect(exportIgnitions({ components: [], ignitionDefaults: {} }, motors, { ignitions: {} })).toEqual(motors);
});
