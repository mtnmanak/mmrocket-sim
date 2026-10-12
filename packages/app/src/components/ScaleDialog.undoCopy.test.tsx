// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { ScaleDialog } from './ScaleDialog.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * WHAT CTRL+Z CANNOT PUT BACK AFTER SCALE (audit 2026-09-22).
 *
 * Scale clears the Measured mass & CG box AND every weighed pad mass (App's
 * onApply strips them from the working set, every saved configuration and the
 * file's unmatched references), and undo covers the design tree alone. The
 * dialog named the Measured box as "the one thing Ctrl+Z cannot put back" and
 * said nothing about the pad masses — v0.118 measured that lost hardware at
 * -2.8 to -3.0 % of apogee on the owner's own flights. The dialog is the last
 * thing the user reads before the click, so it has to name both.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/presets.js', () => ({ loadPresets: () => Promise.resolve([]) }));

let host: HTMLDivElement;
let root: Root;

const tree = (): RocketTree => ({
  name: 'r',
  components: [{
    type: 'stage', id: 's', children: [
      { type: 'nosecone', id: 'n', length: 0.25, aftRadius: 0.026 } as ComponentNode,
      { type: 'bodytube', id: 'b', length: 0.8, outerRadius: 0.026, thickness: 0.0015 } as ComponentNode,
    ],
  } as ComponentNode],
});

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ScaleDialog — what undo cannot restore', () => {
  it.each([false, true])('fills the loss disclosure only with actual measurements: %s', async losesMeasurements => {
    act(() => root.render(<PrefsProvider><ScaleDialog tree={tree()} assignedMotorDiameters={{}}
      losesMeasurements={losesMeasurements} onApply={() => {}} onSaveBackup={() => {}} onClose={() => {}} /></PrefsProvider>));
    await act(async () => { await Promise.resolve(); });
    const loss = [...host.querySelectorAll('p')].find(p => p.textContent?.includes('Ctrl+Z cannot'))!;
    expect(loss.closest('.message-danger') !== null).toBe(losesMeasurements);
    expect(host.querySelectorAll('.message-danger')).toHaveLength(losesMeasurements ? 1 : 0);
  });
  it('puts the exact items lost immediately above Scale, beside the backup button (D7 §5, X01)', async () => {
    act(() => root.render(<PrefsProvider><ScaleDialog tree={tree()} assignedMotorDiameters={{}}
      losesMeasurements lossDetail={{ massKg: 1.25, cgM: 0.5, padMass: false }}
      onApply={() => {}} onSaveBackup={() => {}} onClose={() => {}} /></PrefsProvider>));
    await act(async () => { await Promise.resolve(); });
    const block = host.querySelector('.message-danger')!;
    // Directly above the actions row that holds "Save a .ork backup first" and Scale.
    expect(block.nextElementSibling?.classList.contains('modal-actions')).toBe(true);
    expect(block.nextElementSibling!.textContent).toContain('Save a .ork backup first');
    const said = block.textContent!.replace(/\s+/g, ' ');
    expect(said).toContain('Measured mass & CG box (mass 1250 g, CG 500 mm)');
    // No pad mass exists, so none is named.
    expect(said).not.toContain('weighed pad mass');
    expect(said).toContain('Ctrl+Z cannot');
    // The generic paragraph is not repeated above.
    expect([...host.querySelectorAll('p')].filter(p => p.textContent?.includes('Ctrl+Z cannot'))).toHaveLength(1);
  });
  it('names only the pad masses when the Measured box is empty', async () => {
    act(() => root.render(<PrefsProvider><ScaleDialog tree={tree()} assignedMotorDiameters={{}}
      losesMeasurements lossDetail={{ massKg: null, cgM: null, padMass: true }}
      onApply={() => {}} onSaveBackup={() => {}} onClose={() => {}} /></PrefsProvider>));
    await act(async () => { await Promise.resolve(); });
    const said = host.querySelector('.message-danger')!.textContent!.replace(/\s+/g, ' ');
    expect(said).toContain('weighed pad mass');
    expect(said).not.toContain('Measured mass & CG');
  });
  it('names the weighed pad masses beside the Measured box, and does not call the box the only loss', async () => {
    act(() => {
      root.render(
        <PrefsProvider>
          <ScaleDialog tree={tree()} assignedMotorDiameters={{}} onApply={() => {}}
            onSaveBackup={() => {}} onClose={() => {}} />
        </PrefsProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    const para = [...host.querySelectorAll('p')].find((p) => p.textContent?.includes('Ctrl+Z cannot'));
    expect(para, 'the paragraph saying what undo cannot restore').toBeDefined();
    const said = para!.textContent!.replace(/\s+/g, ' ');
    expect(said).toContain('Measured mass & CG');
    expect(said).toContain('weighed pad mass');
    expect(said).not.toContain('the one thing');
  });
});
