// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigPanel } from './ConfigPanel.js';
import type { SavedConfig } from '../App.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The panel only reads labels — a cast partial motor is enough. */
const mm = (label: string) =>
  ({ label, spec: {}, meta: { label }, ignition: { event: 'automatic', delay: 0 } }
  ) as unknown as SavedConfig['motors'][string];

const CONFIGS: SavedConfig[] = [
  { id: 'cfg-a', name: 'Club field C6', isDefault: true, motors: { m1: mm('C6-5'), m2: mm('D12-0') } },
  { id: 'cfg-b', name: null, isDefault: false, motors: {} },
  // Nameless but carrying motors — the common case in a real .ork, where
  // desktop only writes <name> when the user renamed the configuration.
  { id: 'cfg-c', name: null, isDefault: false, motors: { m1: mm('J1026-CT') } },
  // Nameless, and its only motor could not be matched to our database.
  { id: 'cfg-d', name: null, isDefault: false, motors: {}, unmatched: ['K550W'] },
];

describe('ConfigPanel', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function mount(over: Partial<Parameters<typeof ConfigPanel>[0]> = {}) {
    const applied: string[] = [];
    const cleared: number[] = [];
    act(() => root.render(
      <ConfigPanel
        configs={CONFIGS}
        activeConfigId="cfg-a"
        hasMotors
        onApply={(c) => applied.push(c.id)}
        onClear={() => cleared.push(1)}
        {...over}
      />,
    ));
    return { applied, cleared };
  }

  it('lists every config plus the None row: names, summaries, default marker, active state', () => {
    mount();
    const names = Array.from(host.querySelectorAll('.config-name')).map((el) => el.textContent);
    // A nameless configuration reads as its MOTOR SET, never as a raw GUID —
    // the picker used to show `33a7c4f9-1acd-…` as a user's first screen after
    // opening a file (one beta-thread design carries ten of them).
    expect(names).toEqual(['Club field C6', 'No motors', '[J1026-CT]', '[K550W]', 'None']);
    const summaries = Array.from(host.querySelectorAll('.config-motors')).map((el) => el.textContent);
    expect(summaries).toEqual(['C6-5, D12-0', 'no motors', 'J1026-CT', 'no motors', 'no motors loaded']);
    // The file's default is marked once, on cfg-a's row.
    const rows = Array.from(host.querySelectorAll('.config-row'));
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.config-default')).toBeTruthy();
    expect(rows[1]!.querySelector('.config-default')).toBeFalsy();
    // Active state rides the activeConfigId row only.
    expect(rows[0]!.querySelector('.config-active-tag')).toBeTruthy();
    expect(rows[1]!.querySelector('.config-active-tag')).toBeFalsy();
    expect(rows[2]!.querySelector('.config-active-tag')).toBeFalsy();
  });

  it('Apply fires onApply with that config; the None row fires onClear', () => {
    const { applied, cleared } = mount();
    const rows = Array.from(host.querySelectorAll('.config-row'));
    act(() => { (rows[1]!.querySelector('button') as HTMLButtonElement).click(); });
    expect(applied).toEqual(['cfg-b']);
    // The None row is always LAST, after every configuration.
    act(() => { (rows.at(-1)!.querySelector('button') as HTMLButtonElement).click(); });
    expect(cleared).toHaveLength(1);
  });

  it('the None row shows active only when nothing is loaded AND no config is active', () => {
    mount({ activeConfigId: null, hasMotors: false });
    const rows = Array.from(host.querySelectorAll('.config-row'));
    expect(rows.at(-1)!.querySelector('.config-active-tag')).toBeTruthy();
    // Custom set (active null but motors loaded): nothing claims active.
    mount({ activeConfigId: null, hasMotors: true });
    expect(host.querySelector('.config-active-tag')).toBeFalsy();
  });

  it('renders nothing at all when the design carries no configurations', () => {
    mount({ configs: [] });
    expect(host.querySelector('.config-panel')).toBeFalsy();
    expect(host.textContent).toBe('');
  });
});
