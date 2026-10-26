import { expect, it } from 'vitest';
import { exportIgnitions } from './foreignConfigLayers.js';

it('keeps export motor maps prototype-free without losing an own __proto__ motor', () => {
  const motors = Object.assign(Object.create(null) as Record<string, { ignitionEvent: string }>,
    { ['__proto__']: { ignitionEvent: 'launch' } });
  const result = exportIgnitions({ components: [] }, motors, {})!;
  expect(Object.getPrototypeOf(result)).toBeNull();
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(result['__proto__']).toEqual(motors['__proto__']);
});

it.each(['constructor', 'toString'])('ignores inherited ignition defaults for mount %s', id => {
  const motors = { [id]: { ignitionEvent: 'launch', ignitionDelay: 2 } };
  expect(exportIgnitions({ components: [], ignitionDefaults: {} }, motors, { ignitions: {} })).toEqual(motors);
});
