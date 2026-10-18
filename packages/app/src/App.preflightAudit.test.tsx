// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { defaultTree, findNode, updateNode } from './tree/treeModel.js';
import { snapshotLoadedConfig } from './services/configSnapshot.js';
import { buildDesign } from './services/buildDesign.js';
import { readAuditMasses } from './services/preflightAudit.js';
import type { StabilityRange, StabilityRangeInput } from './services/configStabilityRange.js';
import { APP_VERSION } from './version.js';

vi.mock('./services/buildDesign.js', async original => {
  const real = await original<typeof import('./services/buildDesign.js')>();
  return { ...real, buildDesign: vi.fn(real.buildDesign) };
});
vi.mock('./services/preflightAudit.js', async original => {
  const real = await original<typeof import('./services/preflightAudit.js')>();
  return { ...real, readAuditMasses: vi.fn(real.readAuditMasses) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ctx2d = new Proxy({}, { get: (_t, prop) => prop === 'measureText' ? () => ({ width: 0 }) : () => undefined });
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const KEY = 'online-openrocket.session.v1';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(buildDesign).mockClear(); vi.mocked(readAuditMasses).mockClear();
});
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
const stored = () => {
  window.dispatchEvent(new Event('pagehide'));
  return JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
};

describe('Design preflight wiring', () => {
  it('keeps an existing recovery warning visible in Design notes and links to it once', async () => {
    const originalBuild = vi.mocked(buildDesign).getMockImplementation()!;
    vi.mocked(buildDesign).mockImplementation((...args) => {
      const result = originalBuild(...args);
      if (!('error' in result)) result.info.warningTexts.push('[Warning.NO_RECOVERY_DEVICE]');
      return result;
    });
    try {
      const tree = defaultTree();
      for (const body of tree.components[0]!.children!) {
        body.children = body.children?.filter(n => n.type !== 'parachute' && n.type !== 'streamer');
      }
      localStorage.setItem(KEY, JSON.stringify({ tree, mountMotors: {}, launch: DEFAULT_CONDITIONS,
        configLayers: 1, savedConfigs: [], appVersion: APP_VERSION, savedAt: Date.now() }));
      await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
      expect(host.querySelector('#design-notes .message-danger')?.textContent).toContain('Danger:');
      const audit = host.querySelector('.preflight-audit')!;
      expect(audit.querySelector('a')?.getAttribute('href')).toBe('#design-notes');
      expect(audit.querySelector('.message-danger')).toBeNull();
    } finally { vi.mocked(buildDesign).mockImplementation(originalBuild); }
  });

  it('keeps the stability range beside active-configuration audit advice; selection changes neither inputs nor diagnostics', async () => {
    // Exercise both sides of the v0.188 merge through App. The worker's canned
    // answer checks routing and rendering; service tests check numerical results.
    const workers: RangeWorker[] = [];
    class RangeWorker {
      onmessage?: (event: { data: { id: number; result: StabilityRange } }) => void;
      messages: { id: number; input?: StabilityRangeInput }[] = [];
      constructor() { workers.push(this); }
      postMessage(message: { id: number; input?: StabilityRangeInput }) { this.messages.push(message); }
      terminate() {}
    }
    vi.stubGlobal('Worker', RangeWorker);
    let tree = defaultTree();
    const chute = tree.components[0]!.children!.flatMap(n => n.children ?? []).find(n => n.type === 'parachute')!;
    tree = updateNode(tree, chute.id!, { deployEvent: 'apogee' });
    const config = snapshotLoadedConfig(tree, {});
    config.name = 'Electronics off';
    config.deployments[chute.id!]!.deployEvent = 'never';
    localStorage.setItem(KEY, JSON.stringify({ tree, mountMotors: {}, launch: DEFAULT_CONDITIONS,
      configLayers: 1, savedConfigs: [config], detachedOverrides: {}, activeConfigId: config.id,
      appVersion: APP_VERSION, savedAt: Date.now() }));
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    const panel = host.querySelector('.preflight-audit')!;
    expect(host.querySelector('.viz-root')?.getAttribute('data-contrast')).toBe('high');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('Deployment is Never');
    expect(panel.querySelector('.message-danger')?.textContent).toContain('Danger:');
    const rangePanel = host.querySelector('.config-stability-range')!;
    expect(rangePanel).not.toBeNull();
    const started = Date.now();
    while (!workers[0]?.messages.some(message => message.input)) {
      if (Date.now() - started > 2000) throw new Error('Stability range request did not arrive');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
    const worker = workers[0]!;
    const request = worker.messages.find(message => message.input)!;
    expect(Object.keys(request.input!.tree).sort()).toEqual(['components', 'ignitionDefaults']);
    expect(request.input!.tree.components).toEqual(tree.components);
    expect(request.input!.configs).toHaveLength(1);
    expect(request.input!.configs[0]!.id).toBe(config.id);
    expect(request.input!.configs[0]!.deployments?.[chute.id!]?.deployEvent).toBe('never');
    const minimum = { id: config.id, label: config.name, cal: 0.8, pct: 4 };
    const maximum = { id: 'empty', label: 'Empty rocket (no motor)', cal: 2, pct: 10 };
    await act(async () => worker.onmessage!({ data: { id: request.id, result: {
      cases: [minimum, maximum], min: minimum, max: maximum, complete: true, builds: 2,
    } } }));
    expect(rangePanel.textContent).toContain('Lowest margin: Electronics off');
    const rangeRequests = worker.messages.length;
    const before = stored();
    const builds = vi.mocked(buildDesign).mock.calls.length;
    const comparisons = vi.mocked(readAuditMasses).mock.calls.length;
    const select = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(chute.name!))!;
    await act(async () => select.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(host.querySelector('.config-stability-range')).toBe(rangePanel);
    expect(rangePanel.textContent).toContain('Lowest margin: Electronics off');
    expect(worker.messages).toHaveLength(rangeRequests);
    expect(host.querySelector('[role="treeitem"][aria-selected="true"] .tree-label')?.textContent).toBe(chute.name);
    expect(host.querySelector('.design-props')?.textContent).toContain('In “Electronics off”');
    expect(host.querySelector('.design-props')?.textContent).toContain('Never');
    expect(vi.mocked(buildDesign).mock.calls).toHaveLength(builds);
    expect(vi.mocked(readAuditMasses).mock.calls).toHaveLength(comparisons);
    const after = stored();
    for (const key of ['tree', 'mountMotors', 'launch', 'savedConfigs', 'activeConfigId', 'measured']) expect(after[key]).toEqual(before[key]);
    expect(findNode(tree, chute.id!)!['deployEvent']).toBe('apogee');
  });
});
