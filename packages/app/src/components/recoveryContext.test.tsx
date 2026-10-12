// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { FlightOverrides, SavedConfig } from '../model/design.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { ConfigOverview } from './ConfigOverview.js';
import { PropertyPanel } from './PropertyPanel.js';
import { recoverySummary } from './recoveryContext.js';
import { activeFlightOverrides } from '../services/flightState.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const configs: SavedConfig[] = [
  { id: 'a', name: 'Same motors', isDefault: true, motors: {}, deployments: { chute: { deployEvent: 'ejection', deployDelay: 2 } } },
  { id: 'b', name: 'Same motors', isDefault: false, motors: {}, deployments: { chute: { deployEvent: 'altitude', deployAltitude: 121.92 } } },
];
const node = { id: 'chute', type: 'parachute', name: 'Main', diameter: 0.45, deployEvent: 'apogee', deployDelay: 0 } as ComponentNode;
const tree: RocketTree = { name: 'T', components: [{ id: 'stage', type: 'stage', children: [node] }] };

describe('recovery configuration context', () => {
  it('includes inherited devices in the effective recovery table (all-family summary is covered by CFG-1)', () => {
    const c: SavedConfig = { ...configs[0]!, separations: { stage: { separationEvent: 'burnout', separationDelay: 1, separationAltitude: 200 } },
      ignitions: { mount: { event: 'launch', delay: 1 } } };
    const inherited = { ...tree, components: [...tree.components, { ...node, id: 'other', name: 'Drogue' }] };
    expect(recoverySummary(c, 'm', inherited)).toContain('Drogue: apogee');
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<ConfigOverview configs={[c, { id: 'none', name: 'Plain', isDefault: false, motors: {} }]}
        tree={inherited} activeConfigId="a" onApply={() => {}}
        onShowPart={() => {}} />));
      expect(host.textContent).toContain('Drogue');
      expect(host.textContent).toContain('Motor ejection charge, delay 2 s — override');
      const plain = host.querySelector<HTMLButtonElement>('[aria-label^="Apply Plain"]')!;
      expect(plain.getAttribute('aria-describedby')).toBeNull();
    } finally { act(() => root.unmount()); }
  });
  // CFG-3 port of "renders active context beside the unchanged controls": the
  // Design panel no longer edits deployment (ruling D2a); it shows the own
  // setting, the active owner's override, and a link to the one editor.
  it('CFG-3 shows deployment read-only on Design with the active override and a link to its row', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    const opened: string[] = [];
    try {
      const render = (configLabel: string | null, overrides: FlightOverrides, detached = false, withLink = true) =>
        act(() => root.render(<PrefsProvider>
          <PropertyPanel tree={tree} node={node} onPatch={() => {}}
            flight={{ overrides, configLabel, detached, onOpenPart: withLink ? (id) => opened.push(id) : undefined }} />
        </PrefsProvider>));
      const block = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Deployment"]')!;
      render('Same motors', activeFlightOverrides(configs, 'a', {}));
      expect(host.querySelector('select[aria-label="Deploy at"]')).toBeNull();
      expect(host.querySelector('[aria-label^="Deploy altitude"], [aria-label^="Deploy delay"]')).toBeNull();
      expect(block().textContent).toContain('Own setting: Apogee');
      expect(block().textContent).toContain('In “Same motors”: overridden — Motor ejection charge, delay 2 s');
      act(() => [...block().querySelectorAll('button')].find(b => b.textContent === 'Set on Motors & Configuration ▸')!.click());
      expect(opened).toEqual(['chute']);
      // A configuration that does not override this device: own setting only.
      render('Same motors', {});
      expect(block().textContent).toContain('Own setting: Apogee');
      expect(block().textContent).not.toContain('overridden');
      // Detached working settings name themselves.
      render(null, activeFlightOverrides(configs, 'b', {}), true);
      expect(block().textContent).toContain('In the working settings: overridden — Altitude (descending), 121.92 m');
      // No context (isolated panel): the own setting, no link.
      render(null, {}, false, false);
      expect(block().querySelector('button')).toBeNull();
    } finally { act(() => root.unmount()); }
  });

  it('distinguishes same-motor rows and Apply labels, resolves active overrides, and keeps Apply functional', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    let applied = '';
    try {
      act(() => root.render(<ConfigOverview configs={configs} tree={tree} activeConfigId="a"
        onApply={(c) => { applied = c.id; }}  onShowPart={() => {}} />));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('tbody td button')];
      expect(buttons[0]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 1; Main: Motor ejection charge, delay 2 s — override');
      expect(buttons[1]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 2; Main: Altitude (descending), 121.92 m — override');
      expect(host.textContent).toContain('Motor ejection charge, delay 2 s');
      expect(buttons[0]!.textContent).toContain('override');
      expect(host.textContent).toContain('Altitude (descending), 121.92 m');
      act(() => buttons[1]!.click()); expect(applied).toBe('b');
      act(() => root.render(<ConfigOverview configs={[configs[0]!]} tree={tree} activeConfigId="a"
        onApply={() => {}}  onShowPart={() => {}} />));
      expect(host.textContent).toContain('Motor ejection charge, delay 2 s');
      expect(host.querySelector('button')!.getAttribute('aria-label')).toContain('Apply Same motors');
    } finally { act(() => root.unmount()); }
  });

  it('prints the deployment altitude in the distance unit the user chose (audit 2026-09-30)', () => {
    // An imperial user's 400 ft main read "Main: 121.92 m AGL descending": raw
    // SI with a hard-coded "m", in the row and in its Apply button's name.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'ft' } }));
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<PrefsProvider>
        <ConfigOverview configs={configs} tree={tree} activeConfigId="a"
          onApply={() => {}}  onShowPart={() => {}} />
      </PrefsProvider>));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('tbody td button')];
      expect(buttons[1]!.getAttribute('aria-label'))
        .toBe('Apply Same motors — configuration 2; Main: Altitude (descending), 400 ft — override');
      expect(host.textContent).toContain('Altitude (descending), 400 ft');
      expect(host.textContent).not.toContain(' m AGL');
    } finally { act(() => root.unmount()); localStorage.clear(); }
  });

  it('RECOV-CASE reads a mixed-case event the way the kernel flies it', () => {
    // The kernel lower-cases the event, so "Altitude" flies at its altitude and
    // "EJECTION" on the charge; the summary quoted the first as a bare word.
    const mixed: SavedConfig = { id: 'm', name: 'M', isDefault: true, motors: {},
      deployments: { chute: { deployEvent: 'Altitude', deployAltitude: 121.92 } } };
    expect(recoverySummary(mixed, 'm', tree)).toBe('Main: 121.92 m AGL descending (override; component default is shown in the panel)');
    expect(recoverySummary({ ...mixed, deployments: { chute: { deployEvent: 'EJECTION' } } }, 'm', tree))
      .toBe('Main: ejection charge (override; component default is shown in the panel)');
    // Design's read-only Own setting names the event flown (CFG-3 port of the
    // Deploy at menu check; the editor's menu is pinned in ConfigPartEditors.test).
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      const show = (deployEvent: unknown) => act(() => root.render(<PrefsProvider>
        <PropertyPanel tree={tree} node={{ ...node, deployEvent } as ComponentNode} onPatch={() => {}} />
      </PrefsProvider>));
      const own = () => host.querySelector('[role="group"][aria-label="Deployment"] p')!.textContent;
      show('Altitude');
      expect(own()).toMatch(/^Own setting: Altitude \(descending\)/);
      show('NEVER');
      expect(own()).toBe('Own setting: Never');
      show(undefined);
      expect(own()).toBe('Own setting: Motor ejection charge');
    } finally { act(() => root.unmount()); }
  });
});
