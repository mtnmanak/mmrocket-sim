// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentNode } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { finAlignmentJigGeometry } from '../services/finAlignmentJig.js';
import { FinAlignmentJigMenu } from './FinAlignmentJigMenu.js';

// The real geometry, so its refusal text is the one the menu shows; a test can
// hand it an out-of-range clearance, which the clearance box itself refuses.
vi.mock('../services/finAlignmentJig.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/finAlignmentJig.js')>();
  return { ...real, finAlignmentJigGeometry: vi.fn(real.finAlignmentJigGeometry) };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fin: ComponentNode = { type: 'trapezoidfinset', finCount: 3, thickness: 0.003, rootChord: 0.05, tipChord: 0.03, height: 0.03 };
const tube: ComponentNode = { type: 'bodytube', length: 0.3, outerRadius: 0.025, children: [fin] };

describe('FinAlignmentJigMenu', () => {
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
    vi.mocked(finAlignmentJigGeometry).mockReset();
  });

  it.each([
    ['mm', 'Clearance must be between 0 mm (0 in) and 10 mm (0.394 in).'],
    ['in', 'Clearance must be between 0 in (0 mm) and 0.394 in (10 mm).'],
  ])('checks the clearance in the preferred length unit (%s)', async (length, refusal) => {
    const real = (await vi.importActual<typeof import('../services/finAlignmentJig.js')>('../services/finAlignmentJig.js')).finAlignmentJigGeometry;
    vi.mocked(finAlignmentJigGeometry).mockImplementation((t, f, _clearance, units) => real(t, f, 0.02, units));
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length } }));
    act(() => root.render(<PrefsProvider><FinAlignmentJigMenu tree={{ components: [] }} tube={tube} fin={fin} /></PrefsProvider>));
    expect(vi.mocked(finAlignmentJigGeometry).mock.calls[0]![3]).toMatchObject({ length });
    expect(host.textContent).toContain(refusal);
  });
});
