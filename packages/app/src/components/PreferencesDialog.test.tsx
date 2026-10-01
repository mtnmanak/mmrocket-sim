// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferencesDialog } from './PreferencesDialog.js';
import { aeroChoiceOf, effectiveAero, PrefsProvider, usePrefs, type AeroChoice, type Preferences } from '../prefs/PrefsContext.js';
import { QUANTITY_LABEL, UNITS, type Quantity } from '../prefs/units.js';

/**
 * The 3D-printing section: picking a machine fills the build volume, typing
 * over any of it makes the machine "Custom", and every dimension goes through
 * the app's normal length plumbing — so a build volume typed in inches lands
 * in the store as metres, like every other length.
 *
 * Rendered through react-dom's own root API with React's `act` (no
 * @testing-library in this workspace — see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;

const stored = (): Preferences => JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Preferences;

const printerSelect = (): HTMLSelectElement =>
  [...host.querySelectorAll('select')].find(
    (s) => [...s.options].some((o) => o.value === 'bambu-h2d'),
  ) as HTMLSelectElement;

/** A label's own words: its text without the unit chip's options, as getByLabelText reads it. */
const labelWords = (l: HTMLLabelElement): string => {
  const words = l.cloneNode(true) as HTMLLabelElement;
  words.querySelectorAll('select').forEach((s) => s.remove());
  return (words.textContent ?? '').replace(/\s+/g, ' ').trim();
};

/**
 * The control the label reading `words` reaches: the DOM's own `label.control`.
 * A label with no `for` reaches nothing, or its first labelable descendant —
 * the unit chip — so this finds a field only through a real association.
 * (getByLabelText would also take a matching aria-label, and pass unassociated.)
 */
const byLabel = (words: string): HTMLElement | null =>
  [...host.querySelectorAll('label')].find((l) => labelWords(l) === words)?.control ?? null;

const axis = (label: string): HTMLInputElement | null => byLabel(label) as HTMLInputElement | null;

const pick = (el: HTMLSelectElement, value: string) => act(() => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

/** React tracks the last value it wrote; go through the native setter or the
 *  synthetic onChange never fires. */
const type = (el: HTMLInputElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

const mount = () => act(() => root.render(
  <PrefsProvider><PreferencesDialog onClose={() => {}} /></PrefsProvider>,
));

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('Preferences → 3D printing', () => {
  it('starts with no printer and no dimension fields at all', () => {
    mount();
    expect(printerSelect().value).toBe('');
    expect(axis('Bed X')).toBeNull();
    expect(axis('Maximum Z')).toBeNull();
  });

  it('picking a preset fills X/Y/Z, in millimetres on screen and metres in the store', () => {
    mount();
    pick(printerSelect(), 'prusa-mk4s');
    expect(axis('Bed X')!.value).toBe('250');
    expect(axis('Bed Y')!.value).toBe('210');
    expect(axis('Maximum Z')!.value).toBe('220');
    expect(stored().printer).toEqual({
      preset: 'prusa-mk4s', x: 0.25, y: 0.21, z: 0.22, margin: 0.008, clearance: 0.00015,
    });
  });

  it('editing any dimension switches the machine to Custom', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    expect(printerSelect().value).toBe('bambu-h2d');
    type(axis('Maximum Z')!, '400');
    expect(printerSelect().value).toBe('custom');
    expect(stored().printer!.preset).toBe('custom');
    expect(stored().printer!.z).toBeCloseTo(0.4, 12);
    // ...and the untouched axes keep the machine's numbers.
    expect(stored().printer!.x).toBeCloseTo(0.35, 12);
  });

  it('typing the preset numbers back in restores the machine', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    type(axis('Maximum Z')!, '400');
    type(axis('Maximum Z')!, '325');
    expect(printerSelect().value).toBe('bambu-h2d');
  });

  it('a build volume typed in inches is stored in metres', () => {
    // The whole reason the printer lives in SI: it rides the same siToUi /
    // uiToSi plumbing as every other length, so imperial works for free.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ units: { length: 'in' } }));
    mount();
    pick(printerSelect(), 'bambu-h2d');
    expect(Number(axis('Bed X')!.value)).toBeCloseTo(350 / 25.4, 3);
    type(axis('Bed X')!, '10');
    expect(stored().printer!.x).toBeCloseTo(0.254, 12);
    expect(stored().printer!.preset).toBe('custom');
  });

  it('joint clearance is editable and defaults to 0.15 mm', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    const clearance = byLabel('Joint clearance (per side)') as HTMLInputElement;
    expect(clearance.value).toBe('0.15');
    type(clearance, '0.05');
    expect(stored().printer!.clearance).toBeCloseTo(0.00005, 12);
    // Tuning the glue gap is not a different machine.
    expect(stored().printer!.preset).toBe('bambu-h2d');
  });

  it('Not set removes the printer and the fields with it', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    pick(printerSelect(), '');
    expect(axis('Bed X')).toBeNull();
    expect(stored().printer).toBeUndefined();
  });

  it('describes the margin the split really keeps: both bed edges, and the top of Z only', () => {
    // splitSolid.usableBox takes it off X and Y twice and off Z ONCE — the part
    // stands on the bed. This hint said "at each end of every axis", which the
    // button's own figure (usable Z = Z - 8 mm) contradicts (audit 2026-09-22).
    mount();
    const hint = [...host.querySelectorAll('p.prefs-hint')]
      .map((p) => p.textContent ?? '').find((t) => t.includes('kept clear'))!;
    expect(hint).toContain('8 mm is kept clear at both edges of the bed in X and Y');
    expect(hint).toContain('at the top of Z');
    expect(hint).not.toContain('every axis');
  });

  /**
   * Audit 2026-09-30: each box's label was a bare sibling, so it reached the
   * unit chip inside it — clicking "Bed X" opened the unit list — and the box
   * was named by a second copy of the words in an aria-label, which had
   * already drifted: "Joint clearance" under "Joint clearance (per side)".
   */
  it('each box is the control of the label above it, and has no second name', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    for (const words of ['Bed X', 'Bed Y', 'Maximum Z', 'Joint clearance (per side)']) {
      const box = byLabel(words);
      expect(box?.tagName, words).toBe('INPUT');
      expect(box!.getAttribute('aria-label'), words).toBeNull();
    }
    expect(axis('Maximum Z')!.value).toBe('325');
    expect(axis('Joint clearance (per side)')!.value).toBe('0.15');
  });
});

/**
 * Audit 2026-09-30: every select in the dialog sat beside a bare <label> and
 * was named by an aria-label repeating its words. The label was tied to
 * nothing — clicking it did nothing — and the name lived in two strings.
 * jsx-a11y saw eight of them; the units grid's eleven hold their words in an
 * expression, which the rule assumes may contain a control, and were the same.
 */
describe('Preferences → every label names its own control', () => {
  const QUANTITIES = Object.keys(UNITS) as Quantity[];
  /**
   * The other selects: the words beside each, a value to pick (never the
   * default), and where that pick lands.
   */
  const SETTINGS: [string, string, (p: Preferences) => unknown][] = [
    ['Round components entered as', 'radius', (p) => p.radiusMode],
    ['Stability shown as', 'pct', (p) => p.stabilityUnit],
    ['CG / CP markers in 3D', 'callout', (p) => p.markers3d],
    ['Theme', 'light', (p) => p.theme],
    ['Daylight mode', 'on', (p) => (p.daylight ? 'on' : 'off')],
    ['First-run tour', 'off', (p) => (p.tourOff ? 'off' : 'on')],
    ['Aerodynamics model', 'supersonic', (p) => aeroChoiceOf(p)],
    ['Printer', 'bambu-h2d', (p) => p.printer?.preset],
  ];

  /**
   * Each label is shown to reach ITS select, not merely a select: the pick has
   * to MOVE the setting the words name. A value chosen off whatever the reached
   * select showed proved less. Velocity and Wind speed offer one list, and
   * Rocket and Motor dimensions share three units, so that value could already
   * be the named setting's own: Wind speed's label reaching the Velocity select
   * passed.
   */
  it('each select is the control of the label beside it, and has no second name', () => {
    let live: Preferences | undefined;
    function Live() {
      live = usePrefs().prefs;
      return null;
    }
    act(() => root.render(
      <PrefsProvider><Live /><PreferencesDialog onClose={() => {}} /></PrefsProvider>,
    ));
    const check = (words: string, value: string, read: (p: Preferences) => unknown) => {
      const select = byLabel(words) as HTMLSelectElement | null;
      expect(select?.tagName, words).toBe('SELECT');
      expect(select!.getAttribute('aria-label'), words).toBeNull();
      expect(read(live!), `${words} already reads ${value}`).not.toBe(value);
      pick(select!, value);
      expect(read(stored()), words).toBe(value);
    };
    for (const q of QUANTITIES) {
      check(QUANTITY_LABEL[q], UNITS[q].map((u) => u.symbol).find((s) => s !== live!.units[q])!, (p) => p.units[q]);
    }
    for (const [words, value, read] of SETTINGS) check(words, value, read);
  });

  it('every label in the dialog reaches its own field, never a unit chip, and the field has no second name', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d'); // every field on screen
    const labels = [...host.querySelectorAll('label')];
    expect(labels).toHaveLength(QUANTITIES.length + SETTINGS.length + 4);
    for (const l of labels) {
      const control = l.control;
      expect(control, `"${labelWords(l)}" labels nothing`).not.toBeNull();
      expect(control!.classList.contains('unit-chip'), labelWords(l)).toBe(false);
      expect(control!.hasAttribute('aria-label'), labelWords(l)).toBe(false);
    }
    // One label each way. Two labels reaching one field leave another with no
    // label and no name at all, which the loop above cannot see.
    const reached = labels.map((l) => l.control);
    const fields = [...host.querySelectorAll<HTMLElement>('select, input')]
      .filter((f) => !f.classList.contains('unit-chip'));
    expect(new Set(reached).size, 'two labels reach one field').toBe(labels.length);
    expect(fields.filter((f) => !reached.includes(f)).map((f) => f.id), 'fields no label reaches').toEqual([]);
    expect(fields).toHaveLength(labels.length);
  });

  it('clicking the words reaches the select (happy-dom forwards the click; a browser focuses it)', () => {
    mount();
    const theme = byLabel('Theme')!;
    let clicks = 0;
    theme.addEventListener('click', () => { clicks++; });
    const label = [...host.querySelectorAll('label')].find((l) => labelWords(l) === 'Theme')!;
    act(() => { label.click(); });
    expect(clicks).toBe(1);
  });
});

/**
 * The First-run tour setting. Two localStorage keys were involved and this
 * select only ever wrote one of them: the preference blob, while the tour's
 * own "seen" flag lives under its own key and was written solely by
 * dismissing the tour. That made Off look inert (the seen flag was already
 * suppressing the tour) and made On a dead option — nothing cleared the flag,
 * so "show once to new visitors" could never show it to anyone again.
 */
describe('Preferences → First-run tour', () => {
  const TOUR_KEY = 'online-openrocket.tour.v1';
  const tourSelect = (): HTMLSelectElement => byLabel('First-run tour') as HTMLSelectElement;

  it('Off is durable — it stores the preference AND the tour’s own seen flag', () => {
    mount();
    pick(tourSelect(), 'off');
    expect(stored().tourOff).toBe(true);
    expect(localStorage.getItem(TOUR_KEY)).toBe('done');
  });

  it('the select stays on Off afterwards (the "it reverted" symptom)', () => {
    mount();
    pick(tourSelect(), 'off');
    expect(tourSelect().value).toBe('off');
  });

  it('On genuinely re-arms the tour — it clears the seen flag', () => {
    localStorage.setItem(TOUR_KEY, 'done');
    mount();
    pick(tourSelect(), 'off');
    pick(tourSelect(), 'on');
    expect(stored().tourOff).toBe(false);
    // A marker, not a removal: shouldAutoStartTour also refuses once a session
    // exists, and by the time anyone opens Preferences one always does — so
    // clearing the flag alone would leave "On" a dead option.
    expect(localStorage.getItem(TOUR_KEY)).toBe('rearm');
  });
});

/**
 * The two-controls collision the owner asked to have exercised: the vitals
 * strip's session switch and this dialog's durable setting can disagree, and
 * the app must never leave the user looking at two selects showing different
 * models with nothing saying why.
 */
describe('Preferences → Aerodynamics vs the strip override', () => {
  const aeroSelect = (): HTMLSelectElement => byLabel('Aerodynamics model') as HTMLSelectElement;

  /** Renders the dialog plus a stand-in for the strip switch, one provider. */
  const mountBoth = () => act(() => root.render(
    <PrefsProvider>
      <StripStub />
      <PreferencesDialog onClose={() => {}} />
    </PrefsProvider>,
  ));

  function StripStub() {
    const { prefs, aeroOverride, setAeroOverride } = usePrefs();
    return (
      <select aria-label="strip" value={aeroOverride ?? aeroChoiceOf(prefs)}
        onChange={(e) => setAeroOverride(e.target.value as AeroChoice)}>
        <option value="kbf">kbf</option>
        <option value="eb">eb</option>
        <option value="auto">auto</option>
        <option value="supersonic">supersonic</option>
      </select>
    );
  }
  const strip = (): HTMLSelectElement => host.querySelector('select[aria-label="strip"]')!;

  it('the strip switch does NOT write the preference', () => {
    mountBoth();
    pick(strip(), 'supersonic');
    // The stored blob is either untouched or carries no aero fields at all.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw === null || JSON.parse(raw).aeroModel === undefined).toBe(true);
    // ...and the durable select still shows the durable value.
    expect(aeroSelect().value).toBe('kbf');
  });

  it('says so, rather than leaving two selects silently disagreeing', () => {
    mountBoth();
    pick(strip(), 'supersonic');
    expect(host.textContent).toContain('overriding the setting above');
    expect(host.textContent).toContain('Supersonic');
  });

  it('one click goes back to the stored preference', () => {
    mountBoth();
    pick(strip(), 'supersonic');
    const revert = Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').startsWith('Go back to')) as HTMLButtonElement;
    expect(revert.textContent).toBe('Go back to Rogers Kbf');
    act(() => { revert.click(); });
    expect(strip().value).toBe('kbf');
    expect(host.textContent).not.toContain('overriding the setting above');
  });

  it('CHOOSING here outranks the strip — the newer, more deliberate act wins', () => {
    mountBoth();
    pick(strip(), 'supersonic');
    pick(aeroSelect(), 'eb');
    expect(stored().aeroModel).toBe('classic');
    expect(stored().rogersKbf).toBe(false);
    // The override is gone, so both controls agree again.
    expect(strip().value).toBe('eb');
    expect(host.textContent).not.toContain('overriding the setting above');
  });

  it('an UNRELATED preference write must not clear the override', () => {
    // setPrefs is called with a spread for Daylight, the results tiles and
    // more; clearing on every write would make the strip switch undoable by
    // a theme toggle.
    mountBoth();
    pick(strip(), 'supersonic');
    pick(byLabel('Daylight mode') as HTMLSelectElement, 'on');
    expect(strip().value).toBe('supersonic');
    expect(host.textContent).toContain('overriding the setting above');
  });

  it('no hint at all when the strip agrees with the preference', () => {
    mountBoth();
    pick(strip(), 'kbf'); // the stored default
    expect(host.textContent).not.toContain('overriding the setting above');
  });

  /**
   * The same choice made from either control flies the same physics (audit
   * 2026-09-22, row 499). The choice → (model, Kbf) mapping used to be written
   * twice — here and in PrefsContext's override branch — kept in step only by
   * a comment, so one edit could fly a different rocket depending on which
   * select set it. Both now read prefsForAeroChoice; this pins the outcome.
   */
  it('each choice made here flies exactly what the strip flies for it', () => {
    const choices: AeroChoice[] = ['eb', 'kbf', 'auto', 'supersonic'];
    mountBoth();
    for (const c of choices) {
      pick(aeroSelect(), c);
      // Chosen here: no override, so what flies is the stored preference.
      expect(effectiveAero(stored(), null), c).toEqual(effectiveAero(stored(), c));
      // And the strip shows the choice made.
      expect(strip().value).toBe(c);
    }
  });
});

describe('Preferences → CG / CP markers in 3D', () => {
  const markerSelect = (): HTMLSelectElement => byLabel('CG / CP markers in 3D') as HTMLSelectElement;

  it('defaults to showing everything, and stores nothing until asked', () => {
    mount();
    expect(markerSelect().value).toBe('both');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('persists the choice', () => {
    mount();
    pick(markerSelect(), 'off');
    expect(stored().markers3d).toBe('off');
    pick(markerSelect(), 'callout');
    expect(stored().markers3d).toBe('callout');
  });
});
