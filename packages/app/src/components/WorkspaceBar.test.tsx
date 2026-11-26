// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompactAeroMarker, WorkspaceBar } from './WorkspaceBar.js';
import { AERO_NAME, type AeroChoice } from '../prefs/aeroChoice.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { UnitChip } from './UnitChip.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let prefs: ReturnType<typeof usePrefs>;
let height: number;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let observe: ReturnType<typeof vi.fn>;
let tall: MediaQueryList;
let print: MediaQueryList;
let phone: MediaQueryList;
let unobserve: ReturnType<typeof vi.fn>;

function Probe() {
  prefs = usePrefs();
  return <WorkspaceBar><div className="vitals-strip"><span>Stability 1.5 cal</span><input aria-label="Summary probe" defaultValue="Rocket" /></div>
    <nav aria-label="Workspace"><button>Design</button></nav></WorkspaceBar>;
}
function query(media: string, matches: boolean): MediaQueryList {
  return Object.assign(new EventTarget(), { media, matches }) as MediaQueryList;
}
const mount = () => act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
const offset = () => document.documentElement.style.getPropertyValue('--workspace-bar-h');
const enable = (value: boolean) => act(() => prefs.setPrefs({ ...prefs.prefs, stickyWorkspaceBar: value }));

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  height = 124;
  tall = query('(min-height: 700px)', true);
  print = query('print', false);
  phone = query('(max-width: 767px)', false);
  vi.stubGlobal('matchMedia', (q: string) => q === tall.media ? tall : q === phone.media ? phone : q === 'print' ? print : query(q, false));
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    unobserve = unobserve;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('row 140: opts in to the class, measures wrapping, and resets the offset when off', () => {
  mount();
  expect(host.querySelector('.workspace-bar-sticky')).toBeNull();
  expect(host.querySelector('.workspace-bar-compact')).toBeNull();
  expect(host.querySelector('.workspace-summary-toggle')).toBeNull();
  expect(offset()).toBe('0px');
  enable(true);
  expect(host.querySelector('.workspace-bar-compact')).toBeNull();
  expect(host.querySelector('.workspace-summary-toggle')).toBeNull();
  expect(observe).toHaveBeenCalledWith(host.querySelector('.workspace-bar'));
  expect(host.querySelector('.workspace-bar-sticky nav[aria-label="Workspace"]')).not.toBeNull();
  expect(offset()).toBe('124px');
  height = 263;
  resize();
  expect(offset()).toBe('263px');
  enable(false);
  expect(host.querySelector('.workspace-bar-sticky')).toBeNull();
  expect(offset()).toBe('0px');
});

it('round r2: growing contents publish height before a parent scroll effect in the same commit', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  const readings: string[] = [];
  function Parent({ expanded }: { expanded: boolean }) {
    useLayoutEffect(() => { readings.push(offset()); }, [expanded]);
    return <WorkspaceBar>{expanded && <div>More rocket readings</div>}<nav>Design</nav></WorkspaceBar>;
  }
  act(() => root.render(<PrefsProvider><Parent expanded={false} /></PrefsProvider>));
  height = 263;
  act(() => root.render(<PrefsProvider><Parent expanded /></PrefsProvider>));
  expect(readings).toEqual(['124px', '263px']);
  // No ResizeObserver callback was delivered between commits.
  expect(observe).toHaveBeenCalledTimes(1);
});

it('row 140: short windows and printing use zero, then restore the measured height', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  Object.assign(tall, { matches: false });
  mount();
  expect(offset()).toBe('0px');
  Object.assign(tall, { matches: true });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('124px');
  Object.assign(print, { matches: true });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
  Object.assign(print, { matches: false });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('124px');
  Object.assign(tall, { matches: false });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
});

it('row 140: unmount disconnects measurement and media listeners and clears the page offset', () => {
  mount();
  enable(true);
  const tallRemove = vi.spyOn(tall, 'removeEventListener');
  const printRemove = vi.spyOn(print, 'removeEventListener');
  const phoneRemove = vi.spyOn(phone, 'removeEventListener');
  act(() => root.render(null));
  expect(disconnect).toHaveBeenCalled();
  expect(tallRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(printRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(phoneRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(offset()).toBe('');
});

it('round r3: phones measure and observe only vitals, including Fly and width transitions', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  Object.assign(phone, { matches: true });
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('vitals-strip') ? height : 999 } as DOMRect;
  });
  const readings: string[] = [];
  function Parent({ fly }: { fly: boolean }) {
    useLayoutEffect(() => { readings.push(offset()); }, [fly]);
    return <WorkspaceBar>{!fly && <div className="vitals-strip">Rocket readings</div>}<nav>Design</nav></WorkspaceBar>;
  }
  const render = (fly: boolean) => act(() => root.render(<PrefsProvider><Parent fly={fly} /></PrefsProvider>));
  render(false);
  const band = host.querySelector('.workspace-bar');
  const vitals = host.querySelector('.vitals-strip');
  expect(offset()).toBe('124px');
  expect(observe).toHaveBeenCalledWith(vitals);
  expect(observe).not.toHaveBeenCalledWith(band);
  height = 263;
  resize();
  expect(offset()).toBe('263px');
  render(true);
  expect(offset()).toBe('0px');
  expect(unobserve).toHaveBeenCalledWith(vitals);
  render(false);
  expect(readings).toEqual(['124px', '0px', '263px']);
  expect(observe).toHaveBeenCalledWith(host.querySelector('.vitals-strip'));
  Object.assign(phone, { matches: false });
  phone.dispatchEvent(new Event('change'));
  expect(offset()).toBe('999px');
  expect(observe).toHaveBeenCalledWith(band);
  Object.assign(phone, { matches: true });
  phone.dispatchEvent(new Event('change'));
  expect(offset()).toBe('263px');
  expect(unobserve).toHaveBeenCalledWith(band);
  Object.assign(tall, { matches: false });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
  Object.assign(tall, { matches: true });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('263px');
  Object.assign(print, { matches: true });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
});

function mediaRules(media: string, after = 0): string {
  const start = css.indexOf(media, after);
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  for (; depth && end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
  }
  return css.slice(open + 1, end - 1);
}

it.each(['stability-warn', 'stability-bad'])('F150 keeps one set of vitals and warnings, and expands with a named control (%s)', state => {
  Object.assign(phone, { matches: true });
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true, compactWorkspaceBar: true }));
  act(() => root.render(<PrefsProvider><WorkspaceBar>
    <div className="vitals-strip">
      <span className="vitals-item vitals-item-stability"><span className="vitals-label">Stability</span>
        <span className={`vitals-value ${state}`}><span aria-hidden="true">⚠</span><span className="sr-only">Under-stable</span> 0.5 cal</span></span>
      <span className="vitals-item vitals-item-mass">Mass 1 kg</span>
      <span className="vitals-item vitals-item-apogee vitals-item-stale"><span className="vitals-label">Apogee</span>
        <span className="vitals-value">984.3 <UnitChip quantity="altitude" />
          <span className="vitals-stale" aria-hidden="true">⚠ previous flight</span>
          <span className="sr-only">Warning: the motor changed since this flight.</span></span></span>
      <span className="vitals-item vitals-item-build"><span className="stability-bad">⚠ error</span></span>
      <div className="launch-override-compact"><span className="launch-override-icon">⚠</span><span id="override">Flight override</span><button aria-describedby="override">Show</button></div>
    </div><nav aria-label="Workspace">Design</nav>
  </WorkspaceBar></PrefsProvider>));
  const band = host.querySelector('.workspace-bar')!;
  expect(band.classList.contains('workspace-bar-compact')).toBe(true);
  expect(host.querySelectorAll('.vitals-strip')).toHaveLength(1);
  expect(host.querySelectorAll(`.vitals-item-stability .${state}`)).toHaveLength(1);
  expect(host.querySelector<HTMLSelectElement>('.vitals-item-stale .unit-chip')?.value).toBe('m');
  expect(host.querySelector('.vitals-item-stale .vitals-value')?.textContent).toContain('984.3');
  expect(host.querySelector('.vitals-item-stale .sr-only')?.textContent).toContain('the motor changed');
  const toggle = host.querySelector<HTMLButtonElement>('.workspace-summary-toggle')!;
  expect(toggle).not.toBeNull();
  expect(toggle.textContent).toBe('Details');
  expect(toggle.getAttribute('aria-label')).toBe('Details: expand rocket summary');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(host.querySelector('.vitals-strip'));
  expect(offset()).toBe('124px');
  height = 247;
  act(() => toggle.click());
  expect(band.classList.contains('workspace-bar-expanded')).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toBe('Less');
  expect(toggle.getAttribute('aria-label')).toBe('Less: collapse rocket summary');
  expect(offset()).toBe('247px');
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('F150 keeps Off unchanged even when the extra compact key is saved', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: false, compactWorkspaceBar: true }));
  mount();
  expect(host.querySelector('.workspace-bar-sticky')).toBeNull();
  expect(host.querySelector('.workspace-bar-compact')).toBeNull();
  expect(host.querySelector('.workspace-summary-toggle')).toBeNull();
  expect(offset()).toBe('0px');
  expect(host.querySelector('.vitals-strip input')).not.toBeNull();
  // Prove this fixture would detect compact if sticky were enabled.
  enable(true);
  expect(host.querySelector('.workspace-bar-compact')).not.toBeNull();
  expect(host.querySelector('.workspace-summary-toggle')).not.toBeNull();
});

it('F150 r2 preserves summary and navigation state when switching On and compact', () => {
  mount();
  enable(true);
  const input = host.querySelector<HTMLInputElement>('.vitals-strip input')!;
  const nav = host.querySelector('nav')!;
  const button = nav.querySelector('button')!;
  input.value = 'Edited rocket';
  button.focus();
  for (const compactWorkspaceBar of [true, false, true]) {
    act(() => prefs.setPrefs({ ...prefs.prefs, compactWorkspaceBar }));
    expect(host.querySelector('.vitals-strip input')).toBe(input);
    expect(input.value).toBe('Edited rocket');
    expect(host.querySelector('nav')).toBe(nav);
    expect(document.activeElement).toBe(button);
    expect(!!host.querySelector('.workspace-summary-toggle')).toBe(compactWorkspaceBar);
  }
});

it('F150 r2 visually hides the full stale reading without removing its unit or clipping a word', () => {
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  const stale = /\.vitals-item-stale \.vitals-value:not\(:focus-within\)\s*\{([^}]*)\}/.exec(rules)?.[1] ?? '';
  for (const declaration of ['position: absolute', 'width: 1px', 'height: 1px', 'clip: rect(0 0 0 0)']) {
    expect(stale).toContain(declaration);
  }
  expect(rules).not.toMatch(/font-size:\s*0\s*[;}]/);
  expect(rules).not.toMatch(/\.vitals-item-stale \.unit-chip\s*\{[^}]*display:\s*none/);
  expect(rules).not.toMatch(/\.vitals-stale\s*\{[^}]*width:\s*22px/);
  // Empty generated-content alternative keeps the decorative icon silent.
  expect(rules).toMatch(/\.vitals-item-stale::after\s*\{[^}]*content:\s*'⚠'\s*\/\s*''/);
  expect(rules).toMatch(/\.vitals-item-stale:focus-within\s*\{[^}]*flex:\s*1 1 auto/);
  // Revealing the unit on focus must not put the warning below a block value.
  expect(rules).toMatch(/\.vitals-item-stale\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*row/);
  expect(rules).toMatch(/\.vitals-item-stale \.vitals-value\s*\{[^}]*min-width:\s*0/);
  expect(rules).toMatch(/\.vitals-item-stale::after\s*\{[^}]*flex:\s*0 0 auto/);
});

it('F150 r2 names a reachable Launch location in stale speech and the guide', () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
  const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../user-guide.md'), 'utf8');
  expect(app.includes('Launch is under Details in the compact summary, or on the phone Fly screen.')).toBe(true);
  expect(app.includes('<span className="sr-only">{` — warning: ${apogeeStaleWhy}`}</span>')).toBe(true);
  expect(css).toMatch(/\.workspace-bar \.vitals-compact-launch-help\s*\{\s*display:\s*none/);
  expect(mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)'))
    .toMatch(/:not\(\.workspace-bar-expanded\) \.vitals-compact-launch-help\s*\{\s*display:\s*block/);
  expect(guide.includes('In the compact phone summary, **Launch** is under **Details**; the phone **Fly** screen also has its own **Launch** button.')).toBe(true);
  expect(guide.includes('A **↺** marks a session aerodynamics override')).toBe(true);
  expect(guide).not.toContain('**?**');
});

it('F150 r3 keeps only a noninteractive aero marker in the collapsed slot', () => {
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  expect(rules).toMatch(/\.vitals-item-aero:has\(\.vitals-aero-compact\)\s*\{[^}]*display:\s*block/);
  expect(rules).toMatch(/\.vitals-item-aero \.vitals-value > :not\(\.vitals-aero-compact\)\s*\{\s*display:\s*none/);
  expect(rules).toMatch(/\.vitals-item-aero \.vitals-aero-compact\s*\{\s*display:\s*inline/);
  expect(css).toMatch(/\.vitals-aero-compact\s*\{\s*display:\s*none/);
  expect(rules).not.toContain('.vitals-aero-select:not(:focus)');
  expect(rules).toMatch(/\.launch-override-compact button\s*\{\s*display:\s*none/);
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
  expect(app).toContain('<CompactAeroMarker choice={aeroOverride ?? aeroChoiceOf(prefs)} preference={aeroChoiceOf(prefs)}');
  expect(app).toContain("autoSupersonic={effectiveSupersonic && aeroMode === 'auto'}");
  expect(app).toContain('aria-label={`Clear the session aero override and use ${AERO_NAME[aeroChoiceOf(prefs)]}`}');
  expect(app).toContain('Auto aero: this design flew past Mach 0.9');
  expect(app.includes('role="img" aria-label="Auto aero is using the supersonic model"')).toBe(true);
});

it.each(Object.keys(AERO_NAME) as AeroChoice[])('F150 r3 matches the full override/M+ signs for %s', choice => {
  for (const preference of Object.keys(AERO_NAME) as AeroChoice[]) {
    for (const autoSupersonic of choice === 'auto' ? [false, true] : [false]) {
      act(() => root.render(<CompactAeroMarker choice={choice} preference={preference} autoSupersonic={autoSupersonic} />));
      const marker = host.querySelector('.vitals-aero-compact');
      // Same conditions as the full band's revert button and Auto M+ sign.
      expect(!!marker).toBe(choice !== preference || autoSupersonic);
      if (marker) {
        expect(marker.getAttribute('role')).toBe('img');
        expect(marker.getAttribute('aria-label')).toContain(AERO_NAME[autoSupersonic ? 'supersonic' : choice]);
        expect(host.querySelector('button, select, input, a, [tabindex]')).toBeNull();
        expect(marker.textContent!.length).toBeLessThanOrEqual(5);
        if (autoSupersonic) expect(marker.textContent).toBe('M+');
      }
    }
  }
});

it('F150 r3 insets focus for every remaining compact control in both themes', () => {
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  expect(rules).toMatch(/:not\(\.workspace-bar-expanded\) :focus-visible\s*\{[^}]*outline-offset:\s*-3px/);
  // Daylight's '.viz-root[data-contrast=high] :focus-visible' rule has the same specificity and comes later in the
  // file, so the compact inset must out-rank it, not tie with it.
  expect(rules).toMatch(/\.viz-root \.workspace-bar-compact:not\(\.workspace-bar-expanded\) :focus-visible\s*\{[^}]*outline-offset:\s*-3px/);
  expect(css).toMatch(/\.viz-root :focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  // The inset is theme-independent; both controls retain the theme's focus token.
  expect(rules).not.toMatch(/(?:data-theme|daylight)[^{]*:focus-visible/);
});

it('F150 r3 locates Launch in the Results empty state only for collapsed compact phones', () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
  expect(app).toContain('<span className="results-full-launch-help">Press <strong>Launch</strong> (above)');
  expect(app).toContain('<span className="results-compact-launch-help">Press <strong>Launch</strong> in <strong>Details</strong> above or on <strong>Fly</strong>');
  expect(css).toMatch(/\.results-compact-launch-help\s*\{\s*display:\s*none/);
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  expect(rules).toMatch(/:has\(\.workspace-bar-compact:not\(\.workspace-bar-expanded\)\) \.results-full-launch-help\s*\{\s*display:\s*none/);
  expect(rules).toMatch(/:has\(\.workspace-bar-compact:not\(\.workspace-bar-expanded\)\) \.results-compact-launch-help\s*\{\s*display:\s*inline/);
});

it('F150 limits compact styling to tall phones, keeps warnings and never wraps the line', () => {
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  expect(rules).toMatch(/flex-wrap:\s*nowrap/);
  expect(rules).toMatch(/white-space:\s*nowrap/);
  expect(rules).toMatch(/text-overflow:\s*ellipsis/);
  for (const name of ['stability', 'mass', 'build', 'stale']) expect(rules).toContain(`.vitals-item-${name}`);
  expect(rules).toContain('.launch-override-icon');
  expect(rules).toContain('.workspace-summary-toggle');
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
  for (const name of ['stability', 'mass', 'build', 'apogee']) expect(app).toContain(`vitals-item-${name}`);
});

it('row 140: sticky is gated to tall screens, opaque in each theme, and below popovers', () => {
  const rules = mediaRules('@media screen and (min-height: 700px)');
  expect(rules).toMatch(/\.workspace-bar-sticky\s*\{[^}]*position:\s*sticky;/);
  expect(rules).toMatch(/top:\s*0;/);
  expect(rules).toMatch(/background:\s*var\(--surface-0\);/);
  expect(rules).toMatch(/z-index:\s*4;/);
  // No other rule may turn the band sticky, including print or short screens.
  expect(css.replace(rules, '')).not.toMatch(/\.workspace-bar-sticky\s*\{[^}]*position:\s*sticky/);
  const printRules = mediaRules('@media print');
  expect(printRules).toMatch(/\.workspace-bar-sticky\s*\{\s*position:\s*static;/);
  expect(printRules).toMatch(/html\s*\{\s*scroll-padding-top:\s*0;/);
  expect(css).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--workspace-bar-h\);/);
});

it('round r2: tall phones retain fixed bottom tabs and their existing clearances', () => {
  const phone = mediaRules('@media (max-width: 767px)', css.indexOf('@media (min-width: 768px)'));
  expect(phone).toMatch(/\.workspace-tabs\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/);
  expect(phone).toMatch(/\.workspace\s*\{[^}]*padding-bottom:\s*calc\(76px/);
  expect(css).not.toMatch(/\.workspace-bar-sticky\s+\.workspace-tabs\s*\{[^}]*position:/);
  expect(css).toMatch(/\.notice-bar\s*\{[^}]*bottom:\s*calc\(76px/);
  expect(css).toMatch(/\.mmr-band-footer\s*\{[^}]*padding-bottom:\s*calc\(76px/);
  expect(phone).toMatch(/\.workspace-bar\s*\{[^}]*margin-bottom:\s*0;/);
});

it('round r3: tall phone tabs escape the band stacking context while only vitals stick', () => {
  const tallRules = mediaRules('@media screen and (min-height: 700px)');
  const phone = mediaRules('@media (max-width: 767px)', css.indexOf('@media screen and (min-height: 700px)'));
  expect(tallRules).toContain(phone);
  expect(phone).toMatch(/\.workspace-bar-sticky\s*\{\s*display:\s*contents;\s*\}/);
  expect(phone).toMatch(/\.workspace-bar-sticky\s*>\s*\.vitals-strip\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*4;[^}]*background:\s*var\(--surface-0\);/);
  const bottomTabs = mediaRules('@media (max-width: 767px)', css.indexOf('@media (min-width: 768px)'));
  expect(bottomTabs).toMatch(/\.workspace-tabs\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*50;/);
});

it('round r2: one desktop tab border and the same content gap with summary or Fly tabs alone', () => {
  expect(css).toMatch(/\.workspace-bar\s*\{\s*margin-bottom:\s*12px;\s*\}/);
  const tabs = /\.workspace-tabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(tabs).toMatch(/border-bottom:\s*2px solid var\(--border\);/);
  expect(tabs).not.toMatch(/margin-bottom:/);
  const bandRules = [...css.matchAll(/\.workspace-bar(?:-sticky)?\s*\{([^}]*)\}/g)];
  expect(bandRules.length).toBeGreaterThan(0);
  for (const rule of bandRules) expect(rule[1]).not.toMatch(/border(?:-bottom)?:/);
  // Neither spacing nor the single border depends on having a vitals child.
  expect(css).not.toMatch(/\.workspace-bar[^\s{}]*:has\(/);
});

it('F150 r3 keeps the stale-apogee icon where CSS content alt text is unsupported', () => {
  const rules = mediaRules('@media screen and (min-height: 700px) and (max-width: 767px)');
  // A browser without `content: x / alt` support drops that whole declaration; the plain one before it must remain.
  expect(rules).toMatch(/\.vitals-item-stale::after\s*\{\s*content:\s*'⚠';\s*content:\s*'⚠'\s*\/\s*'';/);
});
