// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './root.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { saveFile } from './services/saveFile.js';
import { discardSession, saveSessionDebounced, sessionConflicted } from './services/session.js';
import { defaultTree } from './tree/treeModel.js';

/**
 * THE TREE main.tsx MOUNTS, rendered (audit 2026-09-22, from review: the only
 * check that the app sat inside the root boundary was a regex over main.tsx's
 * source). App itself is stubbed — a real App is ~2.5 s a mount and is not
 * what is under test; whether a throw from INSIDE it reaches the recovery
 * panel is.
 */
let appThrows = false;
vi.mock('./App.js', () => ({
  App: () => {
    if (appThrows) throw new Error('App fell over while drawing');
    return <p>the app</p>;
  },
}));
vi.mock('./services/saveFile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/saveFile.js')>()),
  saveFile: vi.fn(async () => ({ kind: 'downloaded', name: 'x' })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 'online-openrocket.session.v1';

let host: HTMLDivElement;
let root: Root;

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

function autosave(name: string) {
  saveSessionDebounced({ tree: { ...defaultTree(), name }, mountMotors: {}, launch: DEFAULT_CONDITIONS });
  vi.runAllTimers();
}

/** Another tab's "Keep this tab's design", as this tab's `storage` event delivers it. */
function anotherTabTakesOver(name: string) {
  const mine = JSON.parse(localStorage.getItem(SESSION)!) as { stamp: string };
  const theirs = `{"stamp":"othertab","over":"${mine.stamp}","tree":${JSON.stringify({ ...defaultTree(), name })},`
    + `"launch":${JSON.stringify(DEFAULT_CONDITIONS)},"savedAt":1}`;
  localStorage.setItem(SESSION, theirs);
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: SESSION, newValue: theirs })); });
}

beforeEach(() => {
  localStorage.clear();
  appThrows = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.mocked(saveFile).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  discardSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('AppRoot', () => {
  it('renders the app when nothing throws', () => {
    act(() => root.render(<AppRoot />));
    expect(host.textContent).toBe('the app');
  });

  it('a throw inside App reaches the recovery panel, and its download is the autosaved design', async () => {
    autosave('Root Crash');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    appThrows = true;
    act(() => root.render(<AppRoot />));
    expect(host.textContent).toContain('Something went wrong');
    expect(host.textContent).toContain('App fell over while drawing');
    await act(async () => { button('Download the autosaved design').click(); });
    expect(String(vi.mocked(saveFile).mock.calls[0]?.[0])).toContain('<name>Root Crash</name>');
  });

  it('installs the other-tab watcher, and takes it down on unmount', () => {
    act(() => root.render(<AppRoot />));
    autosave('Mine');
    anotherTabTakesOver('Theirs');
    expect(sessionConflicted()).toBe(true);

    act(() => root.unmount());
    root = createRoot(host);
    discardSession();
    localStorage.clear();
    autosave('Mine again');
    anotherTabTakesOver('Theirs again');
    expect(sessionConflicted()).toBe(false);
  });

  it('a crashed tab still hears the takeover, so its download stays its own design', async () => {
    autosave('This tab\'s rocket');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    appThrows = true;
    act(() => root.render(<AppRoot />));
    anotherTabTakesOver('The other tab\'s rocket');
    await act(async () => { button('Download the autosaved design').click(); });
    expect(String(vi.mocked(saveFile).mock.calls[0]?.[0])).toContain('<name>This tab\'s rocket</name>');
    // And "Start fresh" says whose autosave it would be leaving alone.
    act(() => { button('Start fresh').click(); });
    expect(host.textContent).toContain('holds a design from another tab');
  });
});

describe('main.tsx', () => {
  it('mounts AppRoot — a source-text guard only; AppRoot itself is rendered above', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.tsx'), 'utf8');
    expect(src).toContain('<AppRoot />');
  });
});
