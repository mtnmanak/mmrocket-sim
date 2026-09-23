// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './components/LaunchPanel.js';
import { exportOrk } from './services/orkFile.js';
import { saveFile } from './services/saveFile.js';
import type { SessionState } from './services/session.js';
import { encodeShareFragment } from './services/shareLink.js';
import { APP_VERSION } from './version.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas (the same stub App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

vi.mock('./services/saveFile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/saveFile.js')>()),
  saveFile: vi.fn(async () => ({ kind: 'downloaded', name: 'Aimed.CDX1' })),
}));

/**
 * ROD AIM across a .CDX1 save (weather build, step 2). RASAero's <LaunchSite>
 * has a rod angle and no direction, so an aim off the wind cannot travel — and
 * the saved line says so, in the whole App, where a user reads it. Only then:
 * an aim of 0, or a vertical rod, loses nothing and adds nothing.
 */

const SESSION_KEY = 'online-openrocket.session.v1';
/** A design RASAero can hold: a nose, a tube and three trapezoid fins. */
const TREE = {
  name: 'Aimed',
  components: [{
    type: 'stage', name: 'Sustainer',
    children: [
      { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
      {
        type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
        children: [{ type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 }],
      },
    ],
  }],
};

let mounted: { root: Root; host: HTMLElement }[] = [];
const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}

async function saveCdx1With(launch: LaunchConditions): Promise<HTMLElement> {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    tree: TREE, launch, appVersion: APP_VERSION, savedAt: Date.now(),
  }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  await waitFor(() => button('Save As / Export') !== undefined, 'the Save As menu');
  await act(async () => { button('Save As / Export')!.click(); });
  await act(async () => { button('Save .CDX1')!.click(); });
  await waitFor(() => vi.mocked(saveFile).mock.calls.length > 0, 'the .CDX1 save');
  await waitFor(() => (host.textContent ?? '').includes('Saved “Aimed.CDX1”'), 'the saved line');
  return host;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.mocked(saveFile).mockClear();
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('a .CDX1 save and the Rod aim', () => {
  it('says the aim was not saved when the tilted rod leans off the wind', async () => {
    const host = await saveCdx1With({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 90 });
    // The collapsed message strip shortens a long line; open it to read it all.
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '⌃');
    if (open) await act(async () => { open.click(); });
    expect(host.textContent).toContain(
      "RASAero has no rod direction, so this file's launch rail points straight into the wind; Rod aim (90°) was not saved.");
  }, 30000);

  it('says nothing more when nothing is lost', async () => {
    const host = await saveCdx1With({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 0 });
    expect(host.textContent).not.toContain('RASAero has no rod direction');
  }, 30000);
});

/**
 * A share link IS the .ork round trip (encodeShareFragment wraps exportOrk's
 * XML), opened through App's own import path — the launch merge included.
 */
describe('a share link and the Rod aim', () => {
  const stored = (): SessionState => JSON.parse(localStorage.getItem(SESSION_KEY)!) as SessionState;
  async function openLink(launch: LaunchConditions, previous: LaunchConditions): Promise<LaunchConditions> {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree: TREE, launch: previous, appVersion: APP_VERSION, savedAt: Date.now(),
    }));
    const xml = exportOrk({ name: 'Linked', tree: { ...TREE, name: 'Linked' } as never, launch });
    window.location.hash = (await encodeShareFragment(xml)).replace(/^#/, '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
    const offer = () => [...host.querySelectorAll('button')].find((b) => /^Open “Linked”/.test(b.textContent ?? ''));
    await waitFor(() => offer() !== undefined, 'the open-from-link offer');
    await act(async () => { offer()!.click(); });
    await waitFor(() => { window.dispatchEvent(new Event('pagehide')); return stored().tree.name === 'Linked'; },
      'the linked design to be autosaved');
    return stored().launch;
  }

  it('carries an aim, and a link without one clears the aim of the design open before it', async () => {
    const aimed = await openLink({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 135 }, DEFAULT_CONDITIONS);
    expect(aimed.launchRodAimDeg).toBe(135);
    for (const { root, host } of mounted) {
      await act(async () => { root.unmount(); });
      host.remove();
    }
    mounted = [];
    const plain = await openLink({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5 },
      { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 90 });
    expect(plain.launchRodAimDeg).toBe(0);
  }, 60000);
});
