// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenMotorDialog } from './OpenMotorDialog.js';
import { findDbMotor } from '../services/motorDb.js';
import { loadExMotors } from '../services/exMotors.js';
import type { OpenMotorIdentity } from '../services/openMotorChoices.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identities: OpenMotorIdentity[] = ['Enerjet', 'Another maker'].map((manufacturer, i) => ({
  key: String(i), ref: { manufacturer, designation: 'F67', diameter: 0.0286, length: 0.127, delay: 6 },
  candidates: [findDbMotor('F67C')!, findDbMotor('F67W')!],
  carriedBy: [`Mount ${i + 1} — Configuration ${i + 1}`], locations: [],
}));
let host: HTMLDivElement;
let root: Root;
const apply = vi.fn().mockResolvedValue(undefined);
const later = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
const render = () => act(() => root.render(<OpenMotorDialog identities={identities} onApply={apply} onLater={later} />));
beforeEach(() => {
  localStorage.clear(); apply.mockClear(); later.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('open motor dialog', () => {
  it('shows two identities and their mounts/configurations, defaults to the matched rows', async () => {
    render();
    expect(host.querySelectorAll('fieldset')).toHaveLength(2);
    expect(host.textContent).toContain('The file names Enerjet F67. The motor database has no Enerjet F67.');
    expect(host.textContent).toContain('Mount 2 — Configuration 2');
    expect(host.textContent).toContain('AeroTech F67C (29 mm, 77.5 Ns, Classic)');
    expect(host.querySelectorAll('input[type=radio]:checked')).toHaveLength(2);
    await act(async () => button('Apply').click());
    expect(apply).toHaveBeenCalledWith(Object.fromEntries(identities.map(g => [g.key, { kind: 'catalogue', motor: g.candidates[0] }])));
  });
  it('applies a rival and leave-empty together', async () => {
    render();
    const sections = host.querySelectorAll('fieldset');
    act(() => {
      sections[0]!.querySelectorAll<HTMLInputElement>('input')[1]!.click();
      sections[1]!.querySelectorAll<HTMLInputElement>('input')[2]!.click();
    });
    await act(async () => button('Apply').click());
    expect(apply).toHaveBeenCalledWith({ '0': { kind: 'catalogue', motor: identities[0]!.candidates[1] }, '1': { kind: 'empty' } });
  });
  it.each(['button', 'Escape'])('decide later via %s never applies edited selections', mode => {
    render();
    act(() => host.querySelectorAll<HTMLInputElement>('input[type=radio]')[2]!.click());
    act(() => {
      if (mode === 'button') button('Decide later').click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(later).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
  });
  it('reuses the real EX import and selects its unique matching curve', async () => {
    render();
    act(() => button('Import .eng/.rse…').click());
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['F67 28.6 127 6 0.043 0.112 Enerjet\n0 0\n0.1 80\n1 0'], 'Enerjet.eng');
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(loadExMotors()).toHaveLength(1);
    expect(host.textContent).toContain('Enerjet F67 (EX, 28.6 mm)');
    await act(async () => button('Apply').click());
    expect(apply.mock.calls[0]![0]['0']).toMatchObject({ kind: 'ex', motor: { realManufacturer: 'Enerjet', designation: 'F67' } });
  });
  it('keeps choices and shows a failed Apply, allowing retry', async () => {
    apply.mockRejectedValueOnce(new Error('Curve unavailable'));
    render();
    await act(async () => button('Apply').click());
    expect(host.querySelector('[role=alert]')!.textContent).toBe('Curve unavailable');
    expect(button('Apply').disabled).toBe(false);
    expect(host.querySelectorAll('input[type=radio]:checked')).toHaveLength(2);
    expect(later).not.toHaveBeenCalled();
  });
});
