// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigStabilityRange } from './ConfigStabilityRange.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { StabilityRangeInput } from '../services/configStabilityRange.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class RangeWorker {
  static instance: RangeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  messages: { id: number; input?: StabilityRangeInput }[] = [];
  terminated = false;
  constructor() { RangeWorker.instance = this; }
  postMessage(message: { id: number; input?: StabilityRangeInput }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
const input: StabilityRangeInput = { tree: { components: [] }, configs: [], kbf: true,
  supersonic: false, measuredDryMassKg: null };
const result = { cases: [{ id: 'a', label: 'Club field', cal: 0.8, pct: 4 },
  { id: 'empty', label: 'Empty rocket (no motor)', cal: 2, pct: 10 },
  { id: 'b', label: 'Sustainer only', unavailable: 'Inactive stages are not represented by the app (R6).' }],
  min: { id: 'a', label: 'Club field', cal: 0.8, pct: 4 },
  max: { id: 'empty', label: 'Empty rocket (no motor)', cal: 2, pct: 10 }, complete: false, builds: 2 };
let cleanup = () => {};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('labels a partial range and its worst configuration, rejects a stale answer, and disposes its worker', () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', RangeWorker);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = (value: StabilityRangeInput) => act(() => root.render(<PrefsProvider>
    <ConfigStabilityRange input={value} /></PrefsProvider>));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  render(input);
  expect(host.textContent).toContain('Calculating');
  act(() => { vi.advanceTimersByTime(250); });
  const worker = RangeWorker.instance;
  const firstId = worker.messages[0]!.id;
  render({ ...input, supersonic: true });
  act(() => worker.onmessage!({ data: { id: firstId, result } }));
  expect(host.textContent).not.toContain('Club field');
  act(() => { vi.advanceTimersByTime(250); });
  const id = worker.messages.at(-1)!.id;
  act(() => worker.onmessage!({ data: { id: firstId, result } }));
  expect(host.textContent).not.toContain('Club field');
  act(() => worker.onmessage!({ data: { id, result } }));
  expect(host.textContent).toContain('Partial stability range');
  expect(host.textContent).toContain('0.80–2.00 cal');
  expect(host.textContent).toContain('Lowest margin: Club field');
  const details = host.querySelector('details')!;
  expect(details.querySelector('summary')).not.toBeNull();
  expect(details.textContent).toContain('Sustainer only');
  expect(details.textContent).toContain('Inactive stages');
  cleanup(); cleanup = () => {};
  expect(worker.terminated).toBe(true);
});

it('keeps a worker failure beside the qualified readout and offers a retry', () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', RangeWorker);
  const host = document.createElement('div'); const root = createRoot(host);
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  act(() => root.render(<PrefsProvider><ConfigStabilityRange input={input} /></PrefsProvider>));
  act(() => { vi.advanceTimersByTime(250); });
  act(() => RangeWorker.instance.onerror!());
  expect(host.textContent).toContain('unavailable');
  expect(host.querySelector('button')?.textContent).toBe('Retry');
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('Calculating');
});
