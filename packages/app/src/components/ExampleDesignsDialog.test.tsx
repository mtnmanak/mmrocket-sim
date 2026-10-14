// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExampleDesignsDialog } from './ExampleDesignsDialog.js';
import * as examples from '../data/exampleDesigns.js';

vi.mock('../data/exampleDesigns.js', () => ({
  EXAMPLE_DESIGNS: [{ id: 'cluster', name: 'Three-motor cluster', fileName: 'cluster.ork', explanation: 'Three motors fire together.' }],
  loadExampleFile: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onClose = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;
const show = async () => { await act(async () => root.render(<ExampleDesignsDialog onOpen={onOpen} onClose={onClose} />)); };
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('explains each example, opens ordinary files, and labels the sample assumptions', async () => {
  const file = new File(['bytes'], 'cluster.ork');
  vi.mocked(examples.loadExampleFile).mockResolvedValue(file);
  await show();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Example designs');
  expect(host.querySelector('[role="dialog"]')?.classList.contains('example-design-dialog')).toBe(true);
  expect(host.textContent).toContain('Three motors fire together.');
  expect(host.textContent).toContain('assumed');
  await click('Three-motor cluster');
  expect(onOpen).toHaveBeenCalledWith(file);
});

it('keeps the design when an asset fails and allows a retry', async () => {
  vi.mocked(examples.loadExampleFile).mockRejectedValueOnce(new Error('Example could not be loaded.')).mockResolvedValueOnce(new File(['ok'], 'cluster.ork'));
  await show(); await click('Three-motor cluster');
  expect(host.textContent).toContain('Example could not be loaded.');
  expect(host.querySelector('.message-caution')?.textContent).toContain('Caution');
  expect(onOpen).not.toHaveBeenCalled();
  await click('Three-motor cluster');
  expect(onOpen).toHaveBeenCalledOnce();
});

it.each(['Close', 'Escape', 'unmount'])('cancels a pending load after %s', async dismissal => {
  let finish!: (file: File) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(examples.loadExampleFile).mockImplementation((_example, s) => {
    signal = s;
    return new Promise<File>(resolve => { finish = resolve; });
  });
  await show(); await click('Three-motor cluster');
  expect(button('Three-motor cluster').disabled).toBe(true);
  expect(host.textContent).toContain('Loading');
  if (dismissal === 'Close') await click('Close');
  else if (dismissal === 'Escape') await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  else await act(async () => { root.render(null); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(new File(['late'], 'cluster.ork')); });
  expect(onOpen).not.toHaveBeenCalled();
});

it('uses the current caller after work changes while the file loads', async () => {
  let finish!: (file: File) => void;
  vi.mocked(examples.loadExampleFile).mockImplementation(() => new Promise<File>(resolve => { finish = resolve; }));
  await show(); await click('Three-motor cluster');
  const current = vi.fn();
  await act(async () => { root.render(<ExampleDesignsDialog onOpen={current} onClose={onClose} />); });
  const file = new File(['chosen'], 'cluster.ork');
  await act(async () => { finish(file); });
  expect(current).toHaveBeenCalledWith(file);
  expect(onOpen).not.toHaveBeenCalled();
});

it('starts only one load when a button is activated twice before rendering', async () => {
  vi.mocked(examples.loadExampleFile).mockImplementation(() => new Promise<File>(() => {}));
  await show();
  await act(async () => { button('Three-motor cluster').click(); button('Three-motor cluster').click(); });
  expect(examples.loadExampleFile).toHaveBeenCalledOnce();
});
