// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import { ExampleDesignsDialog } from './ExampleDesignsDialog.js';
import { PropertyPanel } from './PropertyPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  [INITIAL_UNITS, '2000 mm (78.74 in)', '100 m (328.1 ft)', '50 m (164 ft)'],
  [IMPERIAL_UNITS, '78.74 in (2000 mm)', '328.1 ft (100 m)', '164 ft (50 m)'],
] as const)('R12 pairs example guide and deployment heights (%j)', (units, guide, main, booster) => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider><ExampleDesignsDialog onOpen={() => {}} onClose={() => {}} /></PrefsProvider>));
    expect(host.textContent).toContain(`vertical ${guide} launch guide`);
    expect(host.textContent).toContain(`main opens at ${main}`);
    expect(host.textContent).toContain(`booster parachute at ${booster}`);
  } finally { act(() => root.unmount()); host.remove(); localStorage.clear(); }
});

it.each([
  [INITIAL_UNITS, '0.067 kg/m² (0.0137 lb/ft²)', '0.01 kg/m (0.00672 lb/ft)'],
  [{ ...IMPERIAL_UNITS, density: 'lb/ft³' }, '0.0137 lb/ft² (0.067 kg/m²)', '0.00672 lb/ft (0.01 kg/m)'],
] as const)('R12 pairs canopy and line density hints (%j)', (units, canopy, line) => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const node = { type: 'parachute' as const, id: 'p', surfaceDensity: 0.067, lineDensity: 0.01 };
  try {
    act(() => root.render(<PrefsProvider><PropertyPanel tree={{ components: [{ type: 'stage', children: [node] }] }} node={node} onPatch={() => {}} /></PrefsProvider>));
    expect(host.textContent).toContain(`current density, ${canopy};`);
    expect(host.textContent).toContain(`current density, ${line};`);
  } finally { act(() => root.unmount()); host.remove(); localStorage.clear(); }
});
