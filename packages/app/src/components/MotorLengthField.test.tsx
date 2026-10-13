// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MotorLengthField, MotorLengthReadout } from './MotorLengthField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mount length field estimates and units', () => {
  it.each(['auto', 3, 4] as const)('N005 quotes the same motor length as its field with precision %s', precision => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      fieldPrecision: precision, units: { motorDimensions: 'in' },
    }));
    const host = document.createElement('div');
    const root = createRoot(host);
    const value = 1.0625 * 0.0254;
    const commits: unknown[] = [];
    try {
      act(() => root.render(<PrefsProvider>
        <MotorLengthField mountName="Core" value={value} onCommit={v => commits.push(v)} />
        <MotorLengthReadout mountName="Core" value={value} onOpenDesign={() => {}} />
      </PrefsProvider>));
      const digits = precision === 4 ? '1.0625' : '1.063';
      expect(host.querySelector('input')!.value).toBe(digits);
      expect(host.querySelector('.motor-length-readout')!.textContent).toContain(`Max motor length: ${digits} in`);
      expect(commits).toEqual([]);
    } finally { act(() => root.unmount()); localStorage.clear(); }
  });
  it('updates the displayed room without overwriting a saved limit, and disables unavailable estimates', () => {
    localStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const commits: (number | undefined)[] = [];
    const render = (lengthM: number | null) => act(() => root.render(<PrefsProvider>
      <MotorLengthField mountName="Core" value={0.6} onCommit={(v) => commits.push(v)}
        room={lengthM === null ? null : { lengthM, limitedBy: 'the bulkhead' }} />
    </PrefsProvider>));
    try {
      render(0.55);
      expect(host.textContent).toContain('Room for 550 mm');
      expect(host.querySelector('input')!.value).toBe('600');
      render(0.45);
      expect(host.textContent).toContain('Room for 450 mm');
      expect(commits).toEqual([]);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Core"]')!.click());
      expect(commits).toEqual([0.45]);
      render(null);
      expect(host.textContent).toContain('No positive motor-room estimate');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Core"]')!.disabled).toBe(true);
      // The shared unit selector changes display, never the SI setting.
      act(() => {
        const select = host.querySelector<HTMLSelectElement>('.unit-chip')!;
        select.value = 'in';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(Number(host.querySelector('input')!.value)).toBeCloseTo(0.6 / 0.0254, 2);
      expect(commits).toEqual([0.45]);
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  });

  it('names a mount with no bore as the reason, not its length, position or overhang', () => {
    // A mount ticked Solid (filled), or with a wall as thick as its radius, has
    // no bore and so no room; the hint sent the reader to the wrong fields.
    localStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (noBore: 'solid' | 'wall' | null) => act(() => root.render(<PrefsProvider>
      <MotorLengthField mountName="Rod" value={null} onCommit={() => {}} room={null} noBore={noBore} />
    </PrefsProvider>));
    try {
      render('solid');
      expect(host.textContent).toContain('No motor fits this mount: it is ticked Solid (filled), so it has no bore.'
        + ' Untick Solid (filled) on it to make it a tube.');
      expect(host.textContent).not.toContain('Check its length');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Rod"]')!.disabled).toBe(true);
      render('wall');
      expect(host.textContent).toContain('No motor fits this mount: its wall is as thick as its radius, so it has no bore.');
      expect(host.textContent).not.toContain('Check its length');
      render(null);
      expect(host.textContent).toContain('No positive motor-room estimate is available for this mount.'
        + ' Check its length, position and overhang.');
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  });
});

describe("the motor card's read-only Max motor length", () => {
  const withReadout = (run: (host: HTMLDivElement, render: (noBore: 'solid' | 'wall' | null) => void, opened: string[]) => void) => {
    localStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const opened: string[] = [];
    const render = (noBore: 'solid' | 'wall' | null) => act(() => root.render(<PrefsProvider>
      <MotorLengthReadout mountName="Rod" value={null} noBore={noBore} onOpenDesign={() => opened.push('Rod')} />
    </PrefsProvider>));
    try {
      run(host, render, opened);
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  };

  it('says why no motor fits a mount with no bore, as Design does (CFG-3 review, finding 2)', () => withReadout((host, render) => {
    render('solid');
    expect(host.textContent).toContain('Max motor length: no limit');
    expect(host.textContent).toContain('No motor fits this mount: it is ticked Solid (filled), so it has no bore.'
      + ' Untick Solid (filled) on it to make it a tube.');
    render('wall');
    expect(host.textContent).toContain('No motor fits this mount: its wall is as thick as its radius, so it has no bore.');
    render(null);
    expect(host.textContent).not.toContain('No motor fits');
  }));

  it('names its Design link with the words it shows (WCAG 2.5.3, label in name)', () => withReadout((host, render, opened) => {
    render(null);
    const link = host.querySelector('button')!;
    const visible = link.textContent!.replace('▸', '').trim();
    expect(visible).toBe('set on Design');
    expect(link.getAttribute('aria-label')).toBe('Max motor length for Rod: set on Design');
    expect(link.getAttribute('aria-label')!.toLowerCase()).toContain(visible.toLowerCase());
    act(() => link.click());
    expect(opened).toEqual(['Rod']);
  }));
});
