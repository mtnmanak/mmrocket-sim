// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import presetsJson from '../data/presets.json';
import { loadBundledPresets, loadPresets, type Preset } from './presets.js';

/**
 * THE SHIPPED PARTS CATALOGUE, AND NOTHING ELSE (2026-10-01). Open… links a
 * part a file names to its catalogue row, so a preset changes what an opened
 * design weighs. `loadPresets` adds this browser's custom presets to the
 * shipped ones; a headless open (simulateFile) reads `loadBundledPresets`, so
 * its answer does not depend on which browser ran it.
 */
const CUSTOM_KEY = 'online-openrocket.custom-presets.v1';
const mine = { manufacturer: 'Mine', partNo: 'MY-1', type: 'BodyTube' } as unknown as Preset;

afterEach(() => { localStorage.clear(); });

describe('loadBundledPresets', () => {
  it('is the shipped database, whatever this browser has added', async () => {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify([mine]));
    const shipped = (presetsJson as { presets: Preset[] }).presets;
    const bundled = await loadBundledPresets();
    expect(bundled).toHaveLength(shipped.length);
    expect(bundled).not.toContainEqual(mine);
    // The app's path still adds them, after the shipped rows.
    const all = await loadPresets();
    expect(all).toHaveLength(shipped.length + 1);
    expect(all.at(-1)).toEqual(mine);
    expect(all.slice(0, shipped.length)).toEqual([...bundled]);
  });
});
