// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

/**
 * A panel's header row must WRAP.
 *
 * Reported 2026-09-01: "the new scale button pushes the redo button out of the
 * components panel and under the rocket view panel". The Components header was
 * an inline `display:flex` with no `flex-wrap`, so adding the v0.090 Scale
 * button to a row that already held New / Undo / Redo pushed the last button
 * clean out of the panel. Nothing failed; the button simply left.
 *
 * The class, not the instance: FOUR `.panel` header rows shared that inline
 * style, so every one of them had the same hard ceiling on how many controls
 * its panel may ever own — and no signal when it was crossed. They now share
 * `.panel-head`, which wraps. The rows inside `.prefs-dialog` / `.modal-card`
 * are deliberately NOT in this set: those are width-controlled dialogs, they
 * measured clean, and pulling them in would change layouts nobody reported.
 *
 * The real geometry was verified with Playwright at 1922 / 1400 / 400 px,
 * which is the tool for anything geometric here — an unfocused MCP tab
 * throttles ResizeObserver and quietly reports stale boxes. What a test here
 * can hold is the class and the rule:
 *
 *  - THE RULE is below: `.panel-head` must wrap. The stylesheet is the only
 *    place that can say so, and nothing in this suite lays out a pixel.
 *  - THE CLASS is behaviour now (audit 2026-09-22, row 477). This file read
 *    App.tsx, DragPanel.tsx and SimResults.tsx for the markup, written before
 *    any test rendered App; App.render.test.tsx ("the panel header rows")
 *    mounts App and finds all four header rows as drawn — Components and
 *    Rocket on Design, Drag analysis on Results, the Launch report after a
 *    flight — each carrying `.panel-head` and no inline flex. Mutation-checked:
 *    one header's class changed fails it.
 */
describe('panel header rows wrap', () => {
  it('.panel-head exists and actually wraps', () => {
    const css = read('../styles.css');
    const block = css.match(/\.panel-head\s*\{[^}]*\}/);
    expect(block, '.panel-head rule is missing from styles.css').not.toBeNull();
    expect(block![0]).toContain('flex-wrap: wrap');
    expect(block![0]).toContain('display: flex');
  });
});
