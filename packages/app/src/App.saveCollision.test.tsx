// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import * as files from './services/saveFile.js';
import * as recentDesigns from './services/recentDesigns.js';

vi.mock('./services/recentDesigns.js', () => ({
  rememberRecentDesign: vi.fn(async (): Promise<string | null> => null),
  listRecentDesigns: vi.fn(async (): Promise<recentDesigns.RecentDesign[]> => []),
  recentDesignFile: vi.fn(), clearRecentDesigns: vi.fn(async () => {}),
}));

/**
 * A FILE THE APP WRITES OVER THE ONE THE DESIGN WAS SAVED TO (audit, v0.194
 * closure check). Every writer reaches the REAL saveFile here: the Save-As
 * picker is stubbed with fake handles whose `isSameEntry` compares a path, as
 * saveFile.test.ts does, so a second pick of "Rocket.ork" is the same file to
 * saveFile and App alike. Nothing in saveFile, fileName or schematicExport is
 * mocked; App.save.test.tsx mocks saveFile module-wide and cannot see this.
 * Each case saves the design, overwrites that file from another writer and
 * reads the header and ✕ New's guard the way a user meets them.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and a Launch lands on the Results tab's charts.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) { cb(new Blob(['png'], { type: 'image/png' })); };
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_KEY = 'online-openrocket.session.v1';
const RUNS_KEY = 'online-openrocket.sim-runs.v1';
const fixture = (name: string) => readFileSync(join(here, 'services', '__fixtures__', name), 'utf8');

type PickerWin = Window & { showSaveFilePicker?: unknown };

/** Paths in this test's own folder, so no two cases share a picked file. */
let folder = 0;
/** The path the next Save-As dialog returns ('cancel' presses Cancel), and what each path was last written with. */
let nextPick: string = 'Rocket.ork';
let written: Map<string, BlobPart>;
/** close() of the next write to one of these paths waits for its release. */
let holds: Map<string, Promise<void>>;

function pickNext(name: string): void {
  nextPick = name === 'cancel' ? 'cancel' : `${folder}/${name}`;
  written.delete(nextPick);
}
function hold(name: string): () => void {
  let release!: () => void;
  holds.set(`${folder}/${name}`, new Promise(r => { release = r; }));
  return release;
}

let mounted: { root: Root; host: HTMLElement }[] = [];

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}

async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  return host;
}

async function unmountAll(): Promise<void> {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
}

const starterStored = () => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? Object.keys((JSON.parse(raw) as { mountMotors?: object }).mountMotors ?? {}).length > 0 : false;
};

function button(host: ParentNode, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

const status = (host: HTMLElement) => host.querySelector('[aria-label="Design save status"]')?.textContent;
const shownName = (host: HTMLElement) => host.querySelector('.vitals-item-name .vitals-value')?.textContent;

async function openTab(host: HTMLElement, name: 'Design' | 'Motors & Configuration' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/**
 * ✕ New asks "Start a new design?" only over work no file on disk has; the
 * question is cancelled. With nothing to lose ✕ New goes straight through.
 */
async function guarded(host: HTMLElement): Promise<boolean> {
  await openTab(host, 'Design');
  await act(async () => { button(host, '✕ New').click(); });
  if (!(host.textContent ?? '').includes('Start a new design?')) return false;
  const modal = [...document.querySelectorAll('.modal-actions')]
    .find((m) => m.textContent?.includes('Discard & start new'))!;
  await act(async () => { button(modal, 'Cancel').click(); });
  return true;
}

/** An entry of the header's Save As / Export menu, pressed, through any loss dialog. */
async function saveAs(host: HTMLElement, entry: string): Promise<void> {
  await act(async () => { button(host, 'Save As / Export').click(); });
  await act(async () => { button(host.querySelector('.file-menu')!, entry).click(); });
  const anyway = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes(' anyway'));
  if (anyway) await act(async () => { anyway.click(); });
}

/** Save .ork to `name` through the picker; the design then reads as saved. */
async function saveOrkTo(host: HTMLElement, name: string): Promise<void> {
  pickNext(name);
  const before = written.size;
  await saveAs(host, 'Save .ork');
  await waitFor(() => written.has(`${folder}/${name}`) && written.size >= before, `Save .ork to ${name}`);
  await waitFor(() => status(host) === 'No unsaved changes', 'the saved status');
}

async function pick(host: HTMLElement, file: File): Promise<void> {
  const picker = [...host.querySelectorAll('input')]
    .find((i) => i.getAttribute('aria-label')?.startsWith('Open a design file'))!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

/** Launch, and wait for the flight to land on the Results tab. */
async function fly(host: HTMLElement): Promise<void> {
  await act(async () => { button(host, 'Launch').click(); });
  await waitFor(() => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length === 1, 'the flight', 30000);
  await settle(50);
}

/** Wait until `path` has been written and the write's completion has reached React. */
async function writtenTo(name: string): Promise<BlobPart> {
  await waitFor(() => written.has(`${folder}/${name}`), `a write to ${name}`);
  await settle(20);
  return written.get(`${folder}/${name}`)!;
}

beforeEach(() => {
  folder++;
  written = new Map();
  holds = new Map();
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  (window as PickerWin).showSaveFilePicker = vi.fn(async () => {
    const path = nextPick;
    if (path === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
    return {
      name: path.slice(path.lastIndexOf('/') + 1), path,
      isSameEntry: async (other: { path?: string }) => other.path === path,
      createWritable: async () => {
        let data: BlobPart | undefined;
        // A hold applies to the next write to its path only.
        const gate = holds.get(path);
        holds.delete(path);
        return {
          write: async (d: BlobPart) => { data = d; },
          close: async () => { await gate; written.set(path, data!); },
        };
      },
    };
  });
});

afterEach(async () => {
  await unmountAll();
  delete (window as PickerWin).showSaveFilePicker;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const blobText = async (data: BlobPart) => data instanceof Blob ? data.text() : String(data);

/** Opened from the Preferences dialog; its Export CSV is a plain downloadBlob, and needs no flight. */
async function exportMyMaterials(host: HTMLElement, name: string): Promise<void> {
  await act(async () => { button(host, 'Preferences').click(); });
  await act(async () => { button(document.body, 'My materials…').click(); });
  pickNext(name);
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Export CSV of My materials"]')!.click(); });
}

/** A design App pauses autosave over: more expanded instances than the app keeps (App.instances.test.tsx). */
function excessiveTree(): RocketTree {
  let body: ComponentNode = { type: 'bodytube', id: 'deep' };
  for (let i = 0; i < 4; i++) body = { type: 'bodytube', children: [
    { type: 'podset', instanceCount: 32, children: [body] },
  ] };
  return { name: 'Oversized design', components: [{ type: 'stage', children: [body] }] };
}

async function pausedAutosave(): Promise<HTMLElement> {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ tree: excessiveTree(), savedAt: Date.now() }));
  const host = await mountApp();
  await settle(650);
  await waitFor(() => (host.textContent ?? '').includes('Download the autosaved design (.ork)'), 'the paused-autosave bar');
  return host;
}

const RKT = 'rocksimTestRocket1.rkt';

describe('a write the app did not make as the design save, over the saved design file, dirties it', () => {
  it('Export flight-data bundle (ZIP) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await fly(host);
    await saveOrkTo(host, 'Rocket.ork');
    await openTab(host, 'Results');
    await act(async () => { button(host, 'Export flight-data bundle').click(); });
    pickNext('Rocket.ork');
    await act(async () => { button(document.body, 'Download ZIP').click(); });
    const data = await writtenTo('Rocket.ork');
    expect((data as Blob).type).toBe('application/zip');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('Save image (PNG) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await fly(host);
    await saveOrkTo(host, 'Rocket.ork');
    await openTab(host, 'Results');
    pickNext('Rocket.ork');
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label^="Save image:"]')!.click(); });
    const data = await writtenTo('Rocket.ork');
    expect((data as Blob).type).toBe('image/png');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('a downloadBlob CSV (Flight data, through fileName.ts) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await fly(host);
    await saveOrkTo(host, 'Rocket.ork');
    await openTab(host, 'Results');
    pickNext('Rocket.ork');
    await act(async () => { button(host, '⬇ Flight data (.csv)').click(); });
    const data = await writtenTo('Rocket.ork');
    expect((data as Blob).type).toContain('text/csv');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('a downloadBlob CSV (My materials) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    await exportMyMaterials(host, 'Rocket.ork');
    const data = await writtenTo('Rocket.ork');
    expect((data as Blob).type).toContain('text/csv');
    await act(async () => { button(document.body, 'Close').click(); });
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('Download session debug log (feedback panel) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    await act(async () => { button(host, 'Feedback').click(); });
    pickNext('Rocket.ork');
    await act(async () => { button(host, 'Download session debug log').click(); });
    expect(await blobText(await writtenTo('Rocket.ork'))).not.toContain('<openrocket');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('the fatal-error bar\'s debug-log save (main.tsx\'s saveFile call) over the saved .ork', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    pickNext('Rocket.ork');
    // main.tsx's own options, verbatim: it adds nothing for the save to be heard.
    await act(async () => {
      await files.saveFile('debug log', {
        suggestedName: 'mmrocket-sim-session-debug.txt', mime: 'text/plain;charset=utf-8',
        extensions: ['.txt'], description: 'Session debug log',
      });
    });
    expect(await blobText(await writtenTo('Rocket.ork'))).toBe('debug log');
    expect(status(host)).toBe('Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('Download the autosaved design (.ork), while autosave is paused, over the saved .ork', async () => {
    const host = await pausedAutosave();
    await saveOrkTo(host, 'Rocket.ork');
    pickNext('Rocket.ork');
    await act(async () => { button(host, 'Download the autosaved design (.ork)').click(); });
    expect(await blobText(await writtenTo('Rocket.ork'))).toContain('Oversized design');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('an autosaved-design write finishing after an Open whose own Save .ork chose the same file', async () => {
    const host = await pausedAutosave();
    const release = hold('Rocket.ork');
    pickNext('Rocket.ork');
    await act(async () => { button(host, 'Download the autosaved design (.ork)').click(); });
    await pick(host, new File([fixture(RKT)], 'Replacement.rkt'));
    const discard = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Open without saving'));
    if (discard) await act(async () => { discard.click(); });
    await waitFor(() => shownName(host) === 'FooBar Test', 'the opened design');
    await saveOrkTo(host, 'Rocket.ork');
    expect(await blobText(written.get(`${folder}/Rocket.ork`)!)).toContain('FooBar Test');
    pickNext('Rocket.ork');
    await act(async () => { release(); });
    expect(await blobText(await writtenTo('Rocket.ork'))).toContain('Oversized design');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('replaces a .rkt design file\'s "Saved as .rkt" status when a foreign write overwrites it', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    pickNext('Rocket.rkt');
    await saveAs(host, 'Save .rkt');
    await writtenTo('Rocket.rkt');
    await waitFor(() => status(host)?.startsWith('Saved as .rkt') === true, 'the lossy status');
    await exportMyMaterials(host, 'Rocket.rkt');
    expect((await writtenTo('Rocket.rkt') as Blob).type).toContain('text/csv');
    await act(async () => { button(document.body, 'Close').click(); });
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);

  it('Export .csv — component data over a .rkt design file', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    pickNext('Rocket.rkt');
    await saveAs(host, 'Save .rkt');
    await writtenTo('Rocket.rkt');
    await waitFor(() => status(host)?.startsWith('Saved as .rkt') === true, 'the lossy status');
    pickNext('Rocket.rkt');
    await saveAs(host, 'Export .csv — component data');
    expect((await writtenTo('Rocket.rkt') as Blob).type).toContain('text/csv');
    await waitFor(() => status(host) === 'Unsaved changes', 'Unsaved changes');
    expect(await guarded(host)).toBe(true);
  }, 30000);
});

describe('what does not dirty the saved design', () => {
  it('a write to a different file', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    await exportMyMaterials(host, 'my-materials.csv');
    await writtenTo('my-materials.csv');
    await act(async () => { button(document.body, 'Close').click(); });
    expect(status(host)).toBe('No unsaved changes');
    expect(await guarded(host)).toBe(false);
  }, 30000);

  it('a cancelled Save-As dialog', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    await exportMyMaterials(host, 'cancel');
    await settle(50);
    await act(async () => { button(document.body, 'Close').click(); });
    expect(status(host)).toBe('No unsaved changes');
    expect(await guarded(host)).toBe(false);
  }, 30000);

  it('a write to the chosen file that failed and fell back to a download', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    const real = (window as PickerWin).showSaveFilePicker as () => Promise<{ createWritable: () => Promise<object> }>;
    (window as PickerWin).showSaveFilePicker = async () => ({ ...await real(),
      createWritable: async () => ({ write: async () => { throw new Error('Disk full'); }, close: async () => {} }) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportMyMaterials(host, 'Rocket.ork');
    await waitFor(() => click.mock.calls.length === 1, 'the fallback download');
    await settle(20);
    await act(async () => { button(document.body, 'Close').click(); });
    expect(status(host)).toBe('No unsaved changes');
    expect(await guarded(host)).toBe(false);
  }, 30000);

  it('a plain download, with no Save-As dialog (Firefox, Safari)', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    delete (window as PickerWin).showSaveFilePicker;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportMyMaterials(host, 'Rocket.ork');
    await waitFor(() => click.mock.calls.length === 1, 'the download');
    await settle(20);
    await act(async () => { button(document.body, 'Close').click(); });
    expect(status(host)).toBe('No unsaved changes');
    expect(await guarded(host)).toBe(false);
  }, 30000);

  it('a write that finishes after App has unmounted: App no longer listens', async () => {
    let live = 0;
    const subscribe = files.onCompletedSave;
    vi.spyOn(files, 'onCompletedSave').mockImplementation(listener => {
      live++;
      const off = subscribe(listener);
      return () => { live--; off(); };
    });
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    expect(live).toBe(1);
    await saveOrkTo(host, 'Rocket.ork');
    const release = hold('Rocket.ork');
    pickNext('Rocket.ork');
    const late = files.saveFile('late', { suggestedName: 'x.txt', mime: 'text/plain', extensions: ['.txt'], description: 'File' });
    await unmountAll();
    expect(live).toBe(0);
    release();
    await expect(late).resolves.toMatchObject({ kind: 'saved' });
  }, 30000);

  it('App\'s own Save .ork re-saved to the same file stays clean', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await saveOrkTo(host, 'Rocket.ork');
    await saveOrkTo(host, 'Rocket.ork');
    expect(status(host)).toBe('No unsaved changes');
    expect(await guarded(host)).toBe(false);
  }, 30000);

  it('App\'s own Save .rkt re-saved to its own file keeps its "Saved as .rkt" status', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    for (let i = 0; i < 2; i++) {
      pickNext('Rocket.rkt');
      await saveAs(host, 'Save .rkt');
      await writtenTo('Rocket.rkt');
    }
    await waitFor(() => status(host)?.startsWith('Saved as .rkt') === true, 'the lossy status');
    expect(await guarded(host)).toBe(false);
  }, 30000);
});
