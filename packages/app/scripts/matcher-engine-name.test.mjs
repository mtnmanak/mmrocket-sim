import { expect, it } from 'vitest';
import { matcherEngineName } from './matcher-engine-name.mjs';

it('preserves internal whitespace and parses the trailing manufacturer', () => {
  expect(matcherEngineName('G80(test)  AT')).toEqual(['G80(test)', 'AT']);
  expect(matcherEngineName('A  B  (AT)')).toEqual(['A  B', 'AT']);
  expect(matcherEngineName('A\nB-P  (AeroTech)')).toEqual(['A\nB-P', 'AeroTech']);
  expect(matcherEngineName('G80  AT')).toEqual(['G80', 'AT']);
  expect(matcherEngineName('G80  Aero Tech')).toEqual(['G80', 'Aero Tech']);
  expect(matcherEngineName('G80  (Aero  Tech)')).toEqual(['G80', 'Aero  Tech']);
  expect(matcherEngineName('A' + ' '.repeat(25600) + 'B C')).toEqual(['A', 'B C']);
  expect(matcherEngineName('K550  (AT)  x')).toBeNull();
  // An unparenthesized maker splits as v0.197 and desktop OR do (integration review, 2026-11-09).
  expect(matcherEngineName('G80 (T)  AT')).toEqual(['G80 (T)', 'AT']);
  expect(matcherEngineName('X (y)  Estes')).toEqual(['X (y)', 'Estes']);
  expect(matcherEngineName('G80  Aero  Tech')).toBeNull();
  expect(matcherEngineName('NoThrust')).toBeNull();
});
