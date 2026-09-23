// @vitest-environment happy-dom
import { act, lazy, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyDialog } from './LazyDialog.js';
import { openModalCount } from './useDialog.js';

/**
 * The frame round the lazy-loaded guide and changelog (audit 2026-09-22, row
 * 510). Loaded eagerly, those dialogs took focus on open, answered Escape and
 * handed focus back on close (useDialog); lazy, they must still do all three
 * across the download, and a download that fails must not take the app down.
 *
 * The real GuideDialog behind a gate the test opens, so the download's two
 * moments — still loading, arrived — can each be looked at.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DialogType = ComponentType<{ onClose: () => void }>;

function Harness({ Dialog }: { Dialog: DialogType }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>Guide</button>
      {open && (
        <LazyDialog label="User guide" onClose={() => setOpen(false)}>
          <Dialog onClose={() => setOpen(false)} />
        </LazyDialog>
      )}
    </>
  );
}

/** A lazy GuideDialog whose import waits until `arrive()` is called. */
function gatedGuide(): { Dialog: DialogType; arrive: () => void } {
  let arrive!: () => void;
  const gate = new Promise<void>((r) => { arrive = r; });
  const Dialog = lazy(() => gate.then(() => import('./GuideDialog.js')).then((m) => ({ default: m.GuideDialog })));
  return { Dialog, arrive };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const opener = () => host.querySelector<HTMLButtonElement>('#opener')!;
const dialogs = () => [...host.querySelectorAll<HTMLElement>('[role="dialog"]')];
const open = () => {
  act(() => { opener().focus(); });
  act(() => { opener().click(); });
};
const press = (key: string) => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  if (!pred()) throw new Error(`timed out waiting for ${what}`);
}

describe('LazyDialog — while the dialog downloads', () => {
  it('stands in with the same name, modal and busy, and takes focus', () => {
    const { Dialog } = gatedGuide();
    act(() => root.render(<Harness Dialog={Dialog} />));
    open();
    const [standIn, ...more] = dialogs();
    expect(more).toHaveLength(0);
    expect(standIn!.getAttribute('aria-label')).toBe('User guide');
    expect(standIn!.getAttribute('aria-modal')).toBe('true');
    expect(standIn!.getAttribute('aria-busy')).toBe('true');
    expect(standIn!.querySelector('[role="status"]')?.textContent).toBe('Loading the user guide…');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close user guide');
    expect(standIn!.contains(document.activeElement)).toBe(true);
    // It holds the design's undo binding, as the real dialog will.
    expect(openModalCount()).toBe(1);
  });

  it('closes on Escape and hands focus back to the button that opened it', () => {
    const { Dialog } = gatedGuide();
    act(() => root.render(<Harness Dialog={Dialog} />));
    open();
    expect(dialogs()).toHaveLength(1);
    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener());
    expect(openModalCount()).toBe(0);
  });
});

describe('LazyDialog — when the dialog arrives', () => {
  it('replaces the stand-in, moves focus into the real dialog, and returns it on close', async () => {
    const { Dialog, arrive } = gatedGuide();
    act(() => root.render(<Harness Dialog={Dialog} />));
    open();
    arrive();
    await waitFor(() => host.querySelector('.guide-dialog') !== null, 'the guide to arrive');

    const [guide, ...more] = dialogs();
    expect(more, 'the stand-in is gone').toHaveLength(0);
    expect(guide!.classList.contains('guide-dialog')).toBe(true);
    expect(guide!.getAttribute('aria-label')).toBe('User guide');
    expect(guide!.getAttribute('aria-modal')).toBe('true');
    expect(guide!.hasAttribute('aria-busy')).toBe(false);
    // Focus is inside the REAL dialog — its own ✕, the first thing in it.
    expect(guide!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close user guide');
    expect(openModalCount()).toBe(1);

    // ✕ Close hands focus back to the opener — which the stand-in's cleanup
    // gave back first, so the real dialog recorded the opener, not the stand-in.
    act(() => { (document.activeElement as HTMLButtonElement).click(); });
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener());
    expect(openModalCount()).toBe(0);
  });

  it('opens straight into the real dialog once downloaded, and Escape still closes it', async () => {
    const { Dialog, arrive } = gatedGuide();
    act(() => root.render(<Harness Dialog={Dialog} />));
    open();
    arrive();
    await waitFor(() => host.querySelector('.guide-dialog') !== null, 'the guide to arrive');
    press('Escape');
    expect(dialogs()).toHaveLength(0);

    open(); // no download this time, so no stand-in in between
    expect(dialogs().map((d) => d.className)).toEqual(['guide-dialog panel']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close user guide');
    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener());
  });
});

describe('LazyDialog — when the download fails', () => {
  it('says so in a dialog that closes like any other, instead of taking the page down', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Chrome's words for a chunk it could not fetch (isChunkLoadError).
    const Dialog = lazy<DialogType>(() => Promise.reject(
      new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/GuideDialog-x.js')));
    act(() => root.render(<Harness Dialog={Dialog} />));
    open();
    await waitFor(() => (host.textContent ?? '').includes('could not be downloaded'), 'the failure notice');

    const [notice, ...more] = dialogs();
    expect(more).toHaveLength(0);
    expect(notice!.getAttribute('aria-label')).toBe('User guide');
    expect(notice!.getAttribute('aria-modal')).toBe('true');
    expect(notice!.hasAttribute('aria-busy')).toBe(false);
    expect(notice!.textContent).toContain('The user guide could not be downloaded.');
    expect([...notice!.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['✕ Close', '↻ Reload the page']);
    expect(notice!.contains(document.activeElement)).toBe(true);
    expect(opener().isConnected, 'the page behind is still there').toBe(true);
    expect(logged).toHaveBeenCalled();

    press('Escape');
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener());
  });

  it('a throw that is not a download names no network cause and offers no reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken: DialogType = () => { throw new Error('boom'); };
    act(() => root.render(<Harness Dialog={Broken} />));
    open();
    await waitFor(() => dialogs().length === 1, 'the failure notice');
    expect(dialogs()[0]!.textContent).toContain('The user guide could not be shown.');
    expect(dialogs()[0]!.textContent).toContain('boom');
    expect(dialogs()[0]!.textContent).not.toContain('Reload');
  });
});
