// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXPORT_VARS } from '../services/schematicExport.js';
import { NoticeBar, type Notice } from './NoticeBar.js';
import { installFatalErrorBar } from '../services/fatalErrorBar.js';

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

describe('launch override callout contrast', () => {
  it('Danger has at least 7:1 contrast in Light, Dark and Daylight', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--callout-danger-fg'), tok(t, '--callout-danger-bg')), name).toBeGreaterThanOrEqual(7);
    }
  });
  it('near-black text and Show outlines have at least 7:1 contrast on the caution fill in every theme', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(tok(t, '--callout-caution-fg'), tok(t, '--callout-caution-bg')), name).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('NOTES-1 supporting text and startup contrast', () => {
  it('NoticeBar counts and stale gust text clear 4.5:1 including the old failing Dark mixtures', () => {
    expect(rules('.notice-count').join('\n')).toContain('color: var(--text-secondary)');
    expect(rules('.gust-estimate-muted').at(-1)).toContain('color: var(--text-secondary)');
    for (const [name, t] of Object.entries(THEMES)) {
      const panel = tok(t, '--surface-2');
      for (const bg of [panel, over(tok(t, '--status-warn'), 0.10, panel),
        over(tok(t, '--status-serious'), 0.12, panel), over(tok(t, '--status-warn'), 0.08, panel)]) {
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
  const out: Ink = { colour, bg, onFill: isFill || (own[3] === 0 && up.onFill) };
  memo.set(el, out);
  return out;
}

const THEME_ATTRS: Record<string, [string, string] | null> = {
  light: null, dark: ['data-theme', 'dark'], daylight: ['data-contrast', 'high'],
};

const SKIP_TAGS = new Set(['svg', 'path', 'input', 'select', 'textarea', 'img', 'br', 'hr', 'option']);
const FILLED = '.message-tier.message-caution, .message-tier.message-danger';

/** Every element inside every filled block under `root` whose ink falls short of its target. */
function tierFailures(root: Element, theme: string, where: (el: Element) => string): string[] {
  const t = THEMES[theme]!;
  const memo = new Map<Element, Ink>();
  const out: string[] = [];
  for (const fill of root.querySelectorAll(FILLED)) {
    for (const el of [fill, ...fill.querySelectorAll('*')]) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase()) || el.closest('svg, .sr-only, [hidden]')) continue;
      const name = `${where(el)} <${el.tagName.toLowerCase()} class="${el.className}">`;
      const { colour, bg, onFill } = ink(el, t, memo);
      const fg = over(colour.slice(0, 3) as RGB, colour[3], bg.slice(0, 3) as RGB);
      const r = ratio(fg, bg.slice(0, 3) as RGB);
      // On the fill itself the filled-tier target; on a control's own face, AA.
      const need = onFill ? 7 : AA;
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
      words(n.head.text, gluedLeft, true);
      n.templateSpans.forEach((span, i) => {
        const before = i === 0 ? n.head.text : n.templateSpans[i - 1]!.literal.text;
        const after = span.literal.text;
        visit(span.expression, before !== '' && !/\s$/.test(before), after !== '' && !/^\s/.test(after));
        words(after, true, i < n.templateSpans.length - 1 || gluedRight);
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

  for (const theme of Object.keys(THEMES)) {
    it(`${theme}: every element written inside a Caution or Danger block (static)`, () => {
      const root = themed(theme);
      const sites = new Map<Element, string>();
      try {
        for (const s of SITES) root.appendChild(build(s, sites));
        expect(tierFailures(root, theme, (el) => sites.get(el) ?? '?')).toEqual([]);
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
