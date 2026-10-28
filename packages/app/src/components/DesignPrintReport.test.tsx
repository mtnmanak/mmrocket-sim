// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DesignPrintReport } from './DesignPrintReport.js';
import { openPrintDocument } from '../services/printDocument.js';

vi.mock('../services/printDocument.js', async original => ({
  ...await original<typeof import('../services/printDocument.js')>(), openPrintDocument: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); vi.resetAllMocks(); });
it('opens the prepared report from a keyboard reachable button and reports preparation/pop-up failures', () => {
  act(() => root.render(<DesignPrintReport prepare={() => '<html>Selected flight</html>'} />));
  const button = host.querySelector('button')!;
  expect(button.textContent).toContain('Print design / flight report');
  button.focus();
  expect(document.activeElement).toBe(button);
  act(() => button.click());
  expect(openPrintDocument).toHaveBeenCalledWith('<html>Selected flight</html>');
  vi.mocked(openPrintDocument).mockImplementation(() => { throw new Error('Pop-up blocked'); });
  act(() => button.click());
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Caution:');
  expect(host.textContent).toContain('Pop-up blocked');
  act(() => root.render(<DesignPrintReport prepare={() => { throw new Error('Cannot build report'); }} />));
  act(() => host.querySelector('button')!.click());
  expect(host.textContent).toContain('Cannot build report');
});
it('its alert is sr-only while empty, and the same region shows a failure', () => {
  // One placement is the Results column's flex gap, so the empty region must be out of the flow.
  act(() => root.render(<DesignPrintReport prepare={() => '<html>Report</html>'} />));
  const region = host.querySelector('.print-report-alert')!;
  expect(region.getAttribute('role')).toBe('alert');
  expect(region.classList.contains('sr-only')).toBe(true);
  expect(region.textContent).toBe('');
  vi.mocked(openPrintDocument).mockImplementation(() => { throw new Error('Pop-up blocked'); });
  act(() => host.querySelector('button')!.click());
  expect(host.querySelector('.print-report-alert')).toBe(region);
  expect(region.classList.contains('sr-only')).toBe(false);
  expect(region.textContent).toContain('Could not open the report: Pop-up blocked');
});
