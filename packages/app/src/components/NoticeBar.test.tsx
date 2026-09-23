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
/** The two always-mounted announcers (audit 2026-09-22). */
const polite = () => host.querySelector('.notice-announce[role="status"]');
const assertive = () => host.querySelector('.notice-announce[role="alert"]');
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
  document.documentElement.style.removeProperty('--notice-h');
});

describe('NoticeBar', () => {
  it('draws no bar when there is nothing to say, but keeps its live regions mounted', () => {
    draw([]);
    expect(bar()).toBeNull();
    // A live region inserted WITH its first message is announced unreliably,
    // so both exist, empty, before anything is said (audit 2026-09-22 — the
    // bar used to render null here, taking its only region with it).
    expect(polite()?.textContent).toBe('');
    expect(polite()?.getAttribute('aria-live')).toBe('polite');
    expect(assertive()?.textContent).toBe('');
    expect(assertive()?.getAttribute('aria-live')).toBe('assertive');
  });

  it('shows information collapsed to a single line, announced politely', () => {
    draw([]);
    draw([info]);
    const el = bar()!;
    expect(el.textContent).toContain('Loaded “Goblin.ork”.');
    // The second line stays folded away until asked for.
    expect(el.textContent).not.toContain('Second line.');
    expect(polite()!.textContent).toBe('Notice: Loaded “Goblin.ork”.');
    expect(assertive()!.textContent).toBe('');
    // The visible bar is NOT itself a live region any more: expanding or
    // collapsing it rewrites its content, which re-read the whole bar.
    expect(el.getAttribute('aria-live')).toBeNull();
    expect(el.getAttribute('role')).toBe('region');
  });

  it('opens itself for a warning and announces assertively', () => {
    draw([]);
    draw([warn]);
    const el = bar()!;
    expect(el.className).toContain('notice-warn');
    expect(el.className).toContain('expanded');
    expect(el.textContent).toContain('needed repair');
    expect(assertive()!.textContent).toBe(`Warning: ${warn.text}`);
    expect(polite()!.textContent).toBe('');
  });

  /**
   * Audit 2026-09-22, measured: with the stale-session notice showing — every
   * returning user after every release — "Saved “X”" never rendered at all.
   * The collapsed bar led with the FIRST of equal severities, which was the
   * standing notice, and the live region changed only by "+1".
   */
  it('leads with the newest notice, and announces it, beside a standing one', () => {
    const stale: Notice = {
      id: 'stale-session', severity: 'info',
      text: 'This design was restored from autosave and was read in by an earlier build.',
    };
    const saved: Notice = { id: 'file-note', severity: 'info', text: 'Saved “Goblin.ork”.' };
    draw([stale]);
    draw([stale, saved]);
    expect(bar()!.querySelector('.notice-oneline')!.textContent).toBe('Notice: Saved “Goblin.ork”.');
    expect(host.querySelector('.notice-count')?.textContent).toBe('+1');
    expect(polite()!.textContent).toBe('Notice: Saved “Goblin.ork”.');

    // The same id with new words is new information: say it, and lead with it.
    draw([stale, { ...saved, text: 'Share link copied.' }]);
    expect(bar()!.querySelector('.notice-oneline')!.textContent).toBe('Notice: Share link copied.');
    expect(polite()!.textContent).toBe('Notice: Share link copied.');

    // It goes: the standing one leads again, and nothing new is announced.
    draw([stale]);
    expect(bar()!.querySelector('.notice-oneline')!.textContent).toContain('restored from autosave');
    expect(polite()!.textContent).toBe('Notice: Share link copied.');

    // The same words again after they went ARE a new event, and are said again.
    const before = polite()!.firstElementChild;
    draw([stale, { ...saved, text: 'Share link copied.' }]);
    expect(polite()!.textContent).toBe('Notice: Share link copied.');
    expect(polite()!.firstElementChild, 'identical text must still be a DOM change').not.toBe(before);
  });

  it('never lets the newest routine notice outrank an older problem', () => {
    draw([err]);
    draw([err, info]);
    expect(bar()!.className).toContain('notice-error');
    act(() => { buttonByLabel(/collapse notices/i).click(); });
    expect(bar()!.querySelector('.notice-oneline')!.textContent).toContain('Could not open that .ork file.');
    // The new routine notice is still announced — politely.
    expect(polite()!.textContent).toBe('Notice: Loaded “Goblin.ork”.');
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

  /**
   * Audit 2026-09-22: the bar re-opened whenever ANY notice changed while a
   * warning was still present, so after the user collapsed a warning, a
   * routine "Share link copied" threw it open again. Only a NEW problem
   * opens it now.
   */
  it('stays collapsed for a routine notice that arrives beside a warning already seen', () => {
    draw([warn]);
    act(() => { buttonByLabel(/collapse notices/i).click(); });
    draw([warn, info]);
    expect(bar()!.className, 'a new info notice re-opened the collapsed bar').not.toContain('expanded');
    draw([warn]);
    expect(bar()!.className).not.toContain('expanded');
  });

  it('still opens for a NEW problem, and for one that escalates', () => {
    draw([warn]);
    act(() => { buttonByLabel(/collapse notices/i).click(); });
    draw([warn, err]);
    expect(bar()!.className).toContain('expanded');

    act(() => { buttonByLabel(/collapse notices/i).click(); });
    draw([warn, err, { ...info, id: 'e' }]);
    expect(bar()!.className).not.toContain('expanded');
    // Same id, now a warning: that is new information.
    draw([warn, err, { ...info, id: 'e', severity: 'warn' }]);
    expect(bar()!.className).toContain('expanded');
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

  it('publishes its measured height, and takes the reserve back when it goes', () => {
    // happy-dom reports offsetHeight 0, so the component deliberately leaves
    // --notice-h unset rather than writing a "0px" that looks measured. Stub
    // a real height to exercise the publishing path.
    const proto = Object.getPrototypeOf(host) as HTMLElement;
    const orig = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 34 });
    try {
      draw([info]);
      expect(document.documentElement.style.getPropertyValue('--notice-h')).toBe('34px');
      draw([]);
      expect(document.documentElement.style.getPropertyValue('--notice-h')).toBe('');
    } finally {
      if (orig) Object.defineProperty(proto, 'offsetHeight', orig);
      else delete (proto as unknown as Record<string, unknown>)['offsetHeight'];
    }
  });

  it('names the severity for a screen reader, not just by colour', () => {
    draw([err]);
    expect(bar()!.querySelector('.sr-only')?.textContent).toBe('Error: ');
  });
});
