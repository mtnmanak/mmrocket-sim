// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RollControl } from './RollControl.js';

/**
 * The roll readout doubles as the reset button, and its only name was its
 * text, so a screen reader announced "12 degrees, button" with no word of what
 * pressing it does (audit 2026-09-22). The name now says it, and still OPENS
 * with the visible text so voice control's "click 12°" finds it.
 *
 * Rendered through react-dom's own root API with React's `act` (no
 * @testing-library in this workspace — see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe('RollControl — the reset button says what it does', () => {
  it('is named for the reset, opening with the angle it shows', () => {
    const onRoll = vi.fn();
    act(() => { root.render(<RollControl roll={(12 * Math.PI) / 180} onRoll={onRoll} />); });
    const reset = host.querySelector<HTMLButtonElement>('.roll-reset')!;
    expect(reset.textContent).toBe('12°');
    expect(reset.getAttribute('aria-label')).toBe("12° view roll — reset to the design's own angles");
    act(() => { reset.click(); });
    expect(onRoll).toHaveBeenCalledWith(0);
  });
});
