// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { ScaleDialog } from './components/ScaleDialog.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import { testMotor } from './services/autoDelay.testSupport.js';
import { defaultTree, motorMounts } from './tree/treeModel.js';
import { scaleRocket } from './tree/scaleRocket.js';

let scale: ComponentProps<typeof ScaleDialog>;
vi.mock('./components/ScaleDialog.js', async original => {
  const real = await original<typeof import('./components/ScaleDialog.js')>();
  return { ...real, ScaleDialog: (props: ComponentProps<typeof ScaleDialog>) => {
    scale = props;
    return createElement(real.ScaleDialog, props);
  } };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('checks inactive motors against the resized tree applied by Scale', async () => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!;
  Object.assign(mount, { outerRadius: 0.026, thickness: 0.001 });
  tree.components[0]!.children!.find(n => n.type === 'bodytube')!['outerRadius'] = 0.035;
  const active = testMotor(false, 5);
  const inactive = { ...active, spec: { ...active.spec, diameter: 0.038 } };
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
    tree, launch: DEFAULT_CONDITIONS, mountMotors: { [mount.id!]: active },
    savedConfigs: [
      { id: 'a', name: 'A', motors: { [mount.id!]: active } },
      { id: 'b', name: 'B', motors: { [mount.id!]: inactive } },
    ], activeConfigId: 'a', savedAt: 1, configLayers: 1, emptyConfigVersion: 1,
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<PrefsProvider><App /></PrefsProvider>));
  const open = host.querySelector<HTMLButtonElement>('button[title^="Scale the whole design"]')!;
  await act(async () => { open.click(); });
  const applied = scaleRocket(scale.tree, 0.8, { mountChoices: { [mount.id!]: { boreMm: 29 } } });
  await act(async () => { scale.onApply(applied); });
  expect(host.textContent).toMatch(/Configuration B:.*38 mm motor no longer fits the 29.0 mm bore/);
});
