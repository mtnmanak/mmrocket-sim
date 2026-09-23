// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

/**
 * THE BUG THIS PINS, and why a text guard is the right shape for it.
 *
 * `.notice-bar` is `position: fixed; bottom: 0`, and on a phone `.workspace-tabs`
 * is fixed at `bottom: 0` too. So on a phone the bar has to be lifted clear of
 * the tab bar or it paints over all four tabs and, having no `pointer-events`
 * rule of its own, takes their taps as well.
 *
 * The lift was written in v0.074 and never once applied. It lived inside the
 * `@media (max-width: 767px)` block near the top of the sheet, ~1,850 lines
 * ABOVE the unconditional `.notice-bar { bottom: 0 }`. Both selectors are the
 * bare class — (0,1,0) each, and a media query contributes no specificity — so
 * the cascade fell through to source order and the later rule won. It shipped
 * dead in every release from v0.074 to v0.134.
 *
 * Nothing here can measure a rendered pixel (there is no browser in this
 * suite), so this asserts the one property that actually decides it: ORDER.
 * Mutation-checked — appending `.notice-bar { bottom: 0 }` at the end of
 * styles.css turns the first case red.
 */
describe('the phone lift for the notice bar', () => {
  /** styles.css with comments stripped, so a commented-out rule cannot satisfy a check. */
  const css = (): string => read('../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

  /** Every `.notice-bar { … bottom: … }` declaration, in source order. */
  const bottomDecls = () => [...css().matchAll(/\.notice-bar\s*\{[^}]*?\bbottom\s*:\s*([^;]+);/g)]
    .map((m) => ({ at: m.index ?? -1, value: (m[1] ?? '').trim() }));

  /** The two declarations, asserted present so the cases below can read them. */
  const twoDecls = (): [{ at: number; value: string }, { at: number; value: string }] => {
    const d = bottomDecls();
    expect(d).toHaveLength(2);
    return [d[0]!, d[1]!];
  };

  it('declares a bottom for .notice-bar in exactly two places', () => {
    // The base rule and the phone lift. A third would re-open the question of
    // which one wins, which is the whole defect.
    expect(bottomDecls()).toHaveLength(2);
  });

  it('puts the phone lift AFTER the unconditional rule, because order is the mechanism', () => {
    const [base, lift] = twoDecls();
    // The earlier one is the unconditional bottom: 0 …
    expect(base.value).toBe('0');
    // … and the later one is the lift, which only wins by being later.
    expect(lift.value).toMatch(/^calc\(76px/);
    expect(lift.at).toBeGreaterThan(base.at);
  });

  it('applies the lift only on a phone', () => {
    const text = css();
    const [, lift] = twoDecls();
    // The nearest @media opening before the lift must be the phone breakpoint.
    // Checked this way rather than by slicing a fixed window forward from a
    // media block — that window ran past the block's own closing brace and
    // reported a match from the rule after it.
    const opens = [...text.matchAll(/@media\s*\(([^)]*)\)\s*\{/g)]
      .filter((m) => (m.index ?? 0) < lift.at);
    expect(opens.at(-1)?.[1] ?? '').toContain('max-width: 767px');
  });

  it('keeps the phone workspace reserve in step with the bar it has to clear', () => {
    // Without --notice-h the last control in the workspace sits under an
    // expanded bar. .mmr-band-footer has carried this term for its own reserve
    // since it was written; the workspace did not.
    const text = css();
    const start = text.search(/@media\s*\(max-width:\s*767px\)[\s\S]*?\.workspace\s*\{/);
    expect(start).toBeGreaterThan(-1);
    const rule = /\.workspace\s*\{([^}]*)\}/.exec(text.slice(start))?.[1] ?? '';
    expect(rule).toMatch(/padding-bottom:\s*calc\(76px/);
    expect(rule).toContain('var(--notice-h, 0px)');
  });
});

/*
 * THE STALE-AUTOSAVE NOTICE DOES NOT OPEN THE BAR — the other half of what the
 * phone lift is for. The bar opens ITSELF for any new notice above `info`, and
 * the stale-autosave notice fires whenever the restored session's appVersion
 * differs from this build's, which is every returning user after every release;
 * at `warn` it opened the bar on most loads, and on a phone that bar was the one
 * covering the tabs.
 *
 * This file held both halves as regexes over App.tsx and NoticeBar.tsx. They
 * are behaviour now (audit 2026-09-22, row 477):
 *  - the notice's severity: services/notices.test.ts ("names a design restored
 *    from an older build as INFORMATION"), since the list moved out of App;
 *  - App, mounted on a session an older build wrote, puts it on the bar
 *    collapsed: App.render.test.tsx ("a design restored from an older build");
 *  - NoticeBar opens for a new problem and not for information:
 *    NoticeBar.test.tsx ("opens itself for a warning", "shows information
 *    collapsed", "still opens for a NEW problem"), which fail if the rule opens
 *    for `info` or stops opening for `warn` — mutation-checked both ways.
 * What stays here is the CSS, where order is the mechanism and no test in this
 * suite can render a pixel.
 */
