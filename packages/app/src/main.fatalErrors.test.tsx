// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';

vi.mock('virtual:pwa-register', () => ({ registerSW: () => async () => {} }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => {} }) }));
vi.mock('./root.js', () => ({ AppRoot: () => null }));

it('installs the fatal bar in the real entry point and keeps a mounted root visible', async () => {
  const root = document.createElement('div');
  root.id = 'root';
  root.textContent = 'Mounted app';
  document.body.append(root);
  await import('./main.js');
  window.dispatchEvent(new ErrorEvent('error', { message: 'Entry-point exception' }));
  const bar = document.querySelector('.fatal-error-bar')!;
  expect(bar.textContent).toContain('Entry-point exception');
  expect(bar.nextElementSibling).toBe(root);
  expect(root.textContent).toBe('Mounted app');
  bar.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click();
  expect(document.querySelector('.fatal-error-bar')).toBeNull();
  root.remove();
});
