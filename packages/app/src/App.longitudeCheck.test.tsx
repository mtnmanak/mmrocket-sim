// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import { APP_VERSION } from './version.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same drawing stubs as App.save.test.tsx; the import and App state are real.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

let mounted: { root: Root; host: HTMLElement } | undefined;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'motors');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
    tree: { name: 'Before open', components: [] }, launch: DEFAULT_CONDITIONS,
    appVersion: APP_VERSION, savedAt: Date.now(),
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => { root.unmount(); });
    host.remove();
    mounted = undefined;
  }
  vi.unstubAllGlobals();
});

/** Synthetic LEM-IV sites, without motors requiring catalogue resolution. */
function siteFile(name: string, withSiblings: boolean): File {
  const sites = [[26.380273, 80.126879], ...(withSiblings ? Array.from({ length: 5 }, () => [28.1, -80.63]) : [])];
  const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>${name}</name>
    ${sites.map((_, i) => `<motorconfiguration configid="c${i}" default="${i === 0}"><name>Config ${i}</name></motorconfiguration>`).join('')}
    <subcomponents><stage><name>Sustainer</name><subcomponents><bodytube><name>Tube</name>
    <length>0.5</length><radius>0.03</radius><thickness>0.001</thickness></bodytube></subcomponents></stage></subcomponents>
    </rocket><simulations>${sites.map(([lat, lon], i) => `<simulation><name>${i === 0 ? 'K535' : `Sibling ${i}`}</name>
    <conditions><configid>c${i}</configid><launchlatitude>${lat}</launchlatitude>
    <launchlongitude>${lon}</launchlongitude></conditions></simulation>`).join('')}</simulations></openrocket>`;
  return new File([xml], `${name}.ork`);
}

async function openFile(host: HTMLElement, file: File, name: string): Promise<void> {
  // Use the same real header file-input path as App.save.test.tsx.
  const picker = host.querySelector<HTMLInputElement>('input[aria-label="Open a design file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
  const discard = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((b) => b.textContent === 'Open without saving');
  if (discard) await act(async () => { discard.click(); });
  const start = Date.now();
  while (host.querySelector('.vitals-item-name .vitals-value')?.textContent !== name) {
    if (Date.now() - start > 8000) throw new Error(`timed out opening ${name}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  }
}

it('shows the longitude row and import note on a LEM-IV-shaped open, then clears the row on the next file', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });

  await openFile(host, siteFile('LEM-IV sites', true), 'LEM-IV sites');
  const toggle = host.querySelector<HTMLButtonElement>('.notice-toggle[aria-expanded="false"]');
  if (toggle) await act(async () => { toggle.click(); });
  const notes = host.querySelector('[aria-label="Notices"]')?.textContent;
  expect(notes).toContain('longitude’s sign flipped');
  expect(notes).toContain('“K535” is at 26.380273, 80.126879 (east); 5 of its other simulations are at 28.1, -80.63 (west)');
  expect(notes).toContain('The file’s value was kept.');
  const row = () => [...host.querySelectorAll('.gust-estimate')]
    .find((el) => el.textContent?.includes('this file’s other simulations'));
  expect(row()?.textContent).toContain('Longitude 80.126879° E');
  expect(row()?.textContent).toContain('80.63° W');
  expect([...row()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use -80.126879', 'Keep east']);
  const longitude = () => host.querySelector<HTMLInputElement>('input[aria-label^="Longitude"]')!.value;
  expect(longitude()).toBe('80.127'); // The field rounds its display to three decimals.

  // Keep the longitude identical: stale evidence would still show a row.
  await openFile(host, siteFile('Same site alone', false), 'Same site alone');
  expect(longitude()).toBe('80.127');
  expect(row()).toBeUndefined();
  expect(host.querySelector('[aria-label="Notices"]')?.textContent ?? '').not.toContain('longitude’s sign flipped');
}, 30000);
