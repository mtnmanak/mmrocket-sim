// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { ConfigPanel } from './ConfigPanel.js';
import { PropertyPanel } from './PropertyPanel.js';
import { recoveryScope } from './recoveryContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const configs: SavedConfig[] = [
  { id: 'a', name: 'Same motors', isDefault: true, motors: {}, deployments: { chute: { deployEvent: 'ejection', deployDelay: 2 } } },
  { id: 'b', name: 'Same motors', isDefault: false, motors: {}, deployments: { chute: { deployEvent: 'altitude', deployAltitude: 121.92 } } },
];
const node = { id: 'chute', type: 'parachute', name: 'Main', diameter: 0.45, deployEvent: 'apogee', deployDelay: 0 } as ComponentNode;
const tree: RocketTree = { name: 'T', components: [{ id: 'stage', type: 'stage', children: [node] }] };

describe('recovery configuration context', () => {
  it('renders active context beside the unchanged controls and explains shared devices honestly', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      const render = (scope: string | null) => act(() => root.render(<PrefsProvider>
        <PropertyPanel tree={tree} node={node} recoveryContext={scope} onPatch={() => {}} />
      </PrefsProvider>));
      render(recoveryScope(configs, 'a', 'chute'));
      expect(host.textContent).toContain('Recovery settings for Same motors. Flight configurations → Apply switches these settings with the motors.');
      expect(host.querySelector('select[aria-label="Deploy at"]')).not.toBeNull();
      render(recoveryScope(configs, 'a', 'new-device'));
      expect(host.textContent).toContain('This device has shared recovery settings across flight configurations.');
      render(recoveryScope(configs, null, 'chute'));
      expect(host.textContent).toContain('No flight configuration is active.');
      render(recoveryScope([configs[0]!], 'a', 'chute'));
      expect(host.textContent).not.toContain('Flight configurations');
    } finally { act(() => root.unmount()); }
  });

  it('distinguishes same-motor rows and Apply labels, uses live active edits, and keeps Apply functional', () => {
    const host = document.createElement('div'); const root = createRoot(host);
    let applied = '';
    try {
      act(() => root.render(<ConfigPanel configs={configs} tree={tree} activeConfigId="a" hasMotors={false}
        onApply={(c) => { applied = c.id; }} onClear={() => {}} />));
      const buttons = [...host.querySelectorAll('button')];
      expect(buttons[0]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 1; Recovery: Main: apogee');
      expect(buttons[1]!.getAttribute('aria-label')).toBe('Apply Same motors — configuration 2; Recovery: Main: 121.92 m AGL descending');
      expect(host.textContent).toContain('Recovery: Main: apogee');
      expect(host.textContent).toContain('Recovery: Main: 121.92 m AGL descending');
      act(() => buttons[1]!.click()); expect(applied).toBe('b');
      act(() => root.render(<ConfigPanel configs={[configs[0]!]} tree={tree} activeConfigId="a" hasMotors={false}
        onApply={() => {}} onClear={() => {}} />));
      expect(host.textContent).not.toContain('Recovery:');
      expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('Apply Same motors');
    } finally { act(() => root.unmount()); }
  });
});
