// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { View3DBoundary } from './View3DBoundary.js';

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
