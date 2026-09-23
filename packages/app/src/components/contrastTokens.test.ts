// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_VARS } from '../services/schematicExport.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
/** styles.css with comments stripped, so a commented-out rule cannot satisfy a check. */
const css = read('../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * CONTRAST, computed from the stylesheet's own tokens (audit 2026-09-22, rows
 * 451 and 466), so a later token edit that breaks a ratio fails here rather
 * than on a sunlit field. WCAG 2.x relative luminance; a translucent layer is
 * composited over what it sits on first.
 *
 * What the audit measured, before: light --status-serious 3.20–3.95:1 on the
 * surfaces and 2.93:1 on the 2D stage (the CP callout); the floating chip's
 * "unstable" red 3.43:1 in Daylight and 3.57:1 in light; the fin editor's
 * hard-coded #c0392b 2.95:1 on the dark theme's panel; surface-1 on the accent
 * 4.32:1 in light, under a comment saying it passed; the picked row 1.06:1,
 * a tint and nothing else.
 */

/** The custom properties declared in the first block whose selector is exactly `sel`. */
function tokens(sel: string): Record<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  expect(at, `no block ${sel}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = tokens('.viz-root');
const THEMES: Record<string, Record<string, string>> = {
  light,
  dark: { ...light, ...tokens(".viz-root[data-theme='dark']") },
  daylight: { ...light, ...tokens(".viz-root[data-contrast='high']") },
};

/** The declaration block of the first rule whose selector list contains `sel`. */
function rule(sel: string): string {
  const at = css.indexOf(sel);
  expect(at, `no rule ${sel}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** The declaration blocks of EVERY rule whose selector list contains `sel`. */
function rules(sel: string): string[] {
  const out: string[] = [];
  for (let at = css.indexOf(sel); at > -1; at = css.indexOf(sel, at + 1)) {
    const open = css.indexOf('{', at);
    out.push(css.slice(open + 1, css.indexOf('}', open)));
  }
  return out;
}

type RGB = [number, number, number];
const rgb = (c: string): RGB => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${c}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as RGB;
};
const over = (fg: RGB, alpha: number, bg: RGB): RGB =>
  fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as RGB;
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const tok = (t: Record<string, string>, name: string): RGB => {
  const v = t[name];
  expect(v, `missing ${name}`).toBeDefined();
  const ref = /^var\((--[\w-]+)\)$/.exec(v!);
  return ref ? tok(t, ref[1]!) : rgb(v!);
};

/** The 2D stage behind the schematic: its gradient stops, and a grid line on the darkest. */
function stage(theme: string): RGB[] {
  if (theme === 'daylight') return [tok(THEMES.daylight!, '--surface-1')];
  const block = rule(theme === 'dark' ? ".viz-root[data-theme='dark'] .rocket-stage" : '.rocket-stage {');
  const stops = [...block.matchAll(/#[0-9a-f]{6}/gi)].map((m) => rgb(m[0]));
  const grid = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(block)!;
  const darkest = stops[stops.length - 1]!;
  return [...stops, over([+grid[1]!, +grid[2]!, +grid[3]!], +grid[4]!, darkest)];
}

const AA = 4.5;

describe('status text is AA on every surface it is drawn on (row 451)', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: --status-serious / -warn / -good on the surfaces and the 2D stage`, () => {
      const surfaces = ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--note-bg']
        .map((s) => tok(t, s));
      for (const s of ['--status-serious', '--status-warn', '--status-good']) {
        for (const bg of [...surfaces, ...stage(name)]) {
          expect(ratio(tok(t, s), bg), `${name} ${s} on ${bg.join(',')}`).toBeGreaterThanOrEqual(AA);
        }
      }
    });
  }

  it('the floating chip: every verdict and label over the lightest sky it floats on', () => {
    // A fixed dark card at 78 % over the stage — so over Daylight's white and
    // light's pale gradient it is a mid-grey, and that is where it fails.
    const bg = /\.stats-chip\s*\{[^}]*background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(css)!;
    const card: RGB = [+bg[1]!, +bg[2]!, +bg[3]!];
    const skies = [...stage('light'), ...stage('daylight'), ...stage('dark')]
      .map((s) => over(card, +bg[4]!, s));
    const inks: [string, string][] = [
      ...['good', 'warn', 'bad', 'unknown'].map((m): [string, string] =>
        [m, /color:\s*(#[0-9a-f]{6})/i.exec(rule(`.stats-chip-value.stability-${m}`))![1]!]),
      ['label', /color:\s*(#[0-9a-f]{6})/i.exec(rule('.stats-chip-label {'))![1]!],
      ['fold', /color:\s*(#[0-9a-f]{6})/i.exec(rule('.stats-chip-fold {'))![1]!],
    ];
    for (const [what, ink] of inks) {
      for (const sky of skies) {
        expect(ratio(rgb(ink), sky), `chip ${what} ${ink}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});

describe('row 466', () => {
  it('the fin editor draws its refusal in the status token, not a hard-coded red', () => {
    const src = read('FinPointsEditor.tsx');
    expect(src).not.toMatch(/#c0392b/i);
    expect(src).toMatch(/role="alert" style=\{\{ fontSize: 11, color: 'var\(--status-serious\)'/);
  });

  it('text on the accent is --surface-3, and passes in every theme', () => {
    for (const sel of ['.file-btn-primary {', '.version-update {', '.tour-next {',
      '.guide-toc-item.active {', '.hc-toggle.hc-on {']) {
      // Every rule for the selector: .version-update also has a shared block
      // with .version-ok that sets no colour.
      const colours = rules(sel)
        .flatMap((b) => [...b.matchAll(/(?:^|[;\s])color:\s*([^;]+);/g)].map((c) => c[1]!.trim()));
      expect(colours, sel).toEqual(['var(--surface-3)']);
    }
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--surface-3'), tok(t, '--accent')), name).toBeGreaterThanOrEqual(AA);
    }
  });

  it('a picked or selected table row is marked by more than a tint', () => {
    // The tint alone is 1.06:1 in light. The cue is an accent bar, which as a
    // graphic needs 3:1 against the tint it sits on (WCAG 1.4.11).
    const bar = rule('.motor-row-picked td:first-child');
    expect(bar).toMatch(/box-shadow:\s*inset\s+3px\s+0\s+0\s+var\(--accent\)/);
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--accent'), tok(t, '--selected')), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('the schematic export bakes the light theme\'s own status and launch tokens', () => {
    // The exported SVG is drawn on white in the light palette — so when the
    // tokens moved, the baked copies had to move with them.
    const baked = new Map(EXPORT_VARS);
    for (const s of ['--status-serious', '--status-warn', '--status-good', '--launch']) {
      expect(baked.get(`var(${s})`), s).toBe(light[s]);
    }
  });
});

describe('the Launch orange under its white label', () => {
  /**
   * Review of the audit branch: the Launch button (17 px bold — "large" text
   * starts at 18.66 px bold) and the active 2D/3D/Aft toggle put #fff on
   * --launch #c65420, 4.48:1, in light and dark alike.
   */
  it('white on --launch is AA in every theme, wherever it is the background', () => {
    for (const sel of ['.launch-btn {', '.view-toggle button.active {']) {
      const block = rule(sel);
      expect(block, sel).toMatch(/background:\s*var\(--launch\)/);
      expect(block, sel).toMatch(/(^|[;\s])color:\s*#fff(fff)?;/);
    }
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(rgb('#ffffff'), tok(t, '--launch')), name).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('small controls are at least 24 × 24 px (row 467)', () => {
  const px = (block: string, prop: string): number => {
    const m = new RegExp(`(^|[;\\s])${prop}:\\s*(\\d+)px`).exec(block);
    return m ? Number(m[2]) : 0;
  };
  for (const sel of ['.tree-actions button {', '.roll-reset {', '.finish-all-btn {']) {
    it(sel.replace(' {', ''), () => {
      const block = rule(sel);
      expect(Math.max(px(block, 'min-width'), px(block, 'width')), `${sel} width`).toBeGreaterThanOrEqual(24);
      expect(Math.max(px(block, 'min-height'), px(block, 'height')), `${sel} height`).toBeGreaterThanOrEqual(24);
    });
  }
});
