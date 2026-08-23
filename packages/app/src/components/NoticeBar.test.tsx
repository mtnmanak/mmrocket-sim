// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoticeBar, type Notice } from './NoticeBar.js';

/**
 * The bottom notice strip (issues-2026-08-23a.md). Two properties matter and
 * both came straight from beta feedback:
 *
 *  - routine information must be QUIET — one line, politely announced —
 *    because a ten-line import note across the top of the workspace was
 *    "disconcerting" and pushed the Design tab's fixed-height drawing below
 *    the fold;
 *  - a problem must NOT get quieter with it. The old widget had no severity at
 *    all, so "Share link copied" and "Could not open that .ork file" rendered
 *    identically.
 *
 * Rendered through react-dom's own root API with React's `act` (no
 * @testing-library in this workspace — see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info: Notice = {
  id: 'a', severity: 'info', text: 'Loaded “Goblin.ork”.\nSecond line.',
};
const warn: Notice = {
  id: 'b', severity: 'warn', text: 'L1115-P: its published thrust curve needed repair.',
};
const err: Notice = {
  id: 'c', severity: 'error', text: 'Could not open that .ork file.',
};

let host: HTMLDivElement;
let root: Root;

const draw = (notices: Notice[]) => {
  act(() => { root.render(<NoticeBar notices={notices} />); });
};

const bar = () => host.querySelector('.notice-bar');
const buttonByLabel = (re: RegExp): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')]
    .find((b) => re.test(b.getAttribute('aria-label') ?? ''));
  if (!found) throw new Error(`no button matching ${re}`);
  return found as HTMLButtonElement;
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  document.body.classList.remove('has-notice');
});

describe('NoticeBar', () => {
  it('renders nothing when there is nothing to say', () => {
    draw([]);
    expect(host.innerHTML).toBe('');
  });

  it('shows information collapsed to a single line, announced politely', () => {
    draw([info]);
    const el = bar()!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.textContent).toContain('Loaded “Goblin.ork”.');
    // The second line stays folded away until asked for.
    expect(el.textContent).not.toContain('Second line.');
  });

  it('opens itself for a warning and announces assertively', () => {
    draw([warn]);
    const el = bar()!;
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.getAttribute('aria-live')).toBe('assertive');
    expect(el.className).toContain('notice-warn');
    expect(el.textContent).toContain('needed repair');
  });

  it('leads with the most serious notice, not the first one handed to it', () => {
    draw([info, err]);
    const el = bar()!;
    expect(el.className).toContain('notice-error');
    expect(el.textContent).toContain('Could not open that .ork file.');
  });

  it('expands and collapses on demand, showing every notice in full', () => {
    draw([info]);
    expect(bar()!.textContent).not.toContain('Second line.');

    act(() => { buttonByLabel(/show 1 notice in full/i).click(); });
    expect(bar()!.textContent).toContain('Second line.');

    act(() => { buttonByLabel(/collapse notices/i).click(); });
    expect(bar()!.textContent).not.toContain('Second line.');
  });

  it('counts the notices it is not showing while collapsed', () => {
    draw([info, { ...warn, severity: 'info', id: 'd' }]);
    expect(host.querySelector('.notice-count')?.textContent).toBe('+1');
  });

  it('dismisses only the notice that offers it', () => {
    let dismissed = 0;
    draw([{ ...err, onDismiss: () => { dismissed += 1; } }]);
    act(() => { buttonByLabel(/^dismiss:/i).click(); });
    expect(dismissed).toBe(1);
    // The warning beside it carries no dismiss control at all.
    draw([warn]);
    expect([...host.querySelectorAll('button')]
      .some((b) => /^dismiss:/i.test(b.getAttribute('aria-label') ?? ''))).toBe(false);
  });

  it('marks the body so the page can reserve room for the bar', () => {
    draw([info]);
    expect(document.body.classList.contains('has-notice')).toBe(true);
    draw([]);
    expect(document.body.classList.contains('has-notice')).toBe(false);
  });

  it('names the severity for a screen reader, not just by colour', () => {
    draw([err]);
    expect(host.querySelector('.sr-only')?.textContent).toBe('Error: ');
  });
});
