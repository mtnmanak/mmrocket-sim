import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelUnavailableError, resetKernelForTests, withKernel } from './simulateDesign.js';

beforeEach(() => { resetKernelForTests(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); resetKernelForTests(); });

describe('withKernel dead-holder guard', () => {
  it('poisons a stuck holder and refuses later calls with and without the option', async () => {
    void withKernel(() => new Promise(() => {}));
    await Promise.resolve();
    const fn = vi.fn();
    const waiting = withKernel(fn, undefined, { deadHolderMs: 100 });
    const rejection = expect(waiting).rejects.toBeInstanceOf(KernelUnavailableError);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    await expect(withKernel(fn)).rejects.toBeInstanceOf(KernelUnavailableError);
    await expect(withKernel(fn, undefined, { deadHolderMs: 100 })).rejects.toBeInstanceOf(KernelUnavailableError);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    resetKernelForTests();
    await expect(withKernel(() => 'clean')).resolves.toBe('clean');
  });

  it('runs behind a microtask-only holder and clears the waiting timer', async () => {
    const holder = withKernel(async () => { await Promise.resolve(); return 'holder'; });
    const waiting = withKernel(() => 'waiter', undefined, { deadHolderMs: 100 });
    expect(vi.getTimerCount()).toBe(1);
    await expect(holder).resolves.toBe('holder');
    await expect(waiting).resolves.toBe('waiter');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(withKernel(() => 'still clean')).resolves.toBe('still clean');
  });

  it('does not arm a timer for an uncontended call', async () => {
    await expect(withKernel(() => 'first', undefined, { deadHolderMs: 100 })).resolves.toBe('first');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original pending behavior without the option', async () => {
    void withKernel(() => new Promise(() => {}));
    const fn = vi.fn();
    let settled = false;
    void withKernel(fn).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(settled).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a rejected waiter even if its holder later settles', async () => {
    let release!: () => void;
    const holder = withKernel(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const fn = vi.fn();
    const waiting = withKernel(fn, undefined, { deadHolderMs: 100 });
    const rejection = expect(waiting).rejects.toBeInstanceOf(KernelUnavailableError);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    release();
    await holder;
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the waiting timer on abort without poisoning the kernel', async () => {
    let release!: () => void;
    const holder = withKernel(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const controller = new AbortController();
    const fn = vi.fn();
    const waiting = withKernel(fn, controller.signal, { deadHolderMs: 100 });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await holder;
    await expect(withKernel(() => 'clean')).resolves.toBe('clean');
    expect(fn).not.toHaveBeenCalled();
  });
});
