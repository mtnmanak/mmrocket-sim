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
async function importText(section: number, text: string, click = true) {
  if (click) act(() => host.querySelectorAll('fieldset')[section]!.querySelector('button')!.click());
  const inputs = host.querySelectorAll<HTMLInputElement>('input[type=file]');
  const input = inputs[section] ?? inputs[0]!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'Enerjet_F67.eng')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
// Al's complete 504-byte Enerjet_F67.eng, inlined so CI does not depend on docs/.
const enerjetEng = `; Enerjet F67 (1971 catalog No. 741) - digitized from catalog thrust curve,
; scaled to catalog total impulse 80 N-s. Approximation, not measured data.
F67 28.6 127 6 0.0430 0.1120 Enerjet
   0.030 36.13
   0.050 87.16
   0.080 76.78
   0.105 58.71
   0.140 56.90
   0.200 59.16
   0.300 64.58
   0.400 69.55
   0.500 74.52
   0.600 79.03
   0.700 84.00
   0.800 88.97
   0.870 91.23
   0.920 90.32
   0.950 86.26
   1.000 65.48
   1.050 48.32
   1.100 32.52
   1.150 17.61
   1.200 3.61
   1.230 0.00
;
`;
beforeEach(() => {
  localStorage.clear(); apply.mockClear(); later.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('open motor dialog', () => {
  it.each([true, false])('B1 selects the real Enerjet file using the LEM-1 reference (button click %s)', async click => {
    render();
    expect(new TextEncoder().encode(enerjetEng)).toHaveLength(504);
    await importText(0, enerjetEng, click);
    expect(host.textContent).toContain('Enerjet F67 (EX, 28.6 mm)');
    expect(host.textContent).not.toContain('No imported motor matches');
    expect(host.querySelectorAll('fieldset')[0]!.querySelector('input:checked')!.parentElement!.textContent).toContain('Enerjet F67 (EX');
    await act(async () => button('Apply').click());
    expect(apply.mock.calls[0]![0]['0']).toMatchObject({ kind: 'ex', motor: { realManufacturer: 'Enerjet', diameter: 28.6 } });
  });

  it.each([28.6, 38])('C2 reconciles another section EX choice after a %s mm replacement', async diameter => {
    render();
    await importText(0, enerjetEng);
    await importText(1, `F67 ${diameter} 127 6 0.043 0.112 Enerjet\n0 0\n0.1 160\n1 0\n;\nF67 28.6 127 6 0.043 0.112 Another maker\n0 0\n0.1 90\n1 0`);
    const checked = host.querySelectorAll('fieldset')[0]!.querySelectorAll('input:checked');
    expect(checked).toHaveLength(1);
    await act(async () => button('Apply').click());
    const choice = apply.mock.calls[0]![0]['0'];
    if (diameter === 38) {
      expect(choice).toEqual({ kind: 'catalogue', motor: identities[0]!.candidates[0] });
      expect(checked[0]!.parentElement!.textContent).toContain('AeroTech F67C');
    } else {
      expect(choice.kind).toBe('ex');
      expect(choice.motor.samples.some((s: { thrust: number }) => s.thrust === 160)).toBe(true);
      expect(checked[0]!.parentElement!.textContent).toContain('Enerjet F67 (EX');
    }
  });

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
