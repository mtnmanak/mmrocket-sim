// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { RecoveryMass } from '../services/recoveryMass.js';
import { loadPresets } from '../services/presets.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import { RecoverySizingPanel } from './RecoverySizingPanel.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The owner's Wildman: 8.786 kg under the chute. */
const WILDMAN: RecoveryMass = { state: 'ok', mass: 8.786, multiStage: false };

const tree = (chutes: Partial<ComponentNode>[] = []): RocketTree => ({
  name: 'test',
  components: [{
    type: 'stage', id: 's0', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', name: 'Body', length: 1.2,
      outerRadius: 0.077, thickness: 0.001,
      children: chutes.map((c, i) => ({ type: 'parachute', id: `p${i}`, ...c } as ComponentNode)),
    } as ComponentNode],
  } as ComponentNode],
});

describe('RecoverySizingPanel', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    // Warm the lazily-imported catalogue once, so each mount's own load
    // resolves from the module cache instead of racing a 1.3 MB import.
    await loadPresets();
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // Inches and ft/s, so the copy can be read against the owner's own numbers.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      units: { length: 'in', velocity: 'ft/s', mass: 'kg', distance: 'ft' },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const mount = async (over: {
    recovery?: RecoveryMass;
    tree?: RocketTree;
    launch?: Partial<LaunchConditions>;
  } = {}) => {
    await act(async () => {
      root.render(
        <PrefsProvider>
          <RecoverySizingPanel
            recovery={over.recovery ?? WILDMAN}
            tree={over.tree ?? tree()}
            launch={{ ...DEFAULT_CONDITIONS, ...over.launch }}
            deviceMass={() => 0.25}
          />
        </PrefsProvider>,
      );
    });
    // The catalogue is lazily imported and lands in a setState. Flush until it
    // has arrived rather than guessing a number of microtask turns — the
    // dynamic import of a 1.3 MB JSON takes more of them than it looks.
    for (let i = 0; i < 50 && host.textContent?.includes('Looking through'); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
  };

  const text = () => host.textContent ?? '';
  const bands = () => Array.from(host.querySelectorAll('.recovery-band'));
  const sizeLine = (i: number) => bands()[i]?.querySelector('.recovery-size-line')?.textContent ?? '';
  const rows = (i: number) => Array.from(bands()[i]?.querySelectorAll('.recovery-part') ?? []);
  /** The descent rate a row states, as a number in the displayed unit. */
  const rowRate = (r: Element) => parseFloat(r.querySelector('.recovery-part-rate')?.textContent ?? '');

  it('says nothing but "load a motor" with no motor loaded', async () => {
    await mount({ recovery: { state: 'no-motor' } });
    expect(text()).toContain('Load a motor');
    expect(bands()).toHaveLength(0);
    // The panel is still THERE — a readout that only appears once you know to
    // look for it is a readout nobody finds.
    expect(host.querySelector('.recovery-sizing')).not.toBeNull();
  });

  it('passes recoveryMass’s own reason through', async () => {
    await mount({ recovery: { state: 'unavailable', reason: 'strap-on boosters separate' } });
    expect(text()).toContain('strap-on boosters separate');
    expect(bands()).toHaveLength(0);
  });

  it('leads with the SIZE and names the Cd, both bands', async () => {
    await mount();
    expect(bands()).toHaveLength(2);
    // No chute in the design, so the size line quotes the kernel's own 0.8 —
    // the owner's worked example: a 107 in main and a 32 in drogue.
    expect(sizeLine(0).replace(/\s+/g, ' ')).toContain('about 107 in at Cd 0.8');
    expect(sizeLine(1).replace(/\s+/g, ' ')).toContain('about 32 in at Cd 0.8');
    expect(text()).toContain('the simulator’s default for a canopy that states no Cd');
  });

  it('quotes the design’s OWN canopy Cd when it has one', async () => {
    await mount({ tree: tree([{ diameter: 1.6, cd: 2.2, deployEvent: 'altitude' }]) });
    expect(sizeLine(0).replace(/\s+/g, ' ')).toContain('at Cd 2.2');
    expect(text()).toContain('the Cd of the main in this design');
  });

  it('lists real catalogue parts with the rate each would give this rocket', async () => {
    await mount();
    const main = rows(0);
    expect(main.length).toBeGreaterThan(2);
    expect(main.length).toBeLessThanOrEqual(5);
    for (const r of main) {
      // Every row states a descent rate, and it is inside the main band.
      const v = rowRate(r);
      expect(v).toBeGreaterThanOrEqual(15);
      expect(v).toBeLessThanOrEqual(20.02);
    }
    expect(text()).toContain('Fruity Chutes');
  });

  it('states the bands themselves, so the number has a window around it', async () => {
    await mount();
    // Text nodes only: the unit is a <select>, whose textContent drags in every
    // option it offers ("m/skm/hft/s…").
    const ranges = Array.from(host.querySelectorAll('.recovery-band-range'))
      .map((el) => Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join('').trim());
    expect(ranges[0]).toBe('15–20');
    expect(ranges[1]).toBe('50–75');
  });

  it('says how many canopies were dropped for fit, rather than looking arbitrary', async () => {
    // A 54 mm airframe: most of the mains that suit 8.786 kg will not pack.
    const narrow: RocketTree = {
      name: 'narrow',
      components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'bt', length: 1, outerRadius: 0.028, thickness: 0.001,
        }],
      } as unknown as ComponentNode],
    };
    await mount({ tree: narrow });
    expect(text()).toMatch(/\d+ of \d+ canopies that hit this band pack wider/);
  });

  it('marks a drogue over the app’s own 70 ft/s threshold in the report’s words', async () => {
    // 0.9 kg: only three catalogue drogues make the 50-75 band, one of them
    // past 70 ft/s. With fewer than five unflagged candidates the marked one
    // is actually SHOWN, which is what makes this a test of the marking rather
    // than of the ordering (recoverySizing.test.ts covers the ordering).
    await mount({ recovery: { state: 'ok', mass: 0.9, multiStage: false } });
    const drogue = bands()[1]!;
    expect(drogue.querySelector('.recovery-part-warn')).not.toBeNull();
    expect(drogue.textContent).toContain('faster than the accepted');
    expect(drogue.textContent).toContain('drogue band — the launch report will say so');
    // Marked, and LAST — never ahead of a canopy that clears the threshold.
    const flagged = rows(1).map((r) => r.classList.contains('recovery-part-warn'));
    expect(flagged[flagged.length - 1]).toBe(true);
    expect(flagged[0]).toBe(false);
    // Nothing above the owner's 75 ft/s is ever offered, marked or not.
    for (const r of rows(1)) expect(rowRate(r)).toBeLessThanOrEqual(75.01);
  });

  it('says so when the field is high — one clause, only when it applies', async () => {
    await mount();
    expect(text()).not.toContain('faster than sea level');

    await mount({ launch: { launchAltitudeM: 1524 } });
    expect(text()).toContain('faster than sea level');
    // 7.7 %, rounded to the whole percent the copy quotes.
    expect(text()).toContain('8% faster');
  });

  it('never claims a difference of 0% — a low field just names itself', async () => {
    // ISA density falls ~1.16 % per 100 m, so siteRateFactor first reaches
    // 1.005 — the first value that rounds to 1 % — at about 86 m. Every field
    // below that printed "the thinner air lands it 0% faster than sea level",
    // a sentence contradicting itself on the one panel whose whole job is to be
    // trusted for a chute choice.
    await mount({ launch: { launchAltitudeM: 45.7 } });   // a 150 ft field
    expect(text()).not.toContain('0% faster');
    expect(text()).not.toContain('faster than sea level');
    // The elevation itself stays in the lede: every rate below it was computed
    // at that site's density, not at sea level's.
    expect(text().replace(/\s+/g, ' ')).toContain('coming down at 150 ft.');
  });

  it('says which Cd convention the size line quoted on a vented canopy', async () => {
    // The headline used to be computed with no vent term while the candidates
    // under it applied 1 − (d/D)². 2.2 × (1 − 0.176²) = 2.13, and the diameter
    // moves 65 in → 66 in for this rocket.
    await mount({
      tree: tree([{ diameter: 1.0, cd: 2.2, spillHoleDiameter: 0.176, deployEvent: 'altitude' }]),
    });
    expect(sizeLine(0).replace(/\s+/g, ' ')).toContain('about 66 in at Cd 2.13');
    expect(text()).toContain('its rated Cd 2.2 scaled for its spill hole');
  });

  it('says nothing about a spill hole when the canopy has none', async () => {
    await mount({ tree: tree([{ diameter: 1.6, cd: 2.2, deployEvent: 'altitude' }]) });
    expect(sizeLine(0).replace(/\s+/g, ' ')).toContain('at Cd 2.2');
    expect(text()).not.toContain('scaled for its spill hole');
  });
  // --- collapsing (owner, 2026-09-04): the panel moved under the component
  // properties, and the right-hand column is the long one, so it folds. The
  // point of the summary is that a SHUT panel still answers the question.
  const toggle = () => host.querySelector('button[aria-expanded]') as HTMLButtonElement;
  const summary = () => host.querySelector('.recovery-sizing-summary')?.textContent ?? '';

  it('is open on a fresh browser, because a panel nobody opens is a panel nobody finds', async () => {
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(bands()).toHaveLength(2);
    expect(summary()).toBe('');
  });

  it('still names both sizes once collapsed', async () => {
    await mount();
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(bands()).toHaveLength(0);
    // The conclusion survives the fold: a main and a drogue, both with a size.
    expect(summary()).toMatch(/^main ~\d+(\.\d+)? in · drogue ~\d+(\.\d+)? in$/);
    // And it agrees with what the expanded panel said, rather than being a
    // second calculation that could drift from it.
    const shut = summary();
    await act(async () => { toggle().click(); });
    const main = shut.replace(/^main ~/, '').replace(/ in .*$/, '');
    expect(sizeLine(0).replace(/\s+/g, ' ')).toContain(`about ${main} in`);
  });

  it('remembers that you shut it, and re-opening clears the memory', async () => {
    await mount();
    await act(async () => { toggle().click(); });
    expect(localStorage.getItem('online-openrocket.recovery-sizing-open')).toBe('0');
    // A fresh mount honours it — this is the whole reason it is persisted.
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle().click(); });
    expect(localStorage.getItem('online-openrocket.recovery-sizing-open')).toBe('1');
  });

  it('collapses to a plain-words summary when there is no motor to size against', async () => {
    await mount({ recovery: { state: 'no-motor' } });
    await act(async () => { toggle().click(); });
    expect(summary()).toBe('needs a motor');
  });
});
