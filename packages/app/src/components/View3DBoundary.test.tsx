// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { View3DBoundary, isChunkLoadError } from './View3DBoundary.js';

/**
 * The app had exactly ONE error boundary — round the site nav band — so a
 * browser that refuses a WebGL context took the whole workspace down when the
 * user clicked 3D, not just that panel. Found by reading the code behind his
 * item 29, not reported: nobody who hit it would have connected the blank
 * screen to the tab they pressed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let backs: number;

beforeEach(() => {
  backs = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const Boom = ({ message }: { message: string }) => { throw new Error(message); };

const render = (child: React.ReactNode) => {
  // React logs the caught error itself; silence it so a PASSING test does not
  // print a stack trace that reads like a failure.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  act(() => root.render(
    <View3DBoundary onBack={() => { backs += 1; }}>{child}</View3DBoundary>,
  ));
};

describe('the 3D view’s error boundary', () => {
  it('renders its child untouched when nothing throws', () => {
    render(<div data-testid="scene">scene</div>);
    expect(host.querySelector('[data-testid="scene"]')).not.toBeNull();
    expect(host.querySelector('.hero-fallback')).toBeNull();
  });

  it('catches the WebGL failure instead of letting it unmount the app', () => {
    render(<Boom message="Error creating WebGL context." />);
    expect(host.querySelector('.hero-fallback')).not.toBeNull();
    expect(host.textContent).toContain('The 3D view could not start');
    // The reassurance matters as much as the error: the numbers are fine.
    expect(host.textContent).toContain('every number on the page is unchanged');
  });

  it('shows the thrown message, which is what a bug report needs', () => {
    render(<Boom message="Error creating WebGL context." />);
    expect(host.querySelector('.hero-fallback-detail')!.textContent)
      .toBe('Error creating WebGL context.');
  });

  it('offers a way out, and the button works', () => {
    render(<Boom message="nope" />);
    const btn = [...host.querySelectorAll('button')]
      .find((b) => /2D view/.test(b.textContent ?? ''))!;
    expect(btn).toBeDefined();
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(backs).toBe(1);
  });

  it('is announced, so a screen reader is told the panel changed', () => {
    render(<Boom message="nope" />);
    expect(host.querySelector('.hero-fallback')!.getAttribute('role')).toBe('status');
  });

  it('logs the failure rather than swallowing it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(
      <View3DBoundary onBack={() => {}}><Boom message="Error creating WebGL context." /></View3DBoundary>,
    ));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('3D view failed to start'))).toBe(true);
  });
});

/**
 * Audit 2026-09-22: a 3D chunk that failed to DOWNLOAD was blamed on the
 * graphics hardware, and the boundary offered no way to recover it — React.lazy
 * keeps the rejected import, so leaving the tab and coming back throws the
 * same error again until the page is reloaded.
 */
describe('the 3D view’s error boundary — a chunk that failed to download', () => {
  const CHROME = 'Failed to fetch dynamically imported module: https://mmrsim.mountainmanrockets.com/assets/Rocket3D-abc123.js';

  it('recognises each engine’s wording, and nothing else', () => {
    expect(isChunkLoadError(new TypeError(CHROME))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Rocket3D.css'))).toBe(true);
    const named = new Error('Loading chunk 7 failed.');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('Error creating WebGL context.'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('says the download failed, not the graphics hardware, and offers a reload', () => {
    render(<Boom message={CHROME} />);
    expect(host.textContent).toContain('could not be downloaded');
    expect(host.textContent).not.toContain('hardware acceleration');
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    const btn = [...host.querySelectorAll('button')].find((b) => /Reload/.test(b.textContent ?? ''))!;
    expect(btn, 'a reload button').toBeDefined();
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(reload).toHaveBeenCalledTimes(1);
    // The way back to 2D is still there.
    const back = [...host.querySelectorAll('button')].find((b) => /2D view/.test(b.textContent ?? ''))!;
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(backs).toBe(1);
  });

  it('still blames the drawing surface for a WebGL failure, with no reload', () => {
    render(<Boom message="Error creating WebGL context." />);
    expect(host.textContent).toContain('hardware acceleration');
    expect([...host.querySelectorAll('button')].some((b) => /Reload/.test(b.textContent ?? ''))).toBe(false);
  });
});
