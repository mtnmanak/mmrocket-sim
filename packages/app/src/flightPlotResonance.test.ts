import { expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { readFileSync } from 'node:fs';
import { resonanceBandPlugin, rollPitchRange } from './flightPlotResonance.js';

it('keeps the whole band visible for below-band, above-band and missing data', () => {
  for (const [min, max] of [[0, 0.2], [3, 5], [NaN, NaN], [null, null]]) {
    const [low, high] = rollPitchRange({} as uPlot, min!, max!);
    expect(Number.isFinite(low) && Number.isFinite(high)).toBe(true);
    expect(low).toBeLessThan(0.85);
    expect(high).toBeGreaterThan(1.15);
    if (Number.isFinite(min)) expect(low).toBeLessThan(min!);
    if (Number.isFinite(max)) expect(high).toBeGreaterThan(max!);
  }
});

it('draws a clipped shaded band and thin unity line before series, in chart reference ink', () => {
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    fillRect: vi.fn((_x: number, _y: number, _w: number, _h: number) => { expect(ctx.globalAlpha).toBe(0.12); }),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(() => { expect(ctx.globalAlpha).toBe(1); }), setLineDash: vi.fn(),
    fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 0 };
  const u = { ctx, bbox: { left: 10, top: 20, width: 100, height: 200 },
    valToPos: vi.fn((v: number) => 200 - v * 100) } as unknown as uPlot;
  const plugin = resonanceBandPlugin({ reference: 'reference-ink' });
  const hooks = plugin.hooks!.drawAxes!;
  for (const hook of Array.isArray(hooks) ? hooks : [hooks]) hook!(u);
  expect(ctx.fillStyle).toBe('reference-ink');
  expect(ctx.strokeStyle).toBe('reference-ink');
  expect(u.valToPos).toHaveBeenNthCalledWith(1, 1.15, 'y', true);
  expect(u.valToPos).toHaveBeenNthCalledWith(2, 0.85, 'y', true);
  expect(u.valToPos).toHaveBeenNthCalledWith(3, 1, 'y', true);
  expect(ctx.rect).toHaveBeenCalledWith(10, 20, 100, 200);
  expect(ctx.fillRect).toHaveBeenCalledOnce();
  expect(ctx.fillRect.mock.calls[0]![0]).toBe(10);
  expect(ctx.fillRect.mock.calls[0]![1]).toBeCloseTo(85, 12);
  expect(ctx.fillRect.mock.calls[0]![2]).toBe(100);
  expect(ctx.fillRect.mock.calls[0]![3]).toBeCloseTo(30, 12);
  expect(ctx.moveTo).toHaveBeenCalledWith(10, 100);
  expect(ctx.lineTo).toHaveBeenCalledWith(110, 100);
  expect(ctx.stroke).toHaveBeenCalledOnce();
  expect(ctx.lineWidth).toBe(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  expect(ctx.setLineDash).toHaveBeenCalledWith([]);
  expect(ctx.clip).toHaveBeenCalledOnce();
  expect(ctx.restore).toHaveBeenCalledOnce();
  const order = [ctx.save, ctx.beginPath, ctx.rect, ctx.clip, ctx.fillRect, ctx.setLineDash,
    ctx.beginPath, ctx.moveTo, ctx.lineTo, ctx.stroke, ctx.restore]
    .map((fn, i) => fn.mock.invocationCallOrder[i === 6 ? 1 : 0]!);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const source = readFileSync(new URL('./flightPlotResonance.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
