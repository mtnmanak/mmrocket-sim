// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { ConfigPanel } from './ConfigPanel.js';
import { PropertyPanel } from './PropertyPanel.js';
import { recoveryScope, recoverySummary } from './recoveryContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const configs: SavedConfig[] = [
  { id: 'a', name: 'Same motors', isDefault: true, motors: {}, deployments: { chute: { deployEvent: 'ejection', deployDelay: 2 } } },
  { id: 'b', name: 'Same motors', isDefault: false, motors: {}, deployments: { chute: { deployEvent: 'altitude', deployAltitude: 121.92 } } },
];
const node = { id: 'chute', type: 'parachute', name: 'Main', diameter: 0.45, deployEvent: 'apogee', deployDelay: 0 } as ComponentNode;
const tree: RocketTree = { name: 'T', components: [{ id: 'stage', type: 'stage', children: [node] }] };

describe('recovery configuration context', () => {
  it('includes inherited devices in resolved recovery and counts all three override families', () => {
    const c: SavedConfig = { ...configs[0]!, separations: { stage: { separationEvent: 'burnout', separationDelay: 1, separationAltitude: 200 } },
      ignitions: { mount: { event: 'launch', delay: 1 } } };
    const inherited = { ...tree, components: [...tree.components, { ...node, id: 'other', name: 'Drogue' }] };
    expect(recoverySummary(c, 'm', inherited)).toContain('Drogue: apogee');
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      act(() => root.render(<ConfigPanel configs={[c, { id: 'none', name: 'Plain', isDefault: false, motors: {} }]}
        tree={inherited} activeConfigId="a" hasMotors={false} onApply={() => {}} onEmpty={() => {}} onClear={() => {}}
        onCreate={() => null} onRename={() => {}} onDelete={() => {}} />));
      expect(host.textContent).toContain('3 overrides: recovery, separation, ignition');
      const plain = host.querySelector<HTMLButtonElement>('[aria-label^="Apply Plain"]')!;
      expect(plain.getAttribute('aria-describedby')).toBeNull();
    } finally { act(() => root.unmount()); }
  });
  it('renders active context beside the unchanged controls and explains shared devices honestly', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      const render = (scope: string | null) => act(() => root.render(<PrefsProvider>
        <PropertyPanel tree={tree} node={node} recoveryContext={scope} onPatch={() => {}} />
      </PrefsProvider>));
      render(recoveryScope(configs, 'a', 'chute'));
      expect(host.textContent).toContain('Flight configuration “Same motors” uses a recovery override.');
      expect(host.querySelector('select[aria-label="Deploy at"]')).not.toBeNull();
      render(recoveryScope(configs, 'a', 'new-device'));
      expect(host.textContent).toContain('These fields edit the component default, used by every flight configuration without an override for this device.');
      render(recoveryScope(configs, null, 'chute'));
      expect(host.textContent).toContain('These fields edit the component default');
      render(recoveryScope([configs[0]!], 'a', 'chute'));
      expect(host.textContent).toContain('uses a recovery override');
    } finally { act(() => root.unmount()); }
  });

  it('distinguishes same-motor rows and Apply labels, resolves active overrides, and keeps Apply functional', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    let applied = '';
    try {
      act(() => root.render(<ConfigPanel configs={configs} tree={tree} activeConfigId="a" hasMotors={false}
        onApply={(c) => { applied = c.id; }} onEmpty={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}} onDelete={() => {}} />));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Apply "]')];
      expect(buttons[0]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 1; Recovery: Main: ejection charge + 2 s (override; component default is shown in the panel)');
      expect(buttons[1]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 2; Recovery: Main: 121.92 m AGL descending (override; component default is shown in the panel)');
      expect(host.textContent).toContain('Recovery: Main: ejection charge + 2 s');
      expect(host.querySelector(`[id="${buttons[0]!.getAttribute('aria-describedby')}"]`)?.textContent).toBe('1 override: recovery');
      expect(host.textContent).toContain('Recovery: Main: 121.92 m AGL descending');
      act(() => buttons[1]!.click()); expect(applied).toBe('b');
      act(() => root.render(<ConfigPanel configs={[configs[0]!]} tree={tree} activeConfigId="a" hasMotors={false}
        onApply={() => {}} onEmpty={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}} onDelete={() => {}} />));
      expect(host.textContent).toContain('Recovery: Main: ejection charge + 2 s');
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
        <ConfigPanel configs={configs} tree={tree} activeConfigId="a" hasMotors={false}
          onApply={() => {}} onEmpty={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}} onDelete={() => {}} />
      </PrefsProvider>));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Apply "]')];
      expect(buttons[1]!.getAttribute('aria-label'))
        .toBe('Apply Same motors — configuration 2; Recovery: Main: 400 ft AGL descending (override; component default is shown in the panel)');
      expect(host.textContent).toContain('Recovery: Main: 400 ft AGL descending');
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
    // The Deploy at menu shows the event flown, not its first option.
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      const show = (deployEvent: unknown) => act(() => root.render(<PrefsProvider>
        <PropertyPanel tree={tree} node={{ ...node, deployEvent } as ComponentNode} onPatch={() => {}} />
      </PrefsProvider>));
      const menu = () => host.querySelector<HTMLSelectElement>('select[aria-label="Deploy at"]')!.value;
      show('Altitude');
      expect(menu()).toBe('altitude');
      show('NEVER');
      expect(menu()).toBe('never');
      show(undefined);
      expect(menu()).toBe('ejection');
    } finally { act(() => root.unmount()); }
  });
});
