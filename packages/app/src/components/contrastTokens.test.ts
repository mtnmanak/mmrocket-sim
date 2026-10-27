// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXPORT_VARS } from '../services/schematicExport.js';
import { NoticeBar, type Notice } from './NoticeBar.js';
import { ImpulseBadge } from './MotorBrowser.js';
import { SiteBand, SiteBandFooter } from './SiteBand.js';
import { installFatalErrorBar } from '../services/fatalErrorBar.js';
import { MMR_NAV_FALLBACK } from '../services/useMmrNav.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
/**
 * THE BRAND LAYER (brand v1). Since mmr-brand 1.0.2 the app's roles are
 * aliases of brand tokens (`--surface-0: var(--mmr-bg)`), defined in the
 * vendored public/brand/tokens.css and chart.css, which index.html links
 * before styles.css. The tokens resolve per theme on .viz-root: LIGHT values
 * (`:root` / `[data-theme="light"]`) for light and for Daylight — which sets
 * data-theme="light" — and the `[data-theme="dark"]` values for dark. The
 * OS-preference @media copy is skipped: the app always sets data-theme.
 */
function brandTokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const text = ['tokens.css', 'chart.css']
    .map((f) => read(`../../public/brand/${f}`)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const lightT: Record<string, string> = {};
  const darkT: Record<string, string> = {};
  let depth = 0;
  for (const m of text.matchAll(/([^{}]*)\{|\}/g)) {
    if (m[0] === '}') { depth--; continue; }
    const prelude = m[1]!.trim();
    depth++;
    if (depth !== 1 || prelude.startsWith('@')) continue;
    const open = m.index! + m[0].length;
    const body = text.slice(open, text.indexOf('}', open));
    const sels = prelude.split(',').map((s) => s.trim());
    const decls = Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()]));
    if (sels.some((s) => s === ':root' || s === '[data-theme="light"]')) Object.assign(lightT, decls);
    if (sels.includes('[data-theme="dark"]')) Object.assign(darkT, decls);
  }
  return { light: lightT, dark: { ...lightT, ...darkT } };
}
const BRAND = brandTokens();

const light = tokens('.viz-root');
const THEMES: Record<string, Record<string, string>> = {
  light: { ...BRAND.light, ...light },
  dark: { ...BRAND.dark, ...light, ...tokens(".viz-root[data-theme='dark']") },
  daylight: { ...BRAND.light, ...light, ...tokens(".viz-root[data-contrast='high']") },
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
/** A colour expression (hex, var() chains into the brand tokens, color-mix) resolved under `t`. */
const colourIn = (t: Record<string, string>, value: string): RGBA => {
  const resolved = resolveVars(value, t);
  expect(resolved, `unresolved in ${value}`).not.toContain('__missing');
  const c = parseColour(resolved);
  if (!c) throw new Error(`not a colour: ${value} → ${resolved}`);
  return c;
};
/** An opaque role, resolved through the brand tokens. */
const tok = (t: Record<string, string>, name: string): RGB => {
  expect(t[name], `missing ${name}`).toBeDefined();
  const c = colourIn(t, `var(${name})`);
  expect(c[3], `${name} is not opaque`).toBe(1);
  return c.slice(0, 3) as RGB;
};
const hex = (c: RGB) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/**
 * A role that may be TRANSLUCENT — since mmr-brand 1.1.0 the callout and tint
 * roles are the brand's -soft tokens (8-digit hex) — composited over the
 * ground it is painted on. An opaque role comes back unchanged.
 */
const fillOver = (t: Record<string, string>, name: string, ground: RGB): RGB => {
  const c = colourIn(t, `var(${name})`);
  return over(c.slice(0, 3) as RGB, c[3], ground);
};
/** The two grounds a tint may carry coloured text over (SPEC §3.1): the page and a panel. */
const PAGE_AND_PANEL = ['--surface-0', '--surface-2'] as const;
/** A declaration's value in a block, e.g. decl(rule('.x {'), 'background-color'). */
const decl = (block: string, prop: string): string => {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(block);
  expect(m, `no ${prop} in { ${block.trim().slice(0, 120)} }`).not.toBeNull();
  return m![1]!.trim();
};

/**
 * The 2D stage behind the schematic, FLAT since brand v1 (SPEC §7.2): its
 * ground, and a drafting-grid line composited over that ground.
 */
function stage(theme: string): RGB[] {
  const t = THEMES[theme]!;
  if (theme === 'daylight') return [tok(t, '--surface-1')];
  const base = rule('.rocket-stage {');
  const ground = colourIn(t, decl(theme === 'dark' ? rule(".viz-root[data-theme='dark'] .rocket-stage") : base,
    'background-color'));
  expect(ground[3], 'the stage ground is opaque').toBe(1);
  const grid = /linear-gradient\((color-mix\([^()]*(?:\([^()]*\)[^()]*)*\))\s+1px/.exec(base);
  expect(grid, 'the grid line colour').not.toBeNull();
  const line = colourIn(t, grid![1]!);
  const g = ground.slice(0, 3) as RGB;
  return [g, over(line.slice(0, 3) as RGB, line[3], g)];
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

  it('the floating chip and mount pill: every verdict and label over every stage they float on', () => {
    // A fixed navy card (brand primitives, so the same in every theme) at 92 %
    // over the stage — over Daylight's white it is lightest, and that is where
    // it would fail first (at 85 % the 1.0.2 danger-dark was 4.28:1, brand v1
    // table D; 1.0.3's #FF9EA5 is 6.17:1 at 92 %).
    const primitives = THEMES.light!;
    const skies = [...stage('light'), ...stage('daylight'), ...stage('dark')];
    for (const sel of ['.stats-chip {', '.hero-mounts {']) {
      const card = colourIn(primitives, decl(rule(sel), 'background'));
      expect(card[3], `${sel} alpha`).toBeGreaterThanOrEqual(0.92);
      const grounds = skies.map((s) => over(card.slice(0, 3) as RGB, card[3], s));
      const inks: [string, string][] = sel === '.hero-mounts {'
        ? [['mount pill', decl(rule(sel), 'color')]]
        : [
          ...['good', 'warn', 'bad', 'unknown'].map((m): [string, string] =>
            [m, decl(rule(`.stats-chip-value.stability-${m}`), 'color')]),
          ['label', decl(rule('.stats-chip-label {'), 'color')],
          ['fold', decl(rule('.stats-chip-fold {'), 'color')],
          ['value', decl(rule('.stats-chip-value {'), 'color')],
        ];
      for (const [what, ink] of inks) {
        const c = colourIn(primitives, ink).slice(0, 3) as RGB;
        for (const g of grounds) {
          expect(ratio(c, g), `${sel} ${what} ${ink} on ${hex(g)}`).toBeGreaterThanOrEqual(AA);
        }
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

  /**
   * LABELS ON A FILL (re-pinned for brand v1, D2). Until v0.194 six controls
   * wore the orange fill with --surface-3 as their label. The brand allows
   * one orange primary per screen, so the fill is now only Launch, a dialog's
   * own primary and the tour's Next — labelled --on-accent (white on #BB4100
   * light, NAVY on #FF6509 dark: white there is 2.95:1) — and the guide's
   * active TOC item, its current search match and the Daylight-on toggle take
   * the SELECTED treatment: --text-primary on the --selected tint, plus a
   * shape (bar, ring or underline) and weight. Every rule for each selector
   * is checked, so a Daylight restatement cannot slip a different ink in.
   */
  const LABEL_ON_FILL: [selector: string, colour: string, fill: string][] = [
    ['.launch-btn {', 'var(--on-accent)', 'var(--launch)'],
    [":is([role='dialog'], .modal-card, .prefs-dialog) .file-btn-primary {", 'var(--on-accent)', 'var(--launch)'],
    ['.tour-next {', 'var(--on-accent)', 'var(--launch)'],
    ['.guide-toc-item.active {', 'var(--text-primary)', 'var(--selected)'],
    ['.guide-content .guide-match-current {', 'var(--text-primary)', 'var(--selected)'],
    ['.hc-toggle.hc-on {', 'var(--text-primary)', 'var(--selected)'],
  ];
  const colours = (sel: string) => rules(sel)
    .flatMap((b) => [...b.matchAll(/(?:^|[;\s])color:\s*([^;]+);/g)].map((c) => c[1]!.trim()));

  it('every label on a fill is its pair\'s ink, and passes AA in every theme', () => {
    for (const [sel, colour, fill] of LABEL_ON_FILL) {
      const inks = colours(sel);
      expect(inks.length, sel).toBeGreaterThan(0);
      expect(new Set(inks), sel).toEqual(new Set([colour]));
      expect(decl(rule(sel), 'background'), sel).toBe(fill);
      for (const [name, t] of Object.entries(THEMES)) {
        const r = ratio(colourIn(t, colour).slice(0, 3) as RGB, colourIn(t, fill).slice(0, 3) as RGB);
        expect(r, `${name} ${sel}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('the orange FILL belongs to the primary action alone (D2)', () => {
    // Every rule that paints a background from the Launch ramp.
    const filled = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /background(?:-color)?:\s*var\(--launch(?:-hover|-active)?\)/.test(m[2]!))
      .flatMap((m) => splitTop(m[1]!.trim()));
    const allowed = /^(\.launch-btn|:is\(\[role='dialog'\], \.modal-card, \.prefs-dialog\) \.file-btn-primary|\.tour-next)(:hover|:active)?(:not\([^)]*\))*$/;
    expect(filled.filter((s) => !allowed.test(s))).toEqual([]);
    // And no fill is painted in the accent's WORD colour or the bare alias.
    // (--accent-graphic may fill a state mark: the batch progress bar.)
    expect(css).not.toMatch(/background(?:-color)?:\s*var\(--accent(?:-text)?\)/);
  });

  it('the version-update badge is an outlined pill, not a second fill', () => {
    const block = rules('.version-update {').find((b) => /(?:^|[;\s])color:/.test(b))!;
    expect(decl(block, 'color')).toBe('var(--accent-text)');
    expect(decl(block, 'background')).toBe('transparent');
    expect(decl(block, 'border-color')).toBe('var(--accent-graphic)');
    for (const [name, t] of Object.entries(THEMES)) {
      // It sits in the header, on the page ground.
      expect(ratio(tok(t, '--accent-text'), tok(t, '--surface-0')), name).toBeGreaterThanOrEqual(AA);
      expect(ratio(tok(t, '--accent-graphic'), tok(t, '--surface-0')), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('the active 2D/3D/Aft segment and workspace tab are marked by shape and weight, not a fill', () => {
    const seg = rule('.view-toggle button.active {');
    expect(seg).not.toMatch(/var\(--launch/);
    expect(decl(seg, 'color')).toBe('var(--text-primary)');
    expect(decl(seg, 'box-shadow')).toBe('inset 0 -2px 0 var(--accent-graphic)');
    expect(Number(decl(seg, 'font-weight'))).toBeGreaterThanOrEqual(600);
    const tab = rule('.workspace-tabs button.active {');
    expect(decl(tab, 'color')).toBe('var(--accent-text)');
    expect(decl(tab, 'border-bottom-color')).toBe('var(--accent-graphic)');
    expect(Number(decl(tab, 'font-weight'))).toBeGreaterThanOrEqual(600);
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--accent-graphic'), tok(t, '--surface-3')), `${name} segment underline`).toBeGreaterThanOrEqual(3);
      expect(ratio(tok(t, '--accent-text'), tok(t, '--surface-0')), `${name} tab label`).toBeGreaterThanOrEqual(AA);
      expect(ratio(tok(t, '--accent-graphic'), tok(t, '--surface-0')), `${name} tab underline`).toBeGreaterThanOrEqual(3);
    }
  });

  it('a picked or selected row is marked by more than a tint', () => {
    // The tint alone is 1.17:1 from hover (it was 1.06:1 against the table in
    // light before brand v1). The cue is an --accent-graphic bar, which as a
    // graphic needs 3:1 against the tint it sits on (WCAG 1.4.11).
    for (const sel of ['.motor-row-picked td:first-child', '.tree-row-selected,']) {
      expect(decl(rule(sel), 'box-shadow'), sel).toBe('inset 3px 0 0 var(--accent-graphic)');
    }
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--accent-graphic'), tok(t, '--selected')), name).toBeGreaterThanOrEqual(3);
      // The selected row's own text stays AA on the tint.
      for (const ink of ['--text-primary', '--text-secondary']) {
        expect(ratio(tok(t, ink), tok(t, '--selected')), `${name} ${ink}`).toBeGreaterThanOrEqual(AA);
      }
      // And the status inks a picked row can carry (the run-history verdict
      // cell, SimResults), AA in every theme. Re-pinned for mmr-brand 1.0.3:
      // dark --status-serious was held to 3 (the 1.0.2 #FF8A93 was 4.38:1 on
      // the dark tint, so only the cell's aria-hidden glyph could carry it);
      // 1.0.3's #FF9EA5 is 5.02:1, so it is held to AA like every other ink.
      for (const ink of ['--status-good', '--status-warn', '--status-serious']) {
        expect(ratio(tok(t, ink), tok(t, '--selected')), `${name} ${ink} on --selected`).toBeGreaterThanOrEqual(AA);
      }
    }
    const history = read('SimResults.tsx');
    expect(history).toMatch(/<td className=\{r\.importedSummary \? undefined : unsafe \? 'stability-bad'[^\n]*\n\s*<span aria-hidden="true">[^\n]*\n\s*<span className="sr-only">/);
  });

  it('the schematic export bakes the light theme\'s own status and launch colours', () => {
    // The exported SVG is drawn on white in the light palette — so when the
    // tokens moved, the baked copies had to move with them. Since brand v1 the
    // light roles are brand aliases, so the comparison is on resolved colour.
    const baked = new Map(EXPORT_VARS);
    for (const s of ['--status-serious', '--status-warn', '--status-good', '--launch']) {
      expect(baked.get(`var(${s})`)?.toLowerCase(), s).toBe(hex(tok(THEMES.light!, s)));
    }
  });
});

describe('the Launch fill under its label, at rest, hovered and pressed', () => {
  /**
   * The Launch button is 17 px semibold — under "large" text — so its label
   * needs AA on every step of the ramp. Hovers used to be brightness(1.08),
   * a colour nobody measured; they are now the brand ramp itself.
   */
  it('--on-accent is AA on --launch, --launch-hover and --launch-active in every theme', () => {
    expect(rule('.launch-btn:hover:not(:disabled) {')).toMatch(/background:\s*var\(--launch-hover\)/);
    expect(rule('.launch-btn:active:not(:disabled) {')).toMatch(/background:\s*var\(--launch-active\)/);
    expect(css).not.toMatch(/brightness\(/);
    for (const [name, t] of Object.entries(THEMES)) {
      for (const fill of ['--launch', '--launch-hover', '--launch-active']) {
        expect(ratio(tok(t, '--on-accent'), tok(t, fill)), `${name} ${fill}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});

describe('brand v1: links, focus, inputs, callouts and the site strip', () => {
  it('every ink a neutral note carries reads on --note-bg (dark: navy-high again, mmr-brand 1.0.3)', () => {
    // Table A puts notes, the notice bar and the tour card on --mmr-surface-2
    // in both themes. Dark sat on navy while the 1.0.2 danger-dark measured
    // 4.31:1 on navy-high; 1.0.3 lifted it to 4.95, so the table's surface is
    // back, and everything a note can write on it is re-measured here: body,
    // muted, link, orange words and the three status inks at AA, the focus
    // ring and the tour card's --accent-graphic edge at 3:1.
    expect(THEMES.dark!['--note-bg']).toBe('var(--mmr-surface-2)');
    expect(THEMES.light!['--note-bg']).toBe('var(--mmr-surface-2)');
    expect(decl(rule('.tour-card {'), 'border')).toBe('1.5px solid var(--accent-graphic)');
    for (const [name, t] of Object.entries(THEMES)) {
      const bg = tok(t, '--note-bg');
      for (const ink of ['--text-primary', '--text-secondary', '--text-muted', '--link', '--accent-text',
        '--status-good', '--status-warn', '--status-serious']) {
        expect(ratio(tok(t, ink), bg), `${name} ${ink} on --note-bg`).toBeGreaterThanOrEqual(AA);
      }
      for (const g of ['--focus', '--accent-graphic']) {
        expect(ratio(tok(t, g), bg), `${name} ${g} on --note-bg`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('danger and error states draw from the danger token alone, never a hex (mmr-brand 1.0.3 audit)', () => {
    // Every rule before the Daylight block whose selector names a danger,
    // error, invalid, refused or failed state. Its colours are tokens: the
    // danger red itself only through --status-serious (= --mmr-danger) or the
    // --callout-danger-* pair, or, on the fixed navy chip, the dark primitive.
    const start = css.search(/\n\.viz-root\[data-contrast='high'\]\s*\{/);
    const states = [...css.slice(0, start).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /danger|error|invalid|-bad\b|refused|serious|failed/.test(m[1]!));
    expect(states.length).toBeGreaterThanOrEqual(15);
    // The one hex allowed: the tier's var() fallback, which is the fatal-error
    // bar's fill OUTSIDE .viz-root (fatalErrorBar.ts) and must equal the
    // light theme's resolved token, so it cannot drift from the brand.
    // Re-pinned for mmr-brand 1.1.0: the light fill is a translucent tint and
    // the bar must be opaque, so the fallback is that tint composited on white
    // (the light panel) — the fill a light danger note shows on a panel.
    const fallback = /var\((--callout-(?:danger|caution)-(?:bg|fg)),\s*(#[0-9a-f]{6})\)/gi;
    for (const [, sel, body] of states) {
      for (const f of body!.matchAll(fallback)) {
        expect(f[2]!.toLowerCase(), `${sel!.trim()} ${f[1]} fallback`)
          .toBe(hex(fillOver(THEMES.light!, f[1]!, tok(THEMES.light!, '--surface-2'))));
      }
      for (const d of body!.replace(fallback, 'var($1)').matchAll(/(?:^|[;\s])((?:color|background|border[\w-]*|box-shadow|outline|fill|stroke)\s*:\s*[^;]+);/g)) {
        expect(d[1], sel!.trim()).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\bred\b/i);
        const reds = [...d[1]!.matchAll(/var\((--[\w-]+)/g)].map((v) => v[1]!)
          .filter((v) => /danger|serious/.test(v));
        for (const v of reds) expect(['--status-serious', '--callout-danger-bg', '--callout-danger-fg', '--tint-danger', '--mmr-c-danger-dark'], `${sel!.trim()} ${v}`).toContain(v);
      }
    }
    // --status-serious IS the brand danger token in light and dark (Daylight
    // keeps its own darker set, D8).
    expect(THEMES.light!['--status-serious']).toBe('var(--mmr-danger)');
    expect(tokens(".viz-root[data-theme='dark']")['--status-serious']).toBe('var(--mmr-danger)');
    expect(hex(tok(THEMES.dark!, '--status-serious'))).toBe('#ff9ea5');
  });

  it('dark danger reads on every dark ground a danger state is drawn on', () => {
    // The 1.0.3 audit's grounds: navy (page, wells, the fin editor, the 2D
    // stage and its grid), navy-raised (panels, tiles, modals, fields),
    // navy-high (hovered rows, notes), the selected tint (a picked run), its
    // own 12 % tint over the panel (callouts, error notes, the notice bar, a
    // hovered danger button) and the caution tint (an error glyph in a warn
    // bar). Text at AA everywhere.
    const t = THEMES.dark!;
    const red = tok(t, '--status-serious');
    const panel = tok(t, '--surface-2');
    const grounds: [string, RGB][] = [
      ['--surface-0', tok(t, '--surface-0')], ['--surface-1', tok(t, '--surface-1')],
      ['--surface-2', panel], ['--field-bg', tok(t, '--field-bg')], ['--hover', tok(t, '--hover')],
      ['--note-bg', tok(t, '--note-bg')], ['--selected', tok(t, '--selected')],
      ['danger tint', over(red, 0.12, panel)], ['caution tint', over(tok(t, '--status-warn'), 0.15, panel)],
      ...stage('dark').map((g, i): [string, RGB] => [`stage ${i}`, g]),
    ];
    for (const [what, g] of grounds) {
      expect(ratio(red, g), `dark danger on ${what} ${hex(g)}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('links and the one focus ring read on every ground they meet', () => {
    expect(decl(rule('.viz-root a {'), 'color')).toBe('var(--link)');
    for (const [name, t] of Object.entries(THEMES)) {
      for (const g of ['--surface-0', '--surface-2', '--note-bg']) {
        expect(ratio(tok(t, '--link'), tok(t, g)), `${name} link on ${g}`).toBeGreaterThanOrEqual(AA);
        expect(ratio(tok(t, '--focus'), tok(t, g)), `${name} focus on ${g}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio(tok(t, '--focus'), tok(t, '--hover')), `${name} focus on hover`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every focus ring is the one --focus ring, 3px, except rings on a SOLID coloured fill', () => {
    // A ring on a solid coloured fill takes the fill's own ink: Daylight's
    // filled tiers (#006AAB on the #970F21 danger box would vanish) and the
    // fatal bar, outside the theme subtree; the band rings are sky on navy.
    // In light and dark the tiers and the launch-override callout are TINTS
    // (D3), so their rings are the --focus ring like every other (re-pinned
    // in the lane S fix pass: the exemption was the whole of `message-tier`
    // and `launch-override-callout`, which hid two 2px/ink rings on tints).
    const rings = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /:focus/.test(m[1]!) && /(?:^|[;\s])outline:/.test(m[2]!));
    const exempt = /\[data-contrast='high'\] \.message-tier|fatal-error|mmr-band/;
    for (const [, sel, body] of rings) {
      if (exempt.test(sel!) || /outline:\s*none/.test(body!)) continue;
      expect(decl(body!, 'outline'), sel!.trim()).toBe('3px solid var(--focus)');
    }
    // An outline that is not a focus rule but is switched on BY focus: a
    // flight-series legend chip turns emphasis on in onFocus, and the
    // emphasis outline ties the global ring at (0,2,0) and comes later.
    expect(decl(rule('.flight-series-legend .series-emphasized:focus-visible {'), 'outline')).toBe('3px solid var(--focus)');
    expect(css.indexOf('.flight-series-legend .series-emphasized:focus-visible'))
      .toBeGreaterThan(css.indexOf('.flight-series-legend .series-emphasized {'));
    // The ring reads on the callout tints themselves (light, dark) and on
    // Daylight's solid caution box, where the launch-override button sits.
    // Re-pinned for mmr-brand 1.1.0: the tints are translucent, so each is
    // composited over the page and the panel it can sit on.
    for (const [name, t] of Object.entries(THEMES)) {
      const fills = name === 'daylight' ? ['--callout-caution-bg'] : ['--callout-caution-bg', '--callout-danger-bg'];
      for (const f of fills) {
        for (const g of PAGE_AND_PANEL) {
          expect(ratio(tok(t, '--focus'), fillOver(t, f, tok(t, g))), `${name} focus on ${f} over ${g}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('input, select and textarea edges clear 3:1 on their fill in every theme', () => {
    const fields = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background:\s*var\(--field-bg\)/.test(m[2]!));
    expect(fields.length).toBeGreaterThanOrEqual(7);
    for (const [, sel, body] of fields) expect(body, sel!.trim()).toMatch(/border:\s*1px solid var\(--border-control\)/);
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--border-control'), tok(t, '--field-bg')), name).toBeGreaterThanOrEqual(3);
      expect(ratio(tok(t, '--text-primary'), tok(t, '--field-bg')), name).toBeGreaterThanOrEqual(AA);
    }
  });

  it('callouts are tinted (D3) with no left stripe, and their text pairs pass', () => {
    // SPEC §4.3 / §7.2: tinted callouts, never a left-border stripe.
    expect(css).not.toMatch(/border-left(?:-color|-width|-style)?\s*:/);
    // Re-pinned for mmr-brand 1.1.0: the hand-mixed color-mix() tints became
    // the brand's -soft tokens (through the app's --tint-* roles), which are
    // TRANSLUCENT — so the pairs are measured over each ground a callout sits
    // on (the page and a panel), not over the panel alone.
    for (const sel of ['.field-caution {', '.file-note-warn {', '.fly-stale {', '.override-inert {']) {
      expect(decl(rule(sel), 'background'), sel).toBe('var(--tint-warn)');
    }
    expect(decl(rule('.file-note-error {'), 'background')).toBe('var(--tint-danger)');
    for (const [name, t] of Object.entries(THEMES)) {
      for (const g of PAGE_AND_PANEL) {
        for (const tint of ['--tint-warn', '--tint-danger']) {
          const bg = fillOver(t, tint, tok(t, g));
          for (const ink of ['--text-primary', '--text-secondary', '--text-muted']) {
            expect(ratio(tok(t, ink), bg), `${name} ${ink} on ${tint} over ${g}`).toBeGreaterThanOrEqual(AA);
          }
          expect(ratio(tok(t, '--focus'), bg), `${name} focus on ${tint} over ${g}`).toBeGreaterThanOrEqual(3);
        }
        // The filled-tier tokens: AA for the body (the 7:1 floor is checked below).
        for (const tier of ['caution', 'danger']) {
          expect(ratio(tok(t, `--callout-${tier}-fg`), fillOver(t, `--callout-${tier}-bg`, tok(t, g))), `${name} ${tier} over ${g}`)
            .toBeGreaterThanOrEqual(AA);
        }
      }
    }
  });

  it('the site strip is navy in every theme: text, hover, placeholder, edge and ring all read on it', () => {
    const band = rule('.mmr-band {');
    expect(decl(band, 'background')).toBe('var(--mmr-c-navy)');
    expect(decl(band, 'border-bottom')).toBe('1px solid var(--mmr-c-line-dark)');
    expect(decl(band, 'color-scheme')).toBe('dark');
    const footer = rule('.mmr-band-footer {');
    expect(decl(footer, 'background')).toBe('var(--mmr-c-navy)');
    const pairs: [string, string, string, number][] = [
      ['band links', decl(rule('.viz-root .mmr-band a {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['band hover', decl(rule('.viz-root .mmr-band a:hover {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['footer line', decl(footer, 'color'), 'var(--mmr-c-navy)', AA],
      ['footer links', decl(rule('.viz-root .mmr-band-footer a {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['footer hover', decl(rule('.viz-root .mmr-band-footer a:hover {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['search text', decl(rule('.mmr-band-search input {'), 'color'), decl(rule('.mmr-band-search input {'), 'background'), AA],
      ['placeholder', decl(rule('.mmr-band-search input::placeholder {'), 'color'), decl(rule('.mmr-band-search input {'), 'background'), AA],
      ['search button', decl(rule('.mmr-band-search button {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['search hover', decl(rule('.mmr-band-search button:hover {'), 'color'), 'var(--mmr-c-navy)', AA],
      ['search edge', decl(rule('.mmr-band-search input {'), 'border').replace(/^1px solid /, ''), decl(rule('.mmr-band-search input {'), 'background'), 3],
      ['rule', 'var(--mmr-c-line-dark)', 'var(--mmr-c-navy)', 3],
      ['ring', decl(rule('.viz-root .mmr-band :focus-visible,'), 'outline').replace(/^3px solid /, ''), 'var(--mmr-c-navy)', 3],
    ];
    // Primitives: identical in every theme, so any theme's table resolves them.
    for (const [what, fg, bg, need] of pairs) {
      expect(fg, what).toMatch(/^var\(--mmr-c-/);
      const r = ratio(colourIn(THEMES.light!, fg).slice(0, 3) as RGB, colourIn(THEMES.light!, bg).slice(0, 3) as RGB);
      expect(r, `${what} ${fg} on ${bg}`).toBeGreaterThanOrEqual(need);
    }
    // Daylight's own ring (0,3,0) is the theme blue, 2.64:1 on navy: the band's
    // ring is restated inside the Daylight block at (0,4,0), and the band's
    // search box is not given Daylight's black control edge (1.74:1 on navy).
    expect(decl(rule(".viz-root[data-contrast='high'] .mmr-band :focus-visible,"), 'outline')).toBe('3px solid var(--mmr-c-sky)');
    expect(css.lastIndexOf(".viz-root[data-contrast='high'] .mmr-band :focus-visible"))
      .toBeGreaterThan(css.lastIndexOf(".viz-root[data-contrast='high'] :focus-visible"));
    expect(css).not.toContain(".viz-root[data-contrast='high'] .mmr-band-search input");
  });

  it('the Daylight block is the last thing in the stylesheet', () => {
    const start = css.search(/\n\.viz-root\[data-contrast='high'\]\s*\{/);
    expect(start).toBeGreaterThan(-1);
    const after = css.slice(start);
    // Every rule from the Daylight token block to the end is a Daylight rule.
    for (const m of after.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const s of splitTop(m[1]!.trim())) expect(s, 'a non-Daylight rule after the Daylight block').toMatch(/^\.viz-root\[data-contrast='high'\]/);
    }
    // And nothing before it carries a Daylight selector.
    expect(css.slice(0, start)).not.toMatch(/\.viz-root\[data-contrast='high'\]\s*[^{]*\{/);
  });
});

describe('launch override callout contrast', () => {
  // Re-pinned for mmr-brand 1.1.0: the fills are translucent tints in light
  // and dark, so the 7:1 floor is held over every ground they can sit on —
  // the vitals strip and panels (--surface-2), the Fly screen's page
  // (--surface-0) — and over brand surface-2 too, where SPEC §3.1 measures
  // the text ink on any tint at >= 7.01.
  const GROUNDS = ['--surface-0', '--surface-2', '--note-bg', '--hover'];
  it('Danger has at least 7:1 contrast in Light, Dark and Daylight', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      for (const g of GROUNDS) {
        expect(ratio(tok(t, '--callout-danger-fg'), fillOver(t, '--callout-danger-bg', tok(t, g))), `${name} over ${g}`)
          .toBeGreaterThanOrEqual(7);
      }
    }
  });
  it('near-black text and Show outlines have at least 7:1 contrast on the caution fill in every theme', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      for (const g of GROUNDS) {
        expect(ratio(tok(t, '--callout-caution-fg'), fillOver(t, '--callout-caution-bg', tok(t, g))), `${name} over ${g}`)
          .toBeGreaterThanOrEqual(7);
      }
    }
  });
  it('the Show button\'s focus ring reads on the callout over every ground (3:1)', () => {
    // #006AAB 4.42 / 4.62 over paper / white; sky 6.10 / 4.85 over navy /
    // navy-raised; Daylight's solid amber 3.94. The callout's comment quotes these.
    expect(decl(rule('.viz-root .launch-override-callout button.file-btn:focus-visible {'), 'outline')).toBe('3px solid var(--focus)');
    for (const [name, t] of Object.entries(THEMES)) {
      for (const g of GROUNDS) {
        expect(ratio(tok(t, '--focus'), fillOver(t, '--callout-caution-bg', tok(t, g))), `${name} ring over ${g}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });
  it('the hovered Show button inverts to the callout ink under the panel colour, never the translucent tint', () => {
    const hover = rule('.viz-root .launch-override-callout button.file-btn:hover {');
    expect(decl(hover, 'background')).toBe('var(--callout-caution-fg)');
    expect(decl(hover, 'color')).toBe('var(--surface-2)');
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--surface-2'), tok(t, '--callout-caution-fg')), name).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('NOTES-1 supporting text and startup contrast', () => {
  it('NoticeBar counts and stale gust text clear 4.5:1 including the old failing Dark mixtures', () => {
    expect(rules('.notice-count').join('\n')).toContain('color: var(--text-secondary)');
    expect(rules('.gust-estimate-muted').at(-1)).toContain('color: var(--text-secondary)');
    for (const [name, t] of Object.entries(THEMES)) {
      const panel = tok(t, '--surface-2');
      // Brand v1 (D3): the warn tints are 15 % (they were 10 % and 8 %), the
      // serious ones 12 %, all over the panel surface; and the note surface.
      for (const bg of [panel, over(tok(t, '--status-warn'), 0.15, panel),
        over(tok(t, '--status-serious'), 0.12, panel), tok(t, '--note-bg')]) {
        expect(ratio(tok(t, '--text-secondary'), bg), name).toBeGreaterThanOrEqual(AA);
      }
    }
  });
  it('the fatal bar supplies its own 7:1 fill outside the theme subtree', () => {
    const stop = installFatalErrorBar();
    try {
      stop.report('Startup error');
      const bar = document.querySelector('.fatal-error-bar')!;
      expect(bar.textContent).toContain('Danger: Something went wrong');
      expect(bar.closest('.viz-root')).toBeNull();
      const foreground = resolveVars(winning(bar, ['color'])!.value, {});
      const background = resolveVars(winning(bar, ['background', 'background-color'])!.value, {});
      expect(ratio(rgb(foreground), rgb(background))).toBeGreaterThanOrEqual(7);
      for (const theme of Object.values(THEMES)) {
        for (const element of [bar, ...bar.querySelectorAll('p, strong, button')]) {
          const colours = ink(element, theme, new Map());
          expect(ratio(colours.colour.slice(0, 3) as RGB, colours.bg.slice(0, 3) as RGB)).toBeGreaterThanOrEqual(7);
        }
      }
    } finally { stop(); }
  });
  it('filled blocks defeat supporting prose in Daylight and retain a forced-colors border', () => {
    expect(rule('.message-tier.message-tier.message-danger')).toContain('color: var(--callout-danger-fg');
    expect(rule('.message-tier.message-tier.message-caution')).toContain('color: var(--callout-caution-fg');
    expect(rule('.message-tier.message-tier .simdet-comments')).toContain('color: inherit');
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.message-tier\.message-tier\.message-tier\s*\{[^}]*background: Canvas;[^}]*color: CanvasText;[^}]*border: 2px solid CanvasText;/);
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

/* ===================================================================
   EVERY DESCENDANT OF A FILLED TIER, NOT ONLY THE ONES SOMEONE LISTED
   (review of NOTES-1, findings 1, 2, 3 and 6). The fill pair passes; what
   failed was a child that kept its own colour on top of it — the stale
   weather line (`div.weather-stale`, #f0efec on the Dark amber fill,
   1.27:1), the pad-mass figure (`span.measured-delta`, the accent on amber),
   the failed run-save × (and the block's padding, which no longer kept room
   for it), and the NoticeBar glyphs, whose (0,2,0) fix lost to
   `.notice-item.notice-error .notice-glyph` (0,3,0). Each had passed a check
   that named the classes it already knew about.

   So the check below runs a small cascade over the stylesheet itself
   (selector matching from the DOM; specificity and source order computed
   here, because happy-dom's own computed style ignores `inherit`) and asks
   it, in Light, Dark and Daylight, what colour every element inside every
   filled block really gets:
   - STATIC: every JSX element in src/ that draws a Caution or Danger block
     (a <Note> whose tier can be one, or a className carrying `message-tier`
     or `noteClass(`), with every intrinsic element written inside it and
     every class name those elements can carry;
   - RENDERED: the NoticeBar, whose item classes (`notice-${severity}`) exist
     only at run time.
   =================================================================== */

type Decl = { prop: string; value: string; important: boolean };
type CssSelector = { text: string; spec: number[]; subjectClasses: string[]; subjectTag: string | null };
type CssRule = { selectors: CssSelector[]; decls: Decl[]; order: number };

/** Split at `sep` outside brackets and parentheses. */
function splitTop(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `sel` with each functional pseudo-class replaced by `stand`, each reported to `fn`. */
function eachFunctional(sel: string, fn: (name: string, args: string) => void, stand = ' '): string {
  let out = '';
  for (let i = 0; i < sel.length; i++) {
    const m = /^:{1,2}([\w-]+)\(/.exec(sel.slice(i));
    if (!m) { out += sel[i]; continue; }
    let depth = 1;
    let j = i + m[0].length;
    for (; j < sel.length && depth > 0; j++) {
      if (sel[j] === '(') depth++;
      else if (sel[j] === ')') depth--;
    }
    fn(m[1]!, sel.slice(i + m[0].length, j - 1));
    out += stand;
    i = j - 1;
  }
  return out;
}

const addSpec = (a: number[], b: number[]) => a.map((v, i) => v + b[i]!);
const cmpKey = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Selectors Level 4 specificity: :where() counts nothing, :is/:not/:has their most specific argument. */
function specificity(sel: string): number[] {
  let spec = [0, 0, 0];
  let rest = eachFunctional(sel, (name, args) => {
    if (name === 'where') return;
    if (['is', 'not', 'has', 'matches'].includes(name)) {
      spec = addSpec(spec, splitTop(args).map(specificity).sort(cmpKey).at(-1) ?? [0, 0, 0]);
    } else {
      spec = addSpec(spec, [0, 1, 0]);
    }
  });
  const count = (re: RegExp, add: number[]) => {
    rest = rest.replace(re, () => { spec = addSpec(spec, add); return ' '; });
  };
  count(/\[[^\]]*\]/g, [0, 1, 0]);
  count(/#[\w-]+/g, [1, 0, 0]);
  count(/\.[\w-]+/g, [0, 1, 0]);
  count(/::[\w-]+/g, [0, 0, 1]);
  count(/:[\w-]+/g, [0, 1, 0]);
  for (const t of rest.split(/[\s>+~]+/)) if (/^[a-z][\w-]*$/i.test(t)) spec = addSpec(spec, [0, 0, 1]);
  return spec;
}

/** The subject compound's own classes and tag: a cheap reject before `matches`. */
function subjectOf(sel: string): { classes: string[]; tag: string | null } {
  // `*` holds the place of a functional pseudo-class, so `.a :where(p)` keeps
  // its subject compound rather than collapsing onto `.a`.
  const flat = eachFunctional(sel, () => {}, '*').replace(/\[[^\]]*\]/g, '');
  const compound = flat.trim().split(/\s*[>+~]\s*|\s+/).at(-1) ?? '';
  const tag = /^([a-z][\w-]*)/i.exec(compound)?.[1]?.toLowerCase() ?? null;
  return { classes: [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!), tag };
}

const CASCADE_PROPS = /^(color|background|background-color|padding|padding-right|position|right)$/;

function parseDecls(body: string): Decl[] {
  return splitTop(body, ';').flatMap((d) => {
    const m = /^([\w-]+)\s*:\s*([\s\S]*)$/.exec(d.trim());
    if (!m || !CASCADE_PROPS.test(m[1]!)) return [];
    const important = /!important\s*$/.test(m[2]!);
    return [{ prop: m[1]!, value: m[2]!.replace(/!important\s*$/, '').trim(), important }];
  });
}

/** Every style rule that can apply on screen: forced-colours and print blocks are their own regimes. */
function cascadeRules(src: string): CssRule[] {
  const out: CssRule[] = [];
  let order = 0;
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) {
        if (/^@(media|supports)\b/.test(prelude) && !/forced-colors|print/.test(prelude)) walk(body);
      } else {
        const decls = parseDecls(body);
        if (decls.length) {
          out.push({
            selectors: splitTop(prelude).map((s) => {
              const subject = subjectOf(s);
              return { text: s, spec: specificity(s), subjectClasses: subject.classes, subjectTag: subject.tag };
            }),
            decls,
            order: order++,
          });
        }
      }
      i = j;
    }
  };
  walk(src);
  return out;
}
const CASCADE = cascadeRules(css);

/** The winning declaration among `props` (treated as one property) for `el`. */
function winning(el: Element, props: string[]): Decl | null {
  let best: { key: number[]; decl: Decl } | null = null;
  const consider = (key: number[], decl: Decl) => {
    if (!best || cmpKey(key, best.key) >= 0) best = { key, decl };
  };
  for (const rule of CASCADE) {
    const relevant = rule.decls.filter((d) => props.includes(d.prop));
    if (!relevant.length) continue;
    let spec: number[] | null = null;
    for (const s of rule.selectors) {
      if (s.subjectTag && s.subjectTag !== el.tagName.toLowerCase()) continue;
      if (s.subjectClasses.some((c) => !el.classList.contains(c))) continue;
      let hit = false;
      try { hit = el.matches(s.text); } catch { hit = false; }
      if (hit && (!spec || cmpKey(s.spec, spec) > 0)) spec = s.spec;
    }
    if (!spec) continue;
    const matched = spec;
    relevant.forEach((d, i) => consider([d.important ? 1 : 0, 0, ...matched, rule.order, i], d));
  }
  for (const d of parseDecls(el.getAttribute('style') ?? '')) {
    if (props.includes(d.prop)) consider([d.important ? 1 : 0, 1, 0, 0, 0, 0, 0], d);
  }
  const won = best as { decl: Decl } | null;
  return won ? won.decl : null;
}

type RGBA = [number, number, number, number];
const NAMED: Record<string, RGBA> = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
};

function resolveVars(value: string, t: Record<string, string>): string {
  for (let guard = 0; guard < 20 && value.includes('var('); guard++) {
    value = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/,
      (_, name: string, fb?: string) => t[name] ?? fb?.trim() ?? `__missing${name}`);
  }
  return value;
}

function parseColour(v: string): RGBA | null {
  v = v.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2) || 'ff', 16));
    return [n[0]!, n[1]!, n[2]!, n[3]! / 255];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean)
      .map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  m = /^color-mix\(\s*in srgb\s*,(.*)\)$/.exec(v);
  if (m) {
    const parts = splitTop(m[1]!).map((part) => {
      const pm = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part.trim())!;
      return { c: parseColour(pm[1]!), p: pm[2] === undefined ? null : +pm[2] / 100 };
    });
    const [a, b] = parts;
    if (!a?.c || !b?.c) return null;
    const pa = a.p ?? (b.p === null ? 0.5 : 1 - b.p);
    const pb = b.p ?? 1 - pa;
    // Premultiplied, as CSS Color 5 mixes.
    const alpha = a.c[3] * pa + b.c[3] * pb;
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (i: number) => (a.c![i]! * a.c![3] * pa + b.c![i]! * b.c![3] * pb) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  return null;
}

/**
 * The opaque-tint idiom (mmr-brand 1.1.0): a translucent -soft token laid
 * over a stated ground as `linear-gradient(T, T), G`, for a surface that must
 * not show what scrolls under it (the fixed NoticeBar). Read as T over G, and
 * only in exactly that shape — any other gradient is still refused.
 */
function uniformTintOver(v: string): RGBA | null {
  const layers = splitTop(v);
  if (layers.length !== 2) return null;
  const g = /^linear-gradient\((.*)\)$/.exec(layers[0]!.trim());
  if (!g) return null;
  const stops = splitTop(g[1]!).map((x) => x.trim());
  if (stops.length !== 2 || stops[0] !== stops[1]) return null;
  const tint = parseColour(stops[0]!);
  const ground = parseColour(layers[1]!.trim());
  if (!tint || !ground || ground[3] !== 1) return null;
  return [...over(tint.slice(0, 3) as RGB, tint[3], ground.slice(0, 3) as RGB), 1] as RGBA;
}

/** Form controls draw the UA's own ink and face when no author rule says otherwise. */
const UA_FORM = new Set(['button', 'input', 'select', 'textarea']);

type Ink = { colour: RGBA; bg: RGBA; onFill: boolean };

/** What colour `el` is drawn in, on what, under theme `t`. Throws on a colour it cannot read. */
function ink(el: Element, t: Record<string, string>, memo: Map<Element, Ink>): Ink {
  const hit = memo.get(el);
  if (hit) return hit;
  const up: Ink = el.parentElement
    ? ink(el.parentElement, t, memo)
    : { colour: [0, 0, 0, 1], bg: [...tok(t, '--surface-0'), 1] as RGBA, onFill: false };
  const tag = el.tagName.toLowerCase();
  const read = (d: Decl | null, what: string): RGBA | 'inherit' | null => {
    if (!d) return null;
    const v = resolveVars(d.value, t).trim().toLowerCase();
    if (['inherit', 'unset', 'currentcolor'].includes(v)) return 'inherit';
    if (v === 'none') return NAMED.transparent!;
    const layered = uniformTintOver(v);
    if (layered) return layered;
    if (/gradient|url\(/.test(v)) throw new Error(`${what}: a gradient or image on <${tag} class="${el.className}">: ${v}`);
    const c = parseColour(v) ?? parseColour(v.split(/\s+/)[0]!);
    if (!c) throw new Error(`${what}: cannot read "${d.value}" (${v}) on <${tag} class="${el.className}">`);
    return c;
  };
  const c = read(winning(el, ['color']), 'color');
  const colour: RGBA = c && c !== 'inherit' ? c : c === null && UA_FORM.has(tag) ? [0, 0, 0, 1] : up.colour;
  const b = read(winning(el, ['background', 'background-color']), 'background');
  const own: RGBA = b && b !== 'inherit' ? b : b === null && UA_FORM.has(tag) ? [239, 239, 239, 1] : NAMED.transparent!;
  const bg: RGBA = [...over(own.slice(0, 3) as RGB, own[3], up.bg.slice(0, 3) as RGB), 1] as RGBA;
  const isFill = el.classList.contains('message-tier')
    && (el.classList.contains('message-caution') || el.classList.contains('message-danger'));
  // A TRANSLUCENT layer inside a fill (a tint on a tint, mmr-brand 1.1.0) is
  // still the fill's text ground: it stays on the fill's target. Only an
  // opaque face (a control) leaves it.
  const out: Ink = { colour, bg, onFill: isFill || (own[3] < 1 && up.onFill) };
  memo.set(el, out);
  return out;
}

const THEME_ATTRS: Record<string, [string, string] | null> = {
  light: null, dark: ['data-theme', 'dark'], daylight: ['data-contrast', 'high'],
};

const SKIP_TAGS = new Set(['svg', 'path', 'input', 'select', 'textarea', 'img', 'br', 'hr', 'option']);
const FILLED = '.message-tier.message-caution, .message-tier.message-danger';

/**
 * Every element inside every filled block under `root` whose ink falls short
 * of its target. `ground` is what `root` stands on: the page by default, a
 * panel (--surface-2) to test the same blocks inside one — the tints are
 * translucent since mmr-brand 1.1.0, so a block reads differently on each.
 */
function tierFailures(root: Element, theme: string, where: (el: Element) => string, ground = '--surface-0'): string[] {
  const t = THEMES[theme]!;
  const memo = new Map<Element, Ink>();
  if (ground !== '--surface-0') memo.set(root, { ...ink(root, t, new Map()), bg: [...tok(t, ground), 1] as RGBA });
  const out: string[] = [];
  for (const fill of root.querySelectorAll(FILLED)) {
    for (const el of [fill, ...fill.querySelectorAll('*')]) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase()) || el.closest('svg, .sr-only, [hidden]')) continue;
      const name = `${where(el)} <${el.tagName.toLowerCase()} class="${el.className}">`;
      const { colour, bg, onFill } = ink(el, t, memo);
      const fg = over(colour.slice(0, 3) as RGB, colour[3], bg.slice(0, 3) as RGB);
      const r = ratio(fg, bg.slice(0, 3) as RGB);
      // On the fill itself the filled-tier target; on a control's own face, AA.
      // The eyebrow (.message-label, SPEC §4.3) is one exception on the
      // light and dark TINTS: it takes the status colour, and the approved
      // table (D3) measures it at AA — warning 5.20 / 5.16, danger 5.59 light,
      // paper in dark. The NoticeBar's status glyph is the other (re-pinned
      // for mmr-brand 1.1.0, SPEC §3.1 "keep the colour in … the icon"): it
      // keeps its status colour on the tints, held at AA although a glyph is
      // a graphic (3:1). Daylight's solid boxes keep 7:1 for both.
      const eyebrow = theme !== 'daylight' && el.closest('.message-label, .notice-glyph') !== null;
      const need = onFill && !eyebrow ? 7 : AA;
      if (r < need) {
        out.push(`${theme}: ${name} ${r.toFixed(2)}:1 < ${need} `
          + `(${fg.map(Math.round).join(',')} on ${bg.slice(0, 3).map(Math.round).join(',')})`);
      }
      // An absolutely placed control (a ×) needs the block to keep room for it.
      if (el !== fill && winning(el, ['position'])?.value === 'absolute' && winning(el, ['right'])) {
        const box = el.parentElement!;
        const pad = winning(box, ['padding', 'padding-right']);
        const parts = pad?.value.split(/\s+/) ?? [];
        const right = pad?.prop === 'padding-right' ? parts[0] : parts[1] ?? parts[0];
        if (!right || parseFloat(right) < 24) out.push(`${theme}: ${name} sits over the text: padding-right ${right ?? 'unset'}`);
      }
    }
  }
  return out;
}

/* ---------- STATIC: every Caution/Danger site written in src/ ---------- */

type ProbeNode = { tag: string; classes: Set<string>; style: string; children: ProbeNode[]; site: string };

const SRC = join(here, '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** Whether every value `e` can take is empty or starts with whitespace (`c ? ' x' : ''`). */
function startsClean(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (ts.isParenthesizedExpression(e)) return startsClean(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text === '' || /^\s/.test(e.text);
  if (ts.isConditionalExpression(e)) return startsClean(e.whenTrue) && startsClean(e.whenFalse);
  return false;
}

/** Every class name a className can carry, dropping fragments glued to an interpolation (`notice-${…}`). */
function classNames(expr: ts.Node | undefined): string[] {
  const out: string[] = [];
  const words = (text: string, gluedLeft: boolean, gluedRight: boolean) => {
    const tokens = text.split(/\s+/).filter(Boolean);
    tokens.forEach((word, i) => {
      if (i === 0 && gluedLeft && !/^\s/.test(text)) return;
      if (i === tokens.length - 1 && gluedRight && !/\s$/.test(text)) return;
      if (/^[a-z_][\w-]*$/i.test(word)) out.push(word);
    });
  };
  const visit = (n: ts.Node, gluedLeft: boolean, gluedRight: boolean) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { words(n.text, gluedLeft, gluedRight); return; }
    if (ts.isTemplateExpression(n)) {
      // A word just before `${c ? ' x' : ''}` is whole: every value the
      // interpolation can take is empty or starts with a space.
      words(n.head.text, gluedLeft, !startsClean(n.templateSpans[0]?.expression));
      n.templateSpans.forEach((span, i) => {
        const before = i === 0 ? n.head.text : n.templateSpans[i - 1]!.literal.text;
        const after = span.literal.text;
        visit(span.expression, before !== '' && !/\s$/.test(before), after !== '' && !/^\s/.test(after));
        const next = n.templateSpans[i + 1]?.expression;
        words(after, true, next ? !startsClean(next) : gluedRight);
      });
      return;
    }
    ts.forEachChild(n, (c) => visit(c, gluedLeft, gluedRight));
  };
  if (expr) visit(expr, false, false);
  return out;
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute =>
    ts.isJsxAttribute(p) && p.name.getText() === name);
}
const attrValue = (a: ts.JsxAttribute | undefined): ts.Node | undefined =>
  !a?.initializer ? undefined
    : ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;

/** The colour and background written in a static `style={{ … }}`. */
function inlineStyle(el: ts.JsxOpeningLikeElement): string {
  const v = attrValue(attr(el, 'style'));
  if (!v || !ts.isObjectLiteralExpression(v)) return '';
  return v.properties.flatMap((p) => {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.initializer)) return [];
    const key = p.name.getText().replace(/['"]/g, '');
    return key === 'color' ? [`color: ${p.initializer.text}`]
      : key === 'background' || key === 'backgroundColor' ? [`background: ${p.initializer.text}`] : [];
  }).join('; ');
}

const opening = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement : n);
const isIntrinsic = (n: ts.JsxElement | ts.JsxSelfClosingElement) => /^[a-z]/.test(opening(n).tagName.getText());

/** The intrinsic elements written inside `n`, components and fragments looked through. */
function probeChildren(n: ts.JsxElement | ts.JsxFragment, site: string): ProbeNode[] {
  const out: ProbeNode[] = [];
  const visit = (c: ts.Node) => {
    if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
      if (isIntrinsic(c)) {
        const o = opening(c);
        out.push({
          tag: o.tagName.getText(), classes: new Set(classNames(attrValue(attr(o, 'className')))),
          style: inlineStyle(o), children: ts.isJsxElement(c) ? probeChildren(c, site) : [], site,
        });
      } else if (ts.isJsxElement(c)) {
        out.push(...probeChildren(c, site));
      }
      return;
    }
    if (ts.isJsxFragment(c)) { out.push(...probeChildren(c, site)); return; }
    if (ts.isJsxAttributes(c)) return;
    ts.forEachChild(c, visit);
  };
  n.children.forEach(visit);
  return out;
}

/** The filled tiers a tier expression can produce: the ones it names, else either. */
function tiersIn(text: string): string[] {
  const named = ['caution', 'danger'].filter((tier) => new RegExp(`['"\`]${tier}['"\`]|message-${tier}`).test(text));
  if (named.length) return named;
  return /^['"]information['"]$|^\{?\s*['"]information['"]\s*\}?$/.test(text.trim()) ? [] : ['caution', 'danger'];
}

function tierSites(): ProbeNode[] {
  const out: ProbeNode[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!/message-tier|noteClass\(|<Note\b/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const o = opening(n);
        const tag = o.tagName.getText();
        const cls = attrValue(attr(o, 'className'));
        const site = `${file.slice(SRC.length + 1).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(o.getStart()).line + 1}`;
        let tiers: string[] = [];
        let as = tag;
        if (tag === 'Note') {
          tiers = tiersIn(attr(o, 'tier')?.initializer?.getText() ?? '');
          const asValue = attrValue(attr(o, 'as'));
          as = asValue && ts.isStringLiteral(asValue) ? asValue.text : 'div';
        } else if (isIntrinsic(n) && cls && /message-tier|noteClass\(/.test(cls.getText())) {
          tiers = tiersIn(cls.getText());
        }
        for (const tier of tiers) {
          const kids = ts.isJsxElement(n) ? probeChildren(n, site) : [];
          if (tag === 'Note') {
            // NoteLabel: <span class="message-label"><span aria-hidden>⚠ </span>Caution: </span>
            kids.unshift({ tag: 'span', classes: new Set(['message-label']), style: '', site,
              children: [{ tag: 'span', classes: new Set(), style: '', children: [], site }] });
          }
          out.push({
            tag: as, classes: new Set([...classNames(cls), 'message-tier', `message-${tier}`]),
            style: inlineStyle(o), children: kids, site,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

function build(node: ProbeNode, sites: Map<Element, string>): Element {
  const el = document.createElement(node.tag);
  if (node.classes.size) el.className = [...node.classes].join(' ');
  if (node.style) el.setAttribute('style', node.style);
  sites.set(el, node.site);
  for (const c of node.children) el.appendChild(build(c, sites));
  return el;
}

function themed(theme: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'viz-root';
  const a = THEME_ATTRS[theme];
  if (a) root.setAttribute(a[0], a[1]);
  document.body.appendChild(root);
  return root;
}

describe('filled tiers: every descendant takes ink that reads on the fill (review of NOTES-1)', () => {
  const SITES = tierSites();

  it('finds the filled-tier sites it is meant to cover', () => {
    const files = new Set(SITES.map((s) => s.site.replace(/:\d+$/, '')));
    for (const f of ['components/WeatherStrip.tsx', 'components/MotorPadMass.tsx', 'App.tsx',
      'components/NoticeBar.tsx', 'components/ConfigPanel.tsx', 'components/BatchSimulate.tsx']) {
      expect(files.has(f), f).toBe(true);
    }
    const classes = (s: ProbeNode): string[] => [...s.classes, ...s.children.flatMap(classes)];
    const all = new Set(SITES.flatMap(classes));
    for (const c of ['weather-stale', 'measured-delta', 'file-note-dismiss', 'notice-glyph']) expect(all.has(c), c).toBe(true);
    expect(SITES.length).toBeGreaterThan(40);
  });

  it('the cascade it runs agrees with the browser on the cases it must get right', () => {
    const root = themed('dark');
    try {
      root.innerHTML = '<p class="comp-stats message-tier message-caution"><span class="x">a</span></p>'
        + '<div class="notice-item notice-error"><span class="notice-glyph">!</span></div>';
      const t = THEMES.dark!;
      const memo = new Map<Element, Ink>();
      // An unstyled span inherits the fill's own ink.
      expect(ink(root.querySelector('.x')!, t, memo).colour.slice(0, 3)).toEqual(tok(t, '--callout-caution-fg'));
      // (0,3,0) beats the bare (0,1,0) glyph rule.
      expect(ink(root.querySelector('.notice-glyph')!, t, memo).colour.slice(0, 3)).toEqual(tok(t, '--status-serious'));
      expect(specificity('.a.b :where(p, .c)')).toEqual([0, 2, 0]);
      expect(subjectOf('.a.b :where(p, .c)')).toEqual({ classes: [], tag: null });
      expect(subjectOf('.a .b.c:not(.d)')).toEqual({ classes: ['b', 'c'], tag: null });
      expect(subjectOf('.a > p.b')).toEqual({ classes: ['b'], tag: 'p' });
      // The inherit list reaches a <p> inside a fill over its own (0,1,0) ink.
      root.innerHTML += '<div class="message-tier message-danger"><p class="hero-fallback-detail">d</p></div>';
      expect(ink(root.querySelector('.hero-fallback-detail')!, t, new Map()).colour.slice(0, 3))
        .toEqual(tok(t, '--callout-danger-fg'));
      expect(specificity('.a :is(.b, #c) span::before')).toEqual([1, 1, 2]);
    } finally {
      root.remove();
    }
  });

  it('the eyebrow takes the status colour on the tints and the fill ink on Daylight\'s solid boxes (D3)', () => {
    // Table A: warning eyebrow 5.20 light / 5.16 dark, danger 5.59 light.
    // Re-pinned for mmr-brand 1.0.3: the dark danger eyebrow was paper while
    // the 1.0.2 danger-dark measured 4.51:1 on its tint; 1.0.3's #FF9EA5 is
    // 5.02:1 there, so it takes the status colour like the other three.
    const want: Record<string, Record<string, string>> = {
      light: { caution: '--status-warn', danger: '--status-serious' },
      dark: { caution: '--status-warn', danger: '--status-serious' },
      daylight: { caution: '--callout-caution-fg', danger: '--callout-danger-fg' },
    };
    for (const theme of Object.keys(THEMES)) {
      const t = THEMES[theme]!;
      const root = themed(theme);
      try {
        for (const tier of ['caution', 'danger']) {
          root.innerHTML = `<div class="message-tier message-${tier}"><span class="notice-text">`
            + '<span class="message-label"><span aria-hidden="true">!</span>Label: </span>body</span></div>';
          const memo = new Map<Element, Ink>();
          const label = ink(root.querySelector('.message-label')!, t, memo);
          expect(hex(label.colour.slice(0, 3) as RGB), `${theme} ${tier} eyebrow`).toBe(hex(tok(t, want[theme]![tier]!)));
          const r = ratio(label.colour.slice(0, 3) as RGB, label.bg.slice(0, 3) as RGB);
          expect(r, `${theme} ${tier} eyebrow ratio`).toBeGreaterThanOrEqual(theme === 'daylight' ? 7 : AA);
          // The body beside it keeps the fill's own ink.
          expect(hex(ink(root.querySelector('.notice-text')!, t, memo).colour.slice(0, 3) as RGB))
            .toBe(hex(tok(t, `--callout-${tier}-fg`)));
        }
      } finally {
        root.remove();
      }
    }
  });

  for (const theme of Object.keys(THEMES)) {
    it(`${theme}: every element written inside a Caution or Danger block (static)`, () => {
      const root = themed(theme);
      const sites = new Map<Element, string>();
      try {
        for (const s of SITES) root.appendChild(build(s, sites));
        expect(tierFailures(root, theme, (el) => sites.get(el) ?? '?')).toEqual([]);
        // And inside a panel (white / navy-raised), where most of them are:
        // the tints are translucent since mmr-brand 1.1.0, and NozzleField's
        // .field-caution inside its Caution block was a tint on a tint there
        // (paper 6.81:1 dark, under 7) while it passed over the page.
        expect(tierFailures(root, theme, (el) => sites.get(el) ?? '?', '--surface-2')).toEqual([]);
      } finally {
        root.remove();
      }
    });

    it(`${theme}: the NoticeBar's Danger and Caution items, glyph and × included (rendered)`, () => {
      const root = themed(theme);
      const host = document.createElement('div');
      root.appendChild(host);
      const r = createRoot(host);
      try {
        const notices: Notice[] = [
          { id: 'e', severity: 'error', tier: 'danger', text: 'The design could not be built.', onDismiss: () => {} },
          { id: 'w', severity: 'warn', tier: 'caution', text: 'A motor was left off.', onDismiss: () => {} },
          { id: 'g', severity: 'warn', text: 'Loaded', onDismiss: () => {}, group: {
            heading: 'Loaded “x.ork”.',
            lines: [{ kind: 'test-drop', text: 'A part was dropped.', tier: 'danger' },
              { kind: 'test-clamp', text: 'A value was clamped.', tier: 'caution' }],
          } },
        ];
        act(() => { r.render(createElement(NoticeBar, { notices })); });
        expect(root.querySelector('.notice-bar.expanded')).not.toBeNull();
        expect(root.querySelectorAll('.message-tier.message-danger .notice-glyph')).toHaveLength(1);
        expect(root.querySelectorAll('.message-tier.message-caution .notice-glyph')).toHaveLength(1);
        expect(tierFailures(root, theme, () => 'NoticeBar')).toEqual([]);
        // Collapsed, the lead item is the Danger one.
        act(() => { (root.querySelector('.notice-toggle') as HTMLButtonElement).click(); });
        expect(root.querySelector('.notice-bar.expanded')).toBeNull();
        expect(tierFailures(root, theme, () => 'NoticeBar collapsed')).toEqual([]);
      } finally {
        act(() => r.unmount());
        root.remove();
      }
    });
  }
});

/* ===================================================================
   MMR-BRAND 1.1.0: TINTS AND THE TEXT ON THEM, SELECTION, ROW RULES, THE
   DARK CHART GRID, IMPULSE CLASSES AND THE SITE STRIP

   The -soft tokens are TRANSLUCENT, so a tint is only as good as the ground
   under it: coloured (and muted) text on its own tint is AA over the page
   (brand bg) and a panel (brand surface), but 3.85–4.26:1 dark over brand
   surface-2 (navy-high: --hover, --note-bg). SPEC §3.1's rule — over
   surface-2 the text goes in --mmr-text — is held here by a table of every
   rule that paints a tint, the ground each one sits on (followed through
   the DOM and the CSS by hand, and written next to it), and the inks drawn
   on it; a new tinted rule fails until it is entered.
   =================================================================== */

/** Every style rule in the sheet (inside @media too), with its raw body. */
function allRules(): { sel: string; body: string; daylight: boolean }[] {
  const out: { sel: string; body: string; daylight: boolean }[] = [];
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) walk(body);
      else out.push({ sel: prelude.replace(/\s+/g, ' '), body, daylight: prelude.includes("[data-contrast='high']") });
      i = j;
    }
  };
  walk(css);
  return out;
}

/** What a tint is painted over: an app ground role. */
type Ground = '--surface-0' | '--surface-2' | '--note-bg' | '--hover';
type TintSite = {
  /** The rule's selector, whitespace-normalised. */
  sel: string;
  tint: string;
  /** Every TEXT colour drawn on the tint (AA; a tier's body ink 7:1). */
  inks: string[];
  /** Status-coloured edges and glyphs on it (3:1, WCAG 1.4.11). */
  marks?: string[];
  grounds: Ground[];
  where: string;
};

const PAGE: Ground = '--surface-0';
const PANEL: Ground = '--surface-2';
const TINT_SITES: TintSite[] = [
  { sel: '.launch-override-callout', tint: '--callout-caution-bg', inks: ['--callout-caution-fg'], marks: ['--status-warn'],
    grounds: [PAGE, PANEL], where: 'vitals strip, Launch panel, Batch dialog (panel); Fly screen column (page)' },
  { sel: '.field-caution', tint: '--tint-warn', inks: ['--text-secondary', '--text-primary'], grounds: [PAGE, PANEL],
    where: 'under a field in the Launch panel, NozzleField, Batch dialog' },
  { sel: '.weather-note, .weather-error', tint: '--tint-warn', inks: ['--text-secondary'], grounds: [PANEL], where: 'Weather dialog (modal card)' },
  { sel: '.weather-error', tint: '--tint-danger', inks: ['--text-secondary'], grounds: [PANEL], where: 'Weather dialog (modal card)' },
  { sel: '.gust-estimate-warn', tint: '--tint-warn', inks: ['--text-secondary'], grounds: [PANEL], where: 'Launch panel (GustEstimate)' },
  { sel: '.file-btn-danger:hover', tint: '--tint-danger', inks: ['--status-serious'], grounds: [PAGE, PANEL],
    where: 'ConfigPanel, SimResults (panels)' },
  { sel: '.file-note-warn', tint: '--tint-warn', inks: ['--text-primary'], grounds: [PAGE, PANEL], where: 'header (page), results and dialogs (panel)' },
  { sel: '.file-note-error', tint: '--tint-danger', inks: ['--text-primary'], grounds: [PAGE, PANEL], where: 'header autosave warning (page)' },
  { sel: '.modal-danger:hover', tint: '--tint-danger', inks: ['--status-serious'], grounds: [PAGE, PANEL],
    where: 'confirm dialogs and the crash fallback panel' },
  { sel: '.override-inert', tint: '--tint-warn', inks: ['--text-primary'], grounds: [PANEL], where: 'PropertyPanel' },
  { sel: '.notice-bar.notice-warn', tint: '--tint-warn', inks: ['--text-primary', '--text-secondary'],
    marks: ['--status-warn', '--status-serious'], grounds: [PANEL], where: 'fixed bar: laid opaque over the panel colour' },
  { sel: '.notice-bar.notice-error', tint: '--tint-danger', inks: ['--text-primary', '--text-secondary'],
    marks: ['--status-warn', '--status-serious'], grounds: [PANEL], where: 'fixed bar: laid opaque over the panel colour' },
  { sel: '.fly-stale', tint: '--tint-warn', inks: ['--text-secondary', '--callout-caution-fg'], grounds: [PAGE], where: 'Fly screen column (page)' },
  { sel: '.recovery-part-warn', tint: '--tint-warn', inks: ['--text-secondary', '--text-muted', '--status-warn'], grounds: [PANEL],
    where: 'Recovery sizing panel list row' },
  { sel: '.message-tier.message-tier.message-danger', tint: '--callout-danger-bg', inks: ['--callout-danger-fg', '--status-serious'],
    marks: ['--status-serious'], grounds: [PAGE, PANEL], where: 'every <Note tier="danger"> outside the NoticeBar' },
  { sel: '.message-tier.message-tier.message-caution', tint: '--callout-caution-bg', inks: ['--callout-caution-fg', '--status-warn'],
    marks: ['--status-warn'], grounds: [PAGE, PANEL], where: 'every <Note tier="caution"> outside the NoticeBar' },
  // The one place a tier would sit on brand surface-2 (the --note-bg bar) or
  // on another tint (a tinted bar): NoticeBar items. Laid opaque over the
  // panel colour instead, eyebrow in the text ink.
  { sel: '.notice-bar .message-tier.message-tier.message-danger', tint: '--callout-danger-bg', inks: ['--callout-danger-fg', '--text-primary'],
    marks: ['--status-serious'], grounds: [PANEL], where: 'NoticeBar items: opaque over the panel colour, on the bar' },
  { sel: '.notice-bar .message-tier.message-tier.message-caution', tint: '--callout-caution-bg', inks: ['--callout-caution-fg', '--text-primary'],
    marks: ['--status-warn'], grounds: [PANEL], where: 'NoticeBar items: opaque over the panel colour, on the bar' },
];

/** The opaque colour of a ground in theme `t`. */
const groundIn = (t: Record<string, string>, g: Ground): RGB => tok(t, g);
/** The app roles that are brand surface-2 (mist / navy-high). */
const BRAND_SURFACE_2: Ground[] = ['--note-bg', '--hover'];
const TEXT_INKS = new Set(['--text-primary', '--callout-caution-fg', '--callout-danger-fg']);

describe('mmr-brand 1.1.0: tints and the text on them (SPEC §3.1)', () => {
  const tinted = allRules().filter((r) => !r.daylight
    && /(?:^|[;\s])background(?:-color)?:[^;]*var\(--(?:tint-[\w-]+|callout-(?:caution|danger)-bg)\b/.test(r.body));

  it('every rule that paints a tint is in the table, with the inks it really draws', () => {
    const listed = TINT_SITES.filter((s) => !s.sel.startsWith('rendered:')).map((s) => s.sel);
    expect(tinted.map((r) => r.sel).sort()).toEqual([...listed].sort());
    for (const r of tinted) {
      const site = TINT_SITES.find((s) => s.sel === r.sel)!;
      const bg = /(?:^|[;\s])background(?:-color)?:\s*([^;]+);/.exec(r.body)![1]!;
      expect(bg, r.sel).toMatch(new RegExp(`var\\(${site.tint}[,)]`));
      // An opaque tint (the fixed bar, the bar's tiers) states its ground: the panel colour.
      if (/gradient/.test(bg)) expect(bg, r.sel).toMatch(/\), var\(--surface-2\)$/);
      // (A tier's hex fallback is the fatal bar's, outside .viz-root: pinned above.)
      const own = /(?:^|[;\s])color:\s*([^;]+);/.exec(r.body)?.[1]?.trim().replace(/^var\((--[\w-]+),[^)]*\)$/, 'var($1)');
      if (own) expect(site.inks.map((i) => `var(${i})`), `${r.sel} draws ${own}`).toContain(own);
    }
    // The hand-rolled tints are gone: no background is a color-mix() of a
    // status or accent role any more (borders, the zoom box, the stage grid
    // and the navy chips are not tints and are listed in the report).
    for (const r of allRules()) {
      expect(/(?:^|[;\s])background(?:-color)?:[^;]*color-mix\(in srgb, var\(--(?:status|accent|link)/.test(r.body), r.sel)
        .toBe(r.sel === '.chart-panel .u-select');
    }
  });

  it('the tint roles are the brand -soft tokens in light and dark, and opaque white-ground values in Daylight', () => {
    const want: Record<string, string> = {
      '--tint-warn': '--mmr-warning-soft', '--tint-danger': '--mmr-danger-soft',
    };
    const dark = tokens(".viz-root[data-theme='dark']");
    for (const [role, brand] of Object.entries(want)) {
      expect(THEMES.light![role], role).toBe(`var(${brand})`);
      expect(dark[role], role).toBe(`var(${brand})`);
      // Daylight: the light token composited on white, written out opaque.
      const day = colourIn(THEMES.daylight!, `var(${role})`);
      expect(day[3], `Daylight ${role} is opaque`).toBe(1);
      expect(hex(day.slice(0, 3) as RGB), `Daylight ${role}`).toBe(hex(fillOver(BRAND.light, brand, [255, 255, 255])));
    }
    expect(THEMES.light!['--callout-caution-bg']).toBe('var(--tint-warn)');
    expect(THEMES.light!['--callout-danger-bg']).toBe('var(--tint-danger)');
    expect(dark['--callout-caution-bg']).toBe('var(--tint-warn)');
    expect(dark['--callout-danger-bg']).toBe('var(--tint-danger)');
  });

  it('no coloured or muted text sits on a tint over brand surface-2', () => {
    // --hover and --note-bg ARE brand surface-2, in light and dark.
    for (const theme of ['light', 'dark']) {
      for (const g of BRAND_SURFACE_2) expect(hex(tok(THEMES[theme]!, g)), `${theme} ${g}`).toBe(hex(tok(THEMES[theme]!, '--mmr-surface-2')));
    }
    for (const s of TINT_SITES) {
      if (!s.grounds.some((g) => BRAND_SURFACE_2.includes(g))) continue;
      expect(s.inks.filter((i) => !TEXT_INKS.has(i)), `${s.sel} over ${s.grounds.join(', ')}`).toEqual([]);
    }
    // Each of those is the brand text token in light and dark.
    for (const theme of ['light', 'dark']) {
      for (const i of TEXT_INKS) expect(hex(tok(THEMES[theme]!, i)), `${theme} ${i}`).toBe(hex(tok(THEMES[theme]!, '--mmr-text')));
    }
    // The NoticeBar, the one tier context on brand surface-2: its tiers are
    // laid opaque over the panel colour (in the table above), and the rule
    // that puts their eyebrows in the text ink comes after the
    // status-coloured eyebrow rules it ties at (0,4,0).
    const at = css.indexOf('.notice-bar .message-tier.message-tier .message-label');
    expect(at).toBeGreaterThan(css.indexOf('.message-tier.message-tier.message-danger .message-label'));
    expect(decl(rule('.notice-bar .message-tier.message-tier .message-label {'), 'color')).toBe('var(--text-primary)');
  });

  /*
   * The table above is entered by hand, so the loop over its surface-2 grounds
   * checks nothing unless an entry lists one (none does). This is the check
   * that does not trust it: every JSX element in src/ that a tint rule paints
   * is walked up through the elements written around it in the same file, and
   * it fails if one of them is brand surface-2 (a rule paints it --note-bg or
   * --hover, hovered or not) or is itself a tint (a tint on a tint: two
   * translucent layers, the NozzleField case), unless a rule written for
   * exactly that nesting clears the inner fill or lays it opaque over the
   * panel colour. Its blind spot, stated: a component placed in a container
   * that another file renders.
   */
  it('no tint is written inside brand surface-2 or inside another tint without a rule that clears it (JSX scan)', () => {
    type Part = { subject: string[]; before: string[] };
    const partsOf = (sel: string): Part[] => splitTop(sel).map((p) => {
      const flat = eachFunctional(p, () => {}, '*').replace(/\[[^\]]*\]/g, '');
      const compounds = flat.trim().split(/\s*[>+~]\s*|\s+/);
      const cls = (c: string) => [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
      return { subject: cls(compounds.at(-1) ?? ''), before: compounds.slice(0, -1).flatMap(cls) };
    });
    const bgOf = (body: string) => /(?:^|[;\s])background(?:-color)?:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
    const live = allRules().filter((r) => !r.daylight);
    const tintParts = tinted.flatMap((r) => partsOf(r.sel)).filter((p) => p.before.length === 0 && p.subject.length > 0);
    const s2Parts = live.filter((r) => /var\(--(?:note-bg|hover)\)/.test(bgOf(r.body)))
      .flatMap((r) => partsOf(r.sel)).filter((p) => p.before.length === 0 && p.subject.length > 0);
    const clearParts = live.filter((r) => {
      const bg = bgOf(r.body);
      return bg === 'transparent' || /^linear-gradient\(.*\), var\(--surface-2\)$/.test(bg);
    }).flatMap((r) => partsOf(r.sel)).filter((p) => p.before.length > 0 && p.subject.length > 0);
    // The rule sets it reads are not empty, so neither is the check.
    expect(tintParts.length).toBeGreaterThan(15);
    expect(s2Parts.map((p) => p.subject.join('.'))).toEqual(expect.arrayContaining(['notice-bar', 'file-note', 'tree-row', 'motor-row']));

    const has = (set: Set<string>, p: Part) => p.subject.every((c) => set.has(c));
    const isTint = (set: Set<string>) => tintParts.some((p) => has(set, p));
    type Node = { classes: Set<string>; label: string };
    const parsed = sourceFiles(SRC).map((file) => ({
      sf: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      rel: file.slice(SRC.length + 1).replace(/\\/g, '/'),
    }));
    /** The classes an element is drawn with, a tier's included (a Note, or a noteClass() className). */
    const classesOf = (n: ts.JsxElement | ts.JsxSelfClosingElement): Set<string> | null => {
      const o = opening(n);
      const tag = o.tagName.getText();
      const cls = attrValue(attr(o, 'className'));
      const classes = new Set(classNames(cls));
      const tiers = tag === 'Note' ? tiersIn(attr(o, 'tier')?.initializer?.getText() ?? '')
        : isIntrinsic(n) && cls && /message-tier|noteClass\(/.test(cls.getText()) ? tiersIn(cls.getText()) : [];
      for (const c of tiers.length ? ['message-tier', ...tiers.map((t) => `message-${t}`)] : []) classes.add(c);
      return isIntrinsic(n) || tiers.length ? classes : null;
    };
    // Pass 1: which components DRAW a tint, so one placed in another file is
    // checked where it is placed (LaunchOverrideWarning's callout in the
    // results column's warn note). Names declared once in src/ only.
    const drawn = new Map<string, Set<string>[]>();
    const declared = new Map<string, number>();
    for (const { sf } of parsed) {
      const visitDecl = (n: ts.Node) => {
        const name = ts.isFunctionDeclaration(n) ? n.name?.text
          : ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
            && ts.isIdentifier(n.name) ? n.name.text : undefined;
        if (name && /^[A-Z]/.test(name)) {
          declared.set(name, (declared.get(name) ?? 0) + 1);
          const sets: Set<string>[] = [];
          const walk = (c: ts.Node) => {
            if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
              const classes = classesOf(c);
              if (classes && isTint(classes)) sets.push(classes);
            }
            ts.forEachChild(c, walk);
          };
          walk(n);
          if (sets.length) drawn.set(name, sets);
        }
        ts.forEachChild(n, visitDecl);
      };
      visitDecl(sf);
    }
    for (const [name, count] of declared) if (count > 1) drawn.delete(name);
    expect([...drawn.keys()]).toEqual(expect.arrayContaining(['LaunchOverrideWarning', 'NozzleField', 'GustEstimate']));

    // A nesting that no rule clears, measured instead: the inner tint over
    // the outer tint over the ground the outer one stands on, every ink and
    // mark the inner site draws, in every theme (below).
    const ALLOWED: { inner: string; outer: string; ground: Ground; where: string }[] = [
      { inner: 'launch-override-callout', outer: 'file-note-warn', ground: PAGE,
        where: 'App.tsx results column: the classic-model Mach warning holds a LaunchOverrideWarning' },
    ];
    const allowedSeen = new Set<string>();
    const offenders: string[] = [];
    let tintedSeen = 0;
    let nestedSeen = 0;
    const check = (inner: Set<string>, label: string, stack: Node[]) => {
      tintedSeen++;
      const above = new Set(stack.flatMap((a) => [...a.classes]));
      for (const a of stack) {
        const kind = isTint(a.classes) ? 'a tint' : s2Parts.some((p) => has(a.classes, p)) ? 'brand surface-2' : null;
        if (!kind) continue;
        nestedSeen++;
        if (clearParts.some((p) => has(inner, p) && p.before.every((c) => above.has(c)))) continue;
        const ok = ALLOWED.find((x) => inner.has(x.inner) && a.classes.has(x.outer));
        if (ok) { allowedSeen.add(`${ok.inner} in ${ok.outer}`); continue; }
        offenders.push(`${label} inside ${kind}: ${a.label}`);
      }
    };
    for (const { sf, rel } of parsed) {
      const visit = (n: ts.Node, stack: Node[]) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
          const o = opening(n);
          const tag = o.tagName.getText();
          const at = `${rel}:${sf.getLineAndCharacterOfPosition(o.getStart()).line + 1}`;
          const classes = classesOf(n);
          if (classes) {
            const node: Node = { classes, label: `${at} <${tag} class="${[...classes].join(' ')}">` };
            if (isTint(classes)) check(classes, node.label, stack);
            ts.forEachChild(n, (c) => visit(c, [...stack, node]));
            return;
          }
          for (const inner of drawn.get(tag) ?? []) check(inner, `${at} <${tag}> (draws class="${[...inner].join(' ')}")`, stack);
        }
        ts.forEachChild(n, (c) => visit(c, stack));
      };
      visit(sf, []);
    }
    // It finds the tinted elements, and the nested ones it must (the NoticeBar's
    // tiers on the --note-bg bar; NozzleField's .field-caution in its Caution
    // block; the results column's launch-override callout in a warn note).
    expect(tintedSeen).toBeGreaterThan(40);
    expect(nestedSeen).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
    expect([...allowedSeen].sort()).toEqual(ALLOWED.map((x) => `${x.inner} in ${x.outer}`).sort());

    const fails: string[] = [];
    for (const x of ALLOWED) {
      const inner = TINT_SITES.find((s) => s.sel === `.${x.inner}`)!;
      const outer = TINT_SITES.find((s) => s.sel === `.${x.outer}`)!;
      for (const [theme, t] of Object.entries(THEMES)) {
        const bg = fillOver(t, inner.tint, fillOver(t, outer.tint, groundIn(t, x.ground)));
        for (const i of inner.inks) {
          const need = /^--callout-(caution|danger)-fg$/.test(i) ? 7 : AA;
          if (ratio(tok(t, i), bg) < need) fails.push(`${theme} ${x.where}: ${i} ${ratio(tok(t, i), bg).toFixed(2)} < ${need}`);
        }
        for (const m of [...(inner.marks ?? []), '--focus']) {
          if (ratio(tok(t, m), bg) < 3) fails.push(`${theme} ${x.where}: ${m} ${ratio(tok(t, m), bg).toFixed(2)} < 3`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('every ink and mark on every tint passes over every ground it sits on, in every theme', () => {
    const fails: string[] = [];
    for (const s of TINT_SITES) {
      for (const [theme, t] of Object.entries(THEMES)) {
        for (const g of s.grounds) {
          const bg = fillOver(t, s.tint, groundIn(t, g));
          for (const i of s.inks) {
            // A tier's body ink keeps its 7:1 floor; everything else is AA.
            // Daylight's solid tier fills keep the fill's ink for every ink
            // (restated in its block), so the coloured eyebrow is not drawn.
            const solid = theme === 'daylight' && /^--callout-/.test(s.tint);
            if (solid && !/^--callout-/.test(i)) continue;
            const need = /^--callout-(caution|danger)-fg$/.test(i) ? 7 : AA;
            const r = ratio(tok(t, i), bg);
            if (r < need) fails.push(`${theme} ${s.sel}: ${i} on ${s.tint} over ${g} ${r.toFixed(2)} < ${need}`);
          }
          for (const m of s.marks ?? []) {
            if (theme === 'daylight' && /^--callout-/.test(s.tint)) continue;
            const r = ratio(tok(t, m), bg);
            if (r < 3) fails.push(`${theme} ${s.sel}: mark ${m} on ${s.tint} over ${g} ${r.toFixed(2)} < 3`);
          }
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('a tier\'s edge is its status colour on the tints and the fill\'s ink on Daylight\'s solid boxes', () => {
    expect(decl(rule('.message-tier.message-tier.message-danger {'), 'border-color')).toBe('var(--status-serious)');
    expect(decl(rule('.message-tier.message-tier.message-caution {'), 'border-color')).toBe('var(--status-warn)');
    expect(decl(rule(".viz-root[data-contrast='high'] .message-tier.message-tier.message-tier {"), 'border-color')).toBe('currentColor');
    expect(decl(rule('.launch-override-callout {'), 'border')).toBe('1px solid var(--status-warn)');
    // Daylight's other solid caution box draws its ink as its edge like the tiers.
    expect(decl(rule(".viz-root[data-contrast='high'] .launch-override-callout {"), 'border-color')).toBe('currentColor');
  });

  for (const theme of ['light', 'dark', 'daylight']) {
    it(`${theme}: the NoticeBar's eyebrows are the text ink over its surface-2 ground (rendered)`, () => {
      const t = THEMES[theme]!;
      const root = themed(theme);
      const host = document.createElement('div');
      root.appendChild(host);
      const r = createRoot(host);
      try {
        for (const severity of ['info', 'warn', 'error'] as const) {
          const notices: Notice[] = [
            { id: 'e', severity, tier: 'danger', text: 'Danger text.', onDismiss: () => {} },
            { id: 'w', severity, tier: 'caution', text: 'Caution text.', onDismiss: () => {} },
          ];
          act(() => { r.render(createElement(NoticeBar, { notices })); });
          const labels = [...root.querySelectorAll('.notice-bar .message-label')];
          expect(labels.length, severity).toBeGreaterThan(0);
          const memo = new Map<Element, Ink>();
          for (const label of labels) {
            const tier = label.closest('.message-danger') ? 'danger' : 'caution';
            const want = theme === 'daylight' ? `--callout-${tier}-fg` : '--text-primary';
            const got = ink(label, t, memo);
            expect(hex(got.colour.slice(0, 3) as RGB), `${theme} ${severity} ${tier} eyebrow`).toBe(hex(tok(t, want)));
            expect(ratio(got.colour.slice(0, 3) as RGB, got.bg.slice(0, 3) as RGB), `${theme} ${severity} ${tier}`)
              .toBeGreaterThanOrEqual(7);
            // ...while the icon keeps the status colour (SPEC §3.1: the colour
            // stays in the border, the icon and the tint), AA on the opaque
            // tier; on Daylight's solid boxes it is the fill's ink, at 7:1.
            const icon = label.querySelector('.message-icon');
            expect(icon, `${theme} ${severity} ${tier} icon`).not.toBeNull();
            const iconInk = ink(icon!, t, memo);
            const iconWant = theme === 'daylight' ? `--callout-${tier}-fg` : tier === 'danger' ? '--status-serious' : '--status-warn';
            expect(hex(iconInk.colour.slice(0, 3) as RGB), `${theme} ${severity} ${tier} icon`).toBe(hex(tok(t, iconWant)));
            expect(ratio(iconInk.colour.slice(0, 3) as RGB, iconInk.bg.slice(0, 3) as RGB), `${theme} ${severity} ${tier} icon`)
              .toBeGreaterThanOrEqual(theme === 'daylight' ? 7 : AA);
          }
          // The item's status glyph: its own look's status colour on the
          // tints, the fill's ink on Daylight's solid boxes.
          const glyphs = [...root.querySelectorAll('.notice-item.message-tier > .notice-glyph')];
          expect(glyphs.length, severity).toBeGreaterThan(0);
          for (const g of glyphs) {
            const tier = g.closest('.message-danger') ? 'danger' : 'caution';
            const glyphWant = theme === 'daylight' ? `--callout-${tier}-fg`
              : g.classList.contains('notice-look-error') ? '--status-serious' : '--status-warn';
            const got = ink(g, t, memo);
            expect(hex(got.colour.slice(0, 3) as RGB), `${theme} ${severity} ${tier} glyph`).toBe(hex(tok(t, glyphWant)));
            expect(ratio(got.colour.slice(0, 3) as RGB, got.bg.slice(0, 3) as RGB), `${theme} ${severity} ${tier} glyph`)
              .toBeGreaterThanOrEqual(theme === 'daylight' ? 7 : AA);
          }
        }
      } finally {
        act(() => r.unmount());
        root.remove();
      }
    });
  }
});

describe('mmr-brand 1.1.0: selection, quiet row rules and the dark chart grid', () => {
  it('selected rows, list items and toggles use --mmr-selection in light and dark (Daylight keeps #FFD18A)', () => {
    expect(THEMES.light!['--selected']).toBe('var(--mmr-selection)');
    expect(tokens(".viz-root[data-theme='dark']")['--selected']).toBe('var(--mmr-selection)');
    expect(hex(tok(THEMES.light!, '--selected'))).toBe('#e0edf5');
    expect(hex(tok(THEMES.dark!, '--selected'))).toBe('#184570');
    expect(THEMES.daylight!['--selected']).toBe('#ffd18a');
    for (const sel of ['.tree-row-selected,', '.motor-row-picked,', '.tree-visibility[aria-pressed="true"] {',
      '.guide-toc-item.active {', '.guide-content .guide-match-current {', '.hc-toggle.hc-on {']) {
      expect(decl(rule(sel), 'background'), sel).toBe('var(--selected)');
    }
    // Nothing paints a selection by hand any more.
    expect(css).not.toMatch(/color-mix\(in srgb, var\(--mmr-link-color\)/);
    // Everything a selected row draws: text, muted text, the status inks of a
    // picked run, the 3px bar (3:1). (No orange word is drawn on one.)
    for (const [name, t] of Object.entries(THEMES)) {
      const sel = tok(t, '--selected');
      for (const i of ['--text-primary', '--text-secondary', '--text-muted', '--status-good', '--status-warn', '--status-serious']) {
        expect(ratio(tok(t, i), sel), `${name} ${i} on --selected`).toBeGreaterThanOrEqual(AA);
      }
      expect(ratio(tok(t, '--accent-graphic'), sel), `${name} bar on --selected`).toBeGreaterThanOrEqual(3);
    }
  });

  it('quiet row rules are --mmr-border-subtle, only on tables and row lists that sit on the page or a panel', () => {
    expect(THEMES.light!['--border-subtle']).toBe('var(--mmr-border-subtle)');
    expect(tokens(".viz-root[data-theme='dark']")['--border-subtle']).toBe('var(--mmr-border-subtle)');
    // Daylight keeps its black rules.
    expect(THEMES.daylight!['--border-subtle']).toBe('#000000');
    const users = allRules().filter((r) => /var\(--border-subtle\)/.test(r.body)).map((r) => r.sel).sort();
    // Each of these is on brand bg (the motor/run table well, --surface-1) or
    // brand surface (a panel or dialog) — never on --hover or --note-bg,
    // where SPEC §3.1 wants --border.
    expect(users).toEqual([
      '.comparison-table-scroll :is(th, td)',
      '.config-part-row',
      '.config-table th, .config-table td',
      '.motor-table td',
      '.recovery-part',
      '.weather-review th, .weather-review td',
    ]);
    // A row that turns brand surface-2 under the pointer (--hover), or takes
    // the selection, draws its rule in --border: the quiet rule is navy-high
    // in dark, 1.00:1 on --hover and 1.02:1 on the selection.
    expect(decl(rule('.motor-row:hover td,\n.motor-row-picked td {'), 'border-bottom-color')).toBe('var(--border)');
    expect(ratio(tok(THEMES.dark!, '--border-subtle'), tok(THEMES.dark!, '--hover'))).toBeLessThan(1.05);
    // Column heads keep the full --border, a header rule, not a row rule
    // (the motor table's own th rule already did).
    expect(decl(rule('.config-table thead th {'), 'border-bottom-color')).toBe('var(--border)');
    expect(decl(rule('.comparison-table-scroll thead th {'), 'border-bottom-color')).toBe('var(--border)');
    expect(decl(rule('.weather-review thead th {'), 'border-bottom-color')).toBe('var(--border)');
    expect(decl(rule('.motor-table th {'), 'border-bottom')).toBe('1px solid var(--border)');
  });

  it('the User guide\'s search highlight keeps its pre-1.1.0 strength against the guide\'s panel', () => {
    expect(decl(rule('.guide-content mark {'), 'background')).toBe('var(--mark-bg)');
    expect(THEMES.light!['--mark-bg']).toBe('color-mix(in srgb, var(--accent-graphic) 22%, var(--surface-2))');
    // Before mmr-brand 1.1.0: light and Daylight 1.41:1, dark 1.23:1 (the
    // accent-soft tint was 1.18 / 1.13). The non-current matches carry no
    // ring or weight, so the fill is their one cue.
    const floor: Record<string, number> = { light: 1.41, dark: 1.22, daylight: 1.41 };
    for (const [name, t] of Object.entries(THEMES)) {
      const mark = tok(t, '--mark-bg');
      expect(ratio(mark, tok(t, '--surface-2')), `${name} mark on the panel`).toBeGreaterThanOrEqual(floor[name]!);
      expect(ratio(tok(t, '--text-primary'), mark), `${name} text on the mark`).toBeGreaterThanOrEqual(7);
    }
  });

  it('the charts read the brand grid (#33597C dark) through --chart-grid; nothing hard-codes the old #557793', () => {
    expect(THEMES.light!['--chart-grid']).toBe('var(--mmr-chart-grid)');
    expect(tokens(".viz-root[data-theme='dark']")['--chart-grid']).toBe('var(--mmr-chart-grid)');
    expect(hex(tok(THEMES.dark!, '--chart-grid'))).toBe('#33597c');
    expect(hex(tok(THEMES.light!, '--chart-grid'))).toBe('#b3cadc');
    expect(read('../chartTheme.ts')).toMatch(/grid: v\('--chart-grid'\)/);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
    const offenders = walk(SRC).filter((f) => /557793/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    // A marker (the reference ink) still differs from a grid line by more
    // than shape alone in light and dark: 3.73 and 4.02 (was 2.59 on #557793).
    for (const name of ['light', 'dark']) {
      const t = THEMES[name]!;
      expect(ratio(tok(t, '--chart-reference'), tok(t, '--chart-grid')), name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('mmr-brand 1.1.0: motor impulse classes (SPEC §3.2)', () => {
  it('the Motor browser\'s class chips carry the class badge', () => {
    const src = read('MotorBrowser.tsx');
    expect(src).toMatch(/aria-label="Impulse classes"[\s\S]{0,400}<ImpulseBadge letter=\{letter\} \/>/);
    // Every class token named in full, so a reader (and cssCustomProperties)
    // can find each one.
    for (const l of 'abcdefghijklmno') expect(src).toContain(`'var(--mmr-chart-impulse-${l})'`);
    expect(decl(rule('.impulse-badge {'), 'color')).toBe('var(--mmr-chart-impulse-label)');
  });

  it('a chosen class differs from an unchosen one on the badge itself, not only by the ✓', () => {
    // The letter is a fixed label on a fixed fill, so it no longer takes the
    // chip's off/on ink; a chosen chip rings its badge in the text ink
    // instead, a graphic held at 3:1 against the chip's own ground (the
    // chip's --surface-3, Daylight's --selected fill when on).
    expect(decl(rule('.series-chip-on .impulse-badge {'), 'box-shadow')).toBe('0 0 0 2px var(--text-primary)');
    expect(css).not.toMatch(/\.series-chip:not\(\.series-chip-on\) \.impulse-badge/);
    for (const [name, t] of Object.entries(THEMES)) {
      const chipOn = name === 'daylight' ? '--selected' : '--surface-3';
      expect(ratio(tok(t, '--text-primary'), tok(t, chipOn)), `${name} ring`).toBeGreaterThanOrEqual(3);
    }
  });

  for (const theme of Object.keys(THEMES)) {
    it(`${theme}: every class letter A–O is AA on its own fill (rendered)`, () => {
      const t = THEMES[theme]!;
      const root = themed(theme);
      const host = document.createElement('div');
      root.appendChild(host);
      const r = createRoot(host);
      try {
        const letters = 'ABCDEFGHIJKLMNO'.split('');
        act(() => { r.render(createElement(Fragment, null, ...[...letters, 'P'].map((l) => createElement(ImpulseBadge, { key: l, letter: l })))); });
        const badges = [...root.querySelectorAll('.impulse-badge')];
        expect(badges.map((b) => b.textContent)).toEqual(letters);
        const memo = new Map<Element, Ink>();
        for (const b of badges) {
          const key = b.textContent!.toLowerCase();
          const got = ink(b, t, memo);
          expect(hex(got.bg.slice(0, 3) as RGB), `${theme} ${key}`).toBe(hex(tok(t, `--mmr-chart-impulse-${key}`)));
          expect(ratio(got.colour.slice(0, 3) as RGB, got.bg.slice(0, 3) as RGB), `${theme} ${key}`).toBeGreaterThanOrEqual(AA);
        }
        // A letter off the ramp keeps the plain letter, no borrowed colour.
        expect(host.textContent).toMatch(/OP$/);
      } finally {
        act(() => r.unmount());
        root.remove();
      }
    });
  }
});

describe('mmr-brand 1.1.0: the site strip stays dark-on-navy inside a light theme (SPEC §4.3)', () => {
  const PSEUDO = /:(?:hover|focus-visible|focus-within|focus|active)\b/g;
  const HAS_STATE = /:(?:hover|focus-visible|focus-within|focus|active)\b/;
  const colourProps = /(?:^|[;\s])((?:color|background(?:-color|-image)?|border(?:-[\w-]+)?|outline(?:-color)?|box-shadow|fill|stroke)\s*:\s*[^;]+);/g;

  it('every band rule colours from brand primitives only, so no theme variable can reach it', () => {
    const band = allRules().filter((r) => /mmr-band/.test(r.sel));
    expect(band.length).toBeGreaterThan(15);
    for (const r of band) {
      for (const d of r.body.matchAll(colourProps)) {
        const vars = [...d[1]!.matchAll(/var\((--[\w-]+)/g)].map((v) => v[1]!);
        expect(vars.filter((v) => !v.startsWith('--mmr-c-')), `${r.sel} { ${d[1]} }`).toEqual([]);
      }
    }
  });

  for (const theme of ['light', 'daylight', 'dark']) {
    it(`${theme}: every element in the strip and the footer draws a navy-ground pair, at rest and in every state rule that reaches it (rendered)`, () => {
      const t = THEMES[theme]!;
      const root = themed(theme);
      const host = document.createElement('div');
      root.appendChild(host);
      const r = createRoot(host);
      try {
        act(() => {
          r.render(createElement(Fragment, null,
            createElement(SiteBand, { nav: MMR_NAV_FALLBACK, source: 'fallback' }),
            createElement(SiteBandFooter, { nav: MMR_NAV_FALLBACK })));
        });
        const els = [...root.querySelectorAll('.mmr-band, .mmr-band *, .mmr-band-footer, .mmr-band-footer *')]
          .filter((el) => !el.closest('svg') && el.tagName.toLowerCase() !== 'img');
        expect(root.querySelector('.mmr-band-search input')).not.toBeNull();
        expect(root.querySelector('.mmr-band-footer a')).not.toBeNull();
        const navy = hex(tok(t, '--mmr-c-navy'));
        const raised = hex(tok(t, '--mmr-c-navy-raised'));
        const memo = new Map<Element, Ink>();
        for (const el of els) {
          const what = `<${el.tagName.toLowerCase()} class="${el.className}">`;
          for (const prop of [['color'], ['background', 'background-color']]) {
            const w = winning(el, prop);
            if (w && !/^(inherit|none|transparent|currentcolor)$/i.test(w.value)) {
              expect(w.value, `${theme} ${what} ${prop[0]}`).toMatch(/^var\(--mmr-c-/);
            }
          }
          const got = ink(el, t, memo);
          expect([navy, raised], `${theme} ${what} ground`).toContain(hex(got.bg.slice(0, 3) as RGB));
          expect(ratio(got.colour.slice(0, 3) as RGB, got.bg.slice(0, 3) as RGB), `${theme} ${what}`).toBeGreaterThanOrEqual(AA);
        }
        // State rules (hover, focus, active) cannot be rendered here, so match
        // them with the state stripped: any rule outside the band's own that
        // would colour a band element in some state. The only ones are the
        // app's focus rings, which the band's sky ring outranks (pinned in
        // "the site strip is navy in every theme" above).
        const reach = new Set<string>();
        for (const rr of allRules()) {
          if (/mmr-band/.test(rr.sel) || !HAS_STATE.test(rr.sel)) continue;
          if (![...rr.body.matchAll(colourProps)].length) continue;
          for (const s of splitTop(rr.sel)) {
            if (!HAS_STATE.test(s)) continue;
            let bare = s.replace(PSEUDO, '');
            if (/(^|[\s>+~])$/.test(bare)) bare = `${bare}*`;
            bare = bare.trim();
            let hit = false;
            try { hit = els.some((el) => el.matches(bare)); } catch { hit = false; }
            if (hit) reach.add(s);
          }
        }
        expect([...reach].sort()).toEqual(theme === 'daylight'
          ? ['.viz-root :focus-visible', ".viz-root[data-contrast='high'] :focus-visible"]
          : ['.viz-root :focus-visible']);
      } finally {
        act(() => r.unmount());
        root.remove();
      }
    });
  }
});
