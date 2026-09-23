// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Modal } from './Modal.js';

/**
 * Daylight's modal scrim reaches the modals Modal.tsx renders (audit
 * 2026-09-22, Dead code row 578).
 *
 * The Daylight rule named `.modal-overlay`, a class no component has ever
 * rendered, so the four confirmation modals (Start a new design, Unsaved
 * changes, Open design from link, Convert camera shrouds) kept the everyday
 * 40 % scrim in the theme built for glare.
 *
 * Checked against the RENDERED element, not the component's source text: the
 * selectors come from styles.css's own scrim rule, and the backdrop is the
 * one Modal mounts inside a `.viz-root` carrying Daylight's attribute — the
 * way App mounts all four. A Modal portalled out to document.body, or a
 * renamed class, fails here; a string search of Modal.tsx would pass both.
 */
const DAYLIGHT_SCRIM = 'background: rgba(0, 0, 0, 0.72)';

/** Every selector of every styles.css rule that declares the Daylight scrim. */
function scrimSelectors(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '..', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  // Innermost blocks only: a rule inside an @media still matches, with its
  // own selector text, because the @media's `{` ends the capture before it.
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[2]!.includes(DAYLIGHT_SCRIM)) out.push(...m[1]!.split(',').map((s) => s.trim()));
  }
  return out;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The backdrop Modal renders, found INSIDE the viz-root it was mounted in. */
function backdropIn(contrast: string | undefined): Element | null {
  act(() => root.render(
    <div className="viz-root" data-contrast={contrast}>
      <Modal label="Unsaved changes" onClose={() => {}}>
        <h2>Save first?</h2>
      </Modal>
    </div>,
  ));
  return container.querySelector('.viz-root')!.querySelector('.modal-backdrop');
}

describe('Daylight: the modal scrim covers the modals', () => {
  it('the scrim rule in styles.css matches the backdrop Modal renders under Daylight', () => {
    const selectors = scrimSelectors();
    expect(selectors.length).toBeGreaterThan(0);
    const backdrop = backdropIn('high');
    expect(backdrop, 'Modal no longer renders its backdrop inside the tree it is mounted in').not.toBeNull();
    expect(selectors.filter((s) => backdrop!.matches(s))).not.toEqual([]);
  });

  it('and only under Daylight: the everyday theme keeps its own scrim', () => {
    const backdrop = backdropIn(undefined);
    expect(backdrop).not.toBeNull();
    expect(scrimSelectors().filter((s) => backdrop!.matches(s))).toEqual([]);
  });
});
