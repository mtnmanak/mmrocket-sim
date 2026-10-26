import { expect, it } from 'vitest';
import * as section from '../tree/finSection.js';
import * as surface from '../tree/finSurface.js';
import * as drag from './dragTable.js';
import * as catalogue from './catalogueOverlay.js';

it('does not expose the unused printable profile wrapper', () => {
  expect(section).not.toHaveProperty('printableProfile');
});
it('keeps fin mesh implementation details private', () => {
  for (const name of ['FIN_SURFACE_RESOLUTION', 'meshVolume', 'onSeatedRoot']) expect(surface).not.toHaveProperty(name);
});
it('keeps table and catalogue implementation details private', () => {
  expect(drag).not.toHaveProperty('cpAoaColumn');
  expect(catalogue).not.toHaveProperty('CATALOGUE_FIELDS');
});
