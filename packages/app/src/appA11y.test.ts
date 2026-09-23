// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, 'App.tsx'), 'utf8');

/** The source of one `const name = (…) => {…};` handler, up to the next top-level `const`. */
function handler(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = `);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

/**
 * The opening tag of the first element whose attributes contain `marker`:
 * from its `<` to the first `>` outside braces, quotes and comments, so an
 * `=>` inside an attribute does not end it.
 */
function openingTag(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const lt = src.lastIndexOf('<', at);
  let depth = 0;
  let quote: string | null = null;
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(lt, i + 1);
  }
  throw new Error(`unterminated tag at ${marker}`);
}

/**
 * App-level accessibility wiring from the 2026-09-22 audit (rows 443, 444,
 * 445, 453, 455, 462). App.tsx is never rendered whole by this suite — it
 * needs the TeaVM kernel, the motor database and a browser layout — so, like
 * savedMarkSites.test.ts and nozzleWiring.test.ts, these read the source.
 * Each one is an absence or an attribute that no other test would miss.
 */
describe('App — accessibility wiring', () => {
  it('row 443: Launch lands focus on the Results <main>, and says the flight is done', () => {
    const src = app();
    const tag = openingTag(src, 'className="results-column"');
    expect(tag).toMatch(/^<main /);
    expect(tag).toContain('ref={resultsMainRef}');
    // Focusable by script, not by Tab.
    expect(tag).toContain('tabIndex={-1}');
    const launch = handler(src, 'onLaunch');
    // The pressed button unmounts (Motors, Fly) or disables (the vitals strip)
    // as the tab switches: focus has to be PUT somewhere, before the flight.
    expect(launch).toMatch(/afterPaint\(\)\.then\(\(\) => \{\s*resultsMainRef\.current\?\.focus\(\);/);
    expect(launch).toContain('`Flight complete — apogee ${');
    // A polite region that is always mounted, so its first message is heard.
    expect(src).toMatch(/<div className="sr-only" role="status" aria-live="polite">\s*\{flightSaid\.text && <span key=\{flightSaid\.seq\}>\{flightSaid\.text\}<\/span>\}/);
  });

  it('row 444: the vitals apogee ⚠ carries its reason in words, not only in a title', () => {
    const src = app();
    expect(src).toContain('<span className="vitals-stale" aria-hidden="true"> ⚠</span>');
    expect(src).toMatch(/<span className="sr-only">\{` — warning: \$\{apogeeStaleWhy\}`\}<\/span>/);
    // The tooltip and the spoken words are one string, so they cannot differ.
    expect(src).toMatch(/title=\{apogeeStaleWhy \?\? 'Apogee of the most recent flight'\}/);
  });

  it('row 445: no tablist without a tab pattern — the workspace is a nav, the view switch toggles', () => {
    const src = app();
    expect(src).not.toMatch(/role="tab(list)?"/);
    expect(src).toContain('<nav className="workspace-tabs" aria-label="Workspace">');
    for (const t of ['fly', 'design', 'motors', 'results']) {
      expect(src).toContain(`aria-current={tab === '${t}' ? 'page' : undefined}`);
    }
    expect(src).toContain('<div className="view-toggle" role="group" aria-label="Drawing view">');
    for (const v of ['2d', '3d', 'aft']) expect(src).toContain(`aria-pressed={view === '${v}'}`);
  });

  it('row 453: the rocket-name box and the motor ✕ have names', () => {
    const src = app();
    expect(src).toContain('<label htmlFor="rocket-name">Rocket name</label>');
    expect(src).toMatch(/<input id="rocket-name" value=\{tree\.name \?\? ''\}/);
    const remove = openingTag(src, 'title="Remove this motor"');
    expect(remove).toContain("aria-label={`Remove ${mm.label} from ${m.name ?? 'Motor mount'}`}");
  });

  it('row 455: Motors & Launch has a <main> landmark', () => {
    expect(openingTag(app(), 'className="motors-layout"')).toMatch(/^<main /);
  });

  it('row 462: the stats drawer toggles state whether it is open', () => {
    const src = app();
    expect(openingTag(src, 'onClick={() => setDrawerByUser(false)}')).toContain('aria-expanded={true}');
    expect(openingTag(src, 'onClick={() => setDrawerByUser(true)}')).toContain('aria-expanded={false}');
  });
});
