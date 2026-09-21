// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MotorPicker } from './MotorPicker.js';

/**
 * Quick Picks, ruled by Eric on 2026-09-21 (`issues-2026-09-18a` item 15):
 * offered only while the design is still the untouched starter rocket, and
 * filtered to what the mount takes. This component had NO test file at all,
 * which is how a 24 mm D12 came to be offered on an 18 mm mount for 91
 * releases while the browser refused it the whole time.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const render = (props: { boreMm: number; showQuickPicks: boolean; selectedLabel?: string }) => {
  act(() => root.render(
    <PrefsProvider>
      <MotorPicker
        mountDiameterMm={props.boreMm}
        maxMotorLengthM={null}
        selectedLabel={props.selectedLabel ?? ''}
        onSelect={() => {}}
        showQuickPicks={props.showQuickPicks}
      />
    </PrefsProvider>,
  ));
};

const options = (): string[] => [...host.querySelectorAll('select[aria-label="Quick picks"] option')]
  .map((o) => o.textContent ?? '');

describe('Quick Picks — offered only on the untouched starter rocket', () => {
  it('lists picks when the design is still pristine', () => {
    render({ boreMm: 18, showQuickPicks: true });
    expect(host.querySelector('select[aria-label="Quick picks"]')).not.toBeNull();
    expect(host.textContent).toContain('Quick picks');
  });

  it('replaces the dropdown with a plain readout once the design is touched', () => {
    render({ boreMm: 18, showQuickPicks: false, selectedLabel: 'AeroTech J460T' });
    expect(host.querySelector('select[aria-label="Quick picks"]')).toBeNull();
    // The dropdown's placeholder was the only place this card named the motor,
    // so the readout has to keep naming it — hiding the field outright would
    // strip the motor's name off every mount card.
    expect(host.textContent).toContain('AeroTech J460T');
    expect(host.textContent).toContain('Motor');
  });

  it('says so plainly when a touched design has no motor on the mount', () => {
    render({ boreMm: 18, showQuickPicks: false });
    expect(host.textContent).toContain('— no motor —');
  });

  it('keeps the browser button either way — blanking the picks must not remove the way to get a motor', () => {
    render({ boreMm: 18, showQuickPicks: false });
    expect(host.textContent).toContain('Browse motors');
    render({ boreMm: 18, showQuickPicks: true });
    expect(host.textContent).toContain('Browse motors');
  });
});

describe('Quick Picks — filtered to the mount bore', () => {
  it('drops the 24 mm D12 on the starter rocket’s 18 mm mount', () => {
    // The live defect: defaultTree()'s mount is outerRadius 0.0095 / wall
    // 0.0005, so bore = 18 mm, and MOUNT_TOLERANCE_MM is 1.
    render({ boreMm: 18, showQuickPicks: true });
    const o = options().join(' ');
    expect(o).toContain('A8-3');
    expect(o).toContain('B6-4');
    expect(o).toContain('C6-5');
    expect(o).not.toContain('D12');
  });

  it('offers all four on a 24 mm mount', () => {
    render({ boreMm: 24, showQuickPicks: true });
    const o = options().join(' ');
    for (const d of ['A8-3', 'B6-4', 'C6-5', 'D12-5']) expect(o).toContain(d);
  });

  it('falls back to the readout when nothing fits at all', () => {
    // A 13 mm mount takes none of the four; an empty dropdown would be worse
    // than none, so the field becomes the readout.
    render({ boreMm: 10, showQuickPicks: true, selectedLabel: 'Estes A10-3T' });
    expect(host.querySelector('select[aria-label="Quick picks"]')).toBeNull();
    expect(host.textContent).toContain('Estes A10-3T');
  });
});
