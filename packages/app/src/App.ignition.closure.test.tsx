// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import type { MountIgnitionField } from './components/MountIgnitionField.js';
import type { NozzleField } from './components/NozzleField.js';
import type { FlightTree, SavedConfig } from './model/design.js';
import { defaultTree, motorMounts } from './tree/treeModel.js';
import { testMotor } from './services/autoDelay.testSupport.js';
import { resolveFlightState } from './services/flightState.js';

let ignition: ComponentProps<typeof MountIgnitionField>;
let nozzle: ComponentProps<typeof NozzleField>;
vi.mock('./components/MountIgnitionField.js', async original => {
  const real = await original<typeof import('./components/MountIgnitionField.js')>();
  return { ...real, MountIgnitionField: (props: ComponentProps<typeof MountIgnitionField>) => {
    ignition = props;
    return createElement(real.MountIgnitionField, props);
  } };
});
vi.mock('./components/NozzleField.js', async original => {
  const real = await original<typeof import('./components/NozzleField.js')>();
  return { ...real, NozzleField: (props: ComponentProps<typeof NozzleField>) => {
    nozzle = props;
    return createElement(real.NozzleField, props);
  } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each(['constructor', 'toString', '__proto__'].flatMap(id => (['own', 'override'] as const).map(scope => [id, scope] as const)))(
  'preserves the other configuration ignition editing %s in %s scope', async (id, scope) => {
    localStorage.clear();
    const tree: FlightTree = { ...defaultTree(), ignitionDefaults: {} };
    motorMounts(tree)[0]!.id = id;
    tree.components[0]!.id = id === 'constructor' ? 'toString' : 'constructor';
    const motor = testMotor(false, 5);
    motor.ignition = { event: 'launch', delay: 0 };
    const otherMotor = { ...motor, ignition: { event: 'burnout' as const, delay: 2 } };
    const configs = [
      { id: 'a', name: 'A', motors: { [id]: motor }, ignitions: {} },
      { id: 'b', name: 'B', motors: { [id]: otherMotor }, ignitions: {} },
    ];
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
    localStorage.setItem('online-openrocket.workspace.v1', 'motors');
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, mountMotors: { [id]: motor },
      launch: DEFAULT_CONDITIONS, savedConfigs: configs, activeConfigId: 'a', detachedOverrides: { ignitions: {} },
      savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<PrefsProvider><App /></PrefsProvider>));
    const tab = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
      .find(b => b.textContent?.includes('Motors & Configuration'))!;
    await act(async () => tab.click());
    expect(nozzle.clearedFor).toBeNull();
    expect(ignition.mountId).toBe(id);
    const edited = { event: 'never' as const, delay: 1 };
    await act(async () => ignition.onEdit(scope, edited, false));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    const session = JSON.parse(localStorage.getItem('online-openrocket.session.v1')!) as {
      tree: FlightTree; savedConfigs: SavedConfig[];
    };
    const b = session.savedConfigs.find(c => c.id === 'b')!;
    expect(resolveFlightState(session.tree, session.savedConfigs, b.id, {}, b.motors).mountMotors[id]!.ignition).toEqual(otherMotor.ignition);
    expect(session.tree.ignitionDefaults![id]).toEqual(scope === 'own' ? edited : motor.ignition);
    expect(host.textContent).not.toContain('Cleared — the NaN');
  });
