// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PlotImage, plotPng } from './PlotImage.js';
import * as saving from '../services/saveFile.js';

it('copies the current canvas onto an opaque themed PNG with wrapped identity, units and event key', async () => {
  const source = document.createElement('canvas'); source.width = 300; source.height = 200;
  const ctx = { fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), measureText: (s: string) => ({ width: s.length * 7 }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) { callback(new Blob(['png'], { type })); });
  const title = 'Long flight identity · Booster 2 · Vertical velocity (ft/s) versus Time (s)';
  const blob = await plotPng(source, [title, '1: Main deployment at 4.2 s'], '#fff', '#000');
  expect(blob.type).toBe('image/png');
  expect(ctx.fillRect).toHaveBeenCalled();
  expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, expect.any(Number));
  expect(ctx.fillText.mock.calls.map(c => c[0]).join(' ')).toBe(`${title} 1: Main deployment at 4.2 s`);
  vi.restoreAllMocks();
});

it('reports PNG failures and allows a retry that saves the identified plot', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const ref = { current: host };
  const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200; host.append(canvas);
  const controls = document.createElement('div'); host.append(controls); const root = createRoot(controls);
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const save = vi.spyOn(saving, 'saveFile').mockResolvedValue({ kind: 'downloaded', name: 'flight.png' });
  await act(async () => root.render(<PlotImage container={ref} title="Flight · Altitude (m) over Time (s)" />));
  const status = controls.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status!.textContent).toBe('');
  await act(async () => controls.querySelector('button')!.click());
  expect(controls.querySelector('[role="status"]')).toBe(status);
  expect(controls.textContent).toContain('Image could not be saved'); expect(save).not.toHaveBeenCalled();
  const text = vi.fn();
  context.mockReturnValue({ fillRect() {}, fillText: text, drawImage() {}, measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' })));
  await act(async () => controls.querySelector('button')!.click());
  expect(save).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ suggestedName: 'Flight_Altitude_m_over_Time_s_.png', mime: 'image/png', extensions: ['.png'] }));
  expect(text).toHaveBeenCalledWith('Flight · Altitude (m) over Time (s)', 12, expect.any(Number));
  expect(controls.textContent).toContain('download folder');
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks();
});

// The saved image copies the plot canvas, whose lines uPlot drew at its device
// ratio with dashes scaled to it (chartLegend deviceDashPlugin). The image's
// legend samples must take the SAME device-px dash and width, at ratio 2 too,
// or the key shows a pattern twice (or half) the length of the line it names.
it('draws each legend sample with the plotted line’s device-px dash and width at ratio 2', async () => {
  const { plotDash } = await import('../chartTheme.js');
  const source = document.createElement('canvas'); source.width = 1280; source.height = 600;
  Object.defineProperty(source, 'clientWidth', { value: 640 });
  const dashes: number[][] = []; const widths: number[] = [];
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (t, p) => p === 'measureText' ? (s: string) => ({ width: s.length * 7 })
      : p === 'setLineDash' ? (d: number[]) => { dashes.push(d); }
        : p === 'stroke' ? () => { widths.push(t['lineWidth'] as number); }
          : p in t ? t[p] : () => undefined,
    set: (t, p, v) => { t[p] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) { callback(new Blob(['png'], { type })); });
  await plotPng(source, ['Velocity'], '#fff', '#000',
    { entries: [{ label: 'Velocity (m/s)', color: '#226b47', dash: [12, 4] }, { label: 'Altitude (m)', color: '#006aab' }], strokeWidth: 2.5 });
  // What uPlot was given for the same series at pxRatio 2.
  expect(dashes).toEqual([plotDash([12, 4], 2), []]);
  expect(dashes[0]).toEqual([24, 8]);
  expect(widths).toEqual([5, 5]);
  vi.restoreAllMocks();
});
