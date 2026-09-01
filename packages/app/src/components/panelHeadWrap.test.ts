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
 * This is a source-text guard because the app has no full-render harness to
 * hang a geometric assertion on, and the mistake it catches is a textual one:
 * someone writes the inline flex again, or drops the class while editing a
 * header. The real geometry was verified with Playwright at 1922 / 1400 /
 * 400 px, which is the tool for anything geometric here — an unfocused MCP tab
 * throttles ResizeObserver and quietly reports stale boxes.
 */
describe('panel header rows wrap', () => {
  const SITES: Array<[string, string]> = [
    ['../App.tsx', 'Components'],
    ['../App.tsx', 'Rocket'],
    ['./DragPanel.tsx', 'Drag analysis'],
    ['./SimResults.tsx', 'Launch report'],
  ];

  it('.panel-head exists and actually wraps', () => {
    const css = read('../styles.css');
    const block = css.match(/\.panel-head\s*\{[^}]*\}/);
    expect(block, '.panel-head rule is missing from styles.css').not.toBeNull();
    expect(block![0]).toContain('flex-wrap: wrap');
    expect(block![0]).toContain('display: flex');
  });

  it('every panel header row carries the class rather than its own flex', () => {
    for (const [file, title] of SITES) {
      const src = read(file);
      // The header <div> immediately preceding this panel's <h2>.
      const re = new RegExp(`<div className="panel-head">\\s*<h2 style=\\{\\{ flex: 1 \\}\\}>\\s*${title}`);
      expect(re.test(src), `${file}: the "${title}" panel head is not using .panel-head`).toBe(true);
    }
  });

  it('no .panel header row has gone back to an unwrapped inline flex', () => {
    // Scoped to the four panels above by looking only at rows whose <h2> is one
    // of their titles — a dialog may legitimately keep its own inline style.
    for (const [file, title] of SITES) {
      const src = read(file);
      const re = new RegExp(
        `<div style=\\{\\{ display: 'flex', alignItems: 'baseline'[^}]*\\}\\}>\\s*<h2 style=\\{\\{ flex: 1 \\}\\}>\\s*${title}`,
      );
      expect(re.test(src), `${file}: "${title}" is back on an inline non-wrapping flex`).toBe(false);
    }
  });
});
