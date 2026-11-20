import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { meshExportNotes, shroudWidthNotice } from './meshExportNotes.js';
import { IMPERIAL_UNITS } from '../prefs/units.js';

it('S4a-b2 discloses the capped width, including shrouds on pods', () => {
  const shroud: ComponentNode = { type: 'fairing', name: 'Camera\n[bad]', width: 0.025 };
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', outerRadius: 0.03,
    children: [{ type: 'podset', children: [{ type: 'bodytube', outerRadius: 0.012, children: [shroud] }] }] }] }] };
  const notes = meshExportNotes(tree);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/23.52 mm.*25 mm/);
  expect(notes[0]).toMatch(/Aerodynamics still use the specified width/);
  expect(notes[0]).not.toContain('\n');
  expect(shroudWidthNotice(shroud, 0.012, IMPERIAL_UNITS)).toMatch(/in/);
  expect(shroudWidthNotice({ ...shroud, conformal: false }, 0.012)).toBeNull();
  expect(shroudWidthNotice({ ...shroud, width: 1, conformal: false }, 0.012)).toMatch(/48 mm/);
  const limit = 2 * 0.012 * 0.98;
  expect(shroudWidthNotice({ ...shroud, width: limit }, 0.012)).toBeNull();
  expect(shroudWidthNotice({ ...shroud, width: limit + 1e-10 }, 0.012)).toMatch(/just/);
});
