// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

/**
 * "All stats" opens by default on a desktop and stays closed on anything
 * narrower (the owner, 2026-08-23). The breakpoint is 981px because that is where
 * the hero-canvas layout starts; below it the drawer covers most of the
 * drawing. The JS check and the CSS layout must agree — if they drift, the
 * drawer opens on a viewport laid out for a phone, which is the exact problem
 * it was closed to avoid.
 */
describe('stats-drawer default and the desktop breakpoint', () => {
  it('App.tsx opens the drawer on the same breakpoint the layout uses', () => {
    const app = read('../App.tsx');
    expect(app).toContain("matchMedia('(min-width: 981px)').matches");
    // It must be the drawer's initial state, not some other decision.
    expect(/const \[statsDrawer, setStatsDrawer\] = useState\(\s*\(\) =>[^;]*min-width: 981px/s.test(app))
      .toBe(true);
  });

  it('styles.css still lays the hero canvas out at that same width', () => {
    expect(read('../styles.css')).toContain('@media (min-width: 981px)');
  });

  it('the phone home screen keeps its own, narrower breakpoint', () => {
    // 767px is the phone rule (tab default, drawer chrome). The two must stay
    // distinct: a phone must not inherit the desktop drawer.
    expect(read('../App.tsx')).toContain("matchMedia('(max-width: 767px)').matches");
  });
});
