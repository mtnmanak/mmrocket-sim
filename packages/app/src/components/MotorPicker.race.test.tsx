// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { MotorMeta } from '../services/simReport.js';
import { loadCatalogueMotor } from '../services/motorMatch.js';
import { MotorPicker } from './MotorPicker.js';

/**
 * A quick pick loads its curve asynchronously; the browser's pick lands at
 * once. Audit 2026-09-22: a slow quick-pick load that resolved AFTER a motor
 * chosen in the browser overwrote it, and the mass, CG and stability moved
 * with no sign of why. The latest choice wins now, whichever path it took.
 *
 * Its own file because both mocks below are hoisted over the whole module:
 * the load is held open by hand, and the browser is a one-button stand-in.
 */
vi.mock('../services/motorMatch.js', () => ({ loadCatalogueMotor: vi.fn() }));

const SPEC = {} as MotorSpec;
const META = {} as MotorMeta;
/** What the load resolves with — only the label is read on this path. */
const A8 = { label: 'Estes A8-3', spec: SPEC, meta: META } as NonNullable<Awaited<ReturnType<typeof loadCatalogueMotor>>>;

vi.mock('./MotorBrowser.js', () => ({
  MotorBrowser: ({ onSelect }: { onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void }) => (
    <button type="button" id="browser-pick" onClick={() => onSelect('AeroTech F20W', SPEC, META)}>F20W</button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let selected: string[];

beforeEach(() => {
  localStorage.clear();
  selected = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(loadCatalogueMotor).mockReset();
});

/** A load the test resolves by hand. */
const deferred = () => {
  let resolve!: (v: Awaited<ReturnType<typeof loadCatalogueMotor>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof loadCatalogueMotor>>>((r) => { resolve = r; });
  return { promise, resolve };
};

const render = () => act(() => root.render(
  <PrefsProvider>
    <MotorPicker
      mountDiameterMm={18}
      maxMotorLengthM={null}
      selectedLabel=""
      onSelect={(label) => { selected.push(label); }}
      showQuickPicks
    />
  </PrefsProvider>,
));

const quickPick = (label: string) => act(() => {
  const sel = host.querySelector<HTMLSelectElement>('select[aria-label="Quick picks"]')!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, label);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});

const clickBrowserPick = () => {
  const open = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Browse motors'))!;
  act(() => { open.click(); });
  act(() => { host.querySelector<HTMLButtonElement>('#browser-pick')!.click(); });
};

describe('MotorPicker — the latest choice wins', () => {
  it('a slow quick pick does not overwrite a motor chosen in the browser meanwhile', async () => {
    const slow = deferred();
    vi.mocked(loadCatalogueMotor).mockReturnValueOnce(slow.promise);
    render();
    quickPick('Estes A8-3');
    clickBrowserPick();
    expect(selected).toEqual(['AeroTech F20W']);

    await act(async () => {
      slow.resolve(A8);
      await slow.promise;
    });
    expect(selected, 'the A8 arrived late and must not replace the F20W').toEqual(['AeroTech F20W']);
    // And the picker is not left saying it is still loading.
    expect(host.textContent).not.toContain('loading…');
  });

  it('a quick pick that finishes on its own still loads', async () => {
    const slow = deferred();
    vi.mocked(loadCatalogueMotor).mockReturnValueOnce(slow.promise);
    render();
    quickPick('Estes A8-3');
    await act(async () => {
      slow.resolve(A8);
      await slow.promise;
    });
    expect(selected).toEqual(['Estes A8-3']);
  });

  it('the later of two choices wins when the browser pick comes first', async () => {
    // The browser, THEN a quick pick: the quick pick is the latest choice.
    const slow = deferred();
    vi.mocked(loadCatalogueMotor).mockReturnValueOnce(slow.promise);
    render();
    clickBrowserPick();
    quickPick('Estes A8-3');
    await act(async () => {
      slow.resolve(A8);
      await slow.promise;
    });
    expect(selected).toEqual(['AeroTech F20W', 'Estes A8-3']);
  });
});
