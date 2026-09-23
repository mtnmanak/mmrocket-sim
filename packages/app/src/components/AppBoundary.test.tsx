// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBoundary } from './AppBoundary.js';
import { defaultTree } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { saveSessionDebounced } from '../services/session.js';
import { saveFile } from '../services/saveFile.js';

/**
 * THE ROOT BOUNDARY (audit 2026-09-22). A throw while rendering used to take
 * the whole app down, and a data-dependent one crash-looped every reload with
 * no way out but clearing the site's data — runs and imported motors with it.
 */
vi.mock('../services/saveFile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/saveFile.js')>()),
  saveFile: vi.fn(async () => ({ kind: 'downloaded', name: 'x' })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 'online-openrocket.session.v1';
const RUNS = 'online-openrocket.sim-runs.v1';
const EX = 'online-openrocket.ex-motors.v1';
const TAB = 'online-openrocket.workspace.v1';

let host: HTMLDivElement;
let root: Root;
let reloads: number;

const Boom = () => { throw new Error('Cannot read properties of undefined (reading maxMach)'); };

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

function renderCrashed() {
  // React logs the caught error itself; a PASSING test should not print a stack.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  act(() => root.render(<AppBoundary onReload={() => { reloads += 1; }}><Boom /></AppBoundary>));
}

beforeEach(() => {
  localStorage.clear();
  reloads = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  saveSessionDebounced({ tree: { ...defaultTree(), name: 'Crash Test' }, mountMotors: {}, launch: DEFAULT_CONDITIONS });
  vi.runAllTimers();
  localStorage.setItem(RUNS, '[{"id":"r1"}]');
  localStorage.setItem(EX, '[{"motorId":"ex1"}]');
  localStorage.setItem(TAB, 'results');
  vi.mocked(saveFile).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('AppBoundary', () => {
  it('renders its children untouched when nothing throws', () => {
    act(() => root.render(<AppBoundary><p>the app</p></AppBoundary>));
    expect(host.textContent).toBe('the app');
  });

  it('a throwing child renders the recovery panel, with the error, instead of a blank page', () => {
    renderCrashed();
    const panel = host.querySelector('[role="alert"]')!;
    expect(panel.textContent).toContain('Something went wrong');
    expect(panel.textContent).toContain('reading maxMach');
    expect(button('Download the autosaved design')).toBeTruthy();
    expect(button('Start fresh')).toBeTruthy();
  });

  it('"Download" hands over the autosaved design as an .ork', async () => {
    renderCrashed();
    await act(async () => { button('Download the autosaved design').click(); });
    expect(saveFile).toHaveBeenCalledTimes(1);
    const [data, opts] = vi.mocked(saveFile).mock.calls[0]!;
    expect(opts.suggestedName).toBe('Crash_Test-autosave.ork');
    expect(opts.extensions).toEqual(['.ork']);
    expect(String(data)).toContain('<name>Crash Test</name>');
    expect(host.textContent).toContain('Open it with Open…');
  });

  it('"Start fresh" asks first, then clears only the design and the remembered tab', () => {
    renderCrashed();
    act(() => { button('Start fresh').click(); });
    expect(reloads).toBe(0);
    expect(localStorage.getItem(SESSION)).not.toBeNull();
    // A write the crashed app left in the debounce must not land after the clear.
    saveSessionDebounced({ tree: { ...defaultTree(), name: 'Pending' }, mountMotors: {}, launch: DEFAULT_CONDITIONS });
    act(() => { button('Delete the autosave and start fresh').click(); });
    vi.runAllTimers();
    expect(reloads).toBe(1);
    expect(localStorage.getItem(SESSION)).toBeNull();
    expect(localStorage.getItem(TAB)).toBeNull();
    // Everything that is the only copy of something else is kept.
    expect(localStorage.getItem(RUNS)).toBe('[{"id":"r1"}]');
    expect(localStorage.getItem(EX)).toBe('[{"motorId":"ex1"}]');
  });

  it('"Start fresh" leaves ANOTHER tab’s autosave alone, and says so first (from review)', () => {
    // Another tab wrote its design into the slot since this one last did.
    const mine = JSON.parse(localStorage.getItem(SESSION)!) as Record<string, unknown>;
    const theirs = JSON.stringify({ ...mine, stamp: 'othertab', tree: { ...defaultTree(), name: 'Other Tab' } });
    localStorage.setItem(SESSION, theirs);
    renderCrashed();
    act(() => { button('Start fresh').click(); });
    expect(host.textContent).toContain('holds a design from another tab');
    act(() => { button('Discard this tab').click(); });
    expect(reloads).toBe(1);
    expect(localStorage.getItem(SESSION)).toBe(theirs);
    expect(localStorage.getItem(TAB)).toBeNull();
  });

  it('Cancel keeps the autosave', () => {
    renderCrashed();
    act(() => { button('Start fresh').click(); });
    act(() => { button('Cancel').click(); });
    expect(reloads).toBe(0);
    expect(localStorage.getItem(SESSION)).not.toBeNull();
  });
});
