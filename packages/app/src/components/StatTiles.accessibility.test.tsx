// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { DesignStats, StatsChip, stabilityGlyphClass } from './StatTiles.js';
import type { StaticInfo } from '@online-openrocket/engine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('S2-5: stability meaning is available without glyph names or color', () => {
  it.each([
    [2, 'stable'], [3.4, 'over-stable'], [0.4, 'under-stable'], [NaN, 'unknown'],
  ])('names the state of %s cal', (cal, label) => {
    expect(stabilityGlyphClass(cal)).toMatchObject({ label });
    const info = { cna: 8, stabilityCalibers: cal, length: 1, refDiameter: 0.05,
      mass: 1, massEmpty: 1, cg: 0.5, cgEmpty: 0.5, cp: 0.6 } as StaticInfo;
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<DesignStats info={info} />), 'text/html');
    const tile = [...doc.querySelectorAll('.stat-tile')].find((el) => el.querySelector('.stat-label')?.textContent === 'Stability')!;
    expect(tile.querySelector('.sr-only')?.textContent).toContain(label);
    expect(tile.querySelector('[aria-hidden="true"]')?.textContent).toBe(stabilityGlyphClass(cal).glyph);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<StatsChip info={info} />));
      for (let i = 0; i < 2; i++) {
        const value = host.querySelector('.stats-chip-value[class*="stability-"]')!;
        expect(value.querySelector('.sr-only')?.textContent).toContain(label);
        expect(value.querySelector('[aria-hidden="true"]')?.textContent).toBe(stabilityGlyphClass(cal).glyph);
        act(() => { host.querySelector<HTMLButtonElement>('.stats-chip-fold')!.click(); });
      }
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  });
});
