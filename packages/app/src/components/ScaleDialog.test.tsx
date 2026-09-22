// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { ScaleDialog } from './ScaleDialog.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { ScaleResult } from '../tree/scaleRocket.js';

/**
 * The dialog's own job is the FACTOR ↔ TARGET DIAMETER link — the pair desktop
 * OpenRocket calls "Scale from X to Y", and the half of the feature a user
 * actually reaches for ("I have 4 inch tube; what does this 2.6 inch plan
 * become?"). Getting that inverse wrong silently scales by the reciprocal, and
 * nothing downstream would notice.
 *
 * Rendered through react-dom's own root API with React's `act` — no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The preset catalogue is a 1.8 MB lazy import. Mocking it with an EMPTY array
 * (as this file first did) leaves the tube dropdown with no options, so the
 * catalogue -> factor division never runs — and that is the THIRD place a
 * reciprocal could hide, after the two NumFields. Mock it with real-shaped rows
 * instead, including a duplicate OD so the 0.1 mm bucketing is exercised.
 */
vi.mock('../services/presets.js', () => ({
  loadPresets: () => Promise.resolve([
    { kind: 'BodyTube', manufacturer: 'LOC', partNo: '4.0in', description: '', outsideDiameter: 0.102 },
    { kind: 'BodyTube', manufacturer: 'Other', partNo: 'dup', description: '', outsideDiameter: 0.10201 },
    { kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT-55', description: '', outsideDiameter: 0.0334 },
    { kind: 'NoseCone', manufacturer: 'X', partNo: 'nc', description: '', outsideDiameter: 0.5 },
  ]),
}));

let host: HTMLDivElement;
let root: Root;

/** 54 mm airframe: max body diameter 0.052 m. */
const tree = (): RocketTree => ({
  name: 'r',
  components: [{
    type: 'stage', id: 's', children: [
      { type: 'nosecone', id: 'n', length: 0.25, aftRadius: 0.026 } as ComponentNode,
      {
        type: 'bodytube', id: 'b', length: 0.8, outerRadius: 0.026, thickness: 0.0015,
        children: [{
          type: 'innertube', id: 'm', length: 0.3, outerRadius: 0.0145, thickness: 0.0008,
          motorMount: true, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

let applied: ScaleResult | null = null;
let closes = 0;

/**
 * Flush the microtask the mocked `loadPresets` resolves on, INSIDE act(), so the
 * resulting setState is not an unwrapped update. Without it this file was the
 * only one in the suite printing React act() warnings.
 */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const render = async (assigned: Record<string, number> = {}, design: RocketTree = tree()) => {
  applied = null;
  closes = 0;
  act(() => {
    root.render(
      <PrefsProvider>
        <ScaleDialog
          tree={design}
          assignedMotorDiameters={assigned}
          onApply={(r) => { applied = r; }}
          onSaveBackup={() => {}}
          onClose={() => { closes++; }}
        />
      </PrefsProvider>,
    );
  });
  // The mocked loadPresets resolves on a microtask; flush it INSIDE act() so
  // its setState is not an unwrapped update. Every test needs this, not just
  // the two that touch the dropdown.
  await flush();
};

const numberInputs = (): HTMLInputElement[] =>
  [...host.querySelectorAll('input')].filter((i) => i.type !== 'checkbox');

const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const text = () => host.textContent ?? '';
const applyButton = (): HTMLButtonElement => [...host.querySelectorAll('button')]
  .find((b) => b.textContent?.includes('Scale to'))!;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ScaleDialog', () => {
  it('shows the design it is about to scale, in the preference units', async () => {
    await render();
    // Metric default: 1050 mm long, 52 mm across, doubling by default.
    expect(text()).toContain('1050 × 52 mm becomes 2100 × 104 mm');
    expect(text()).toContain('200.0 %');
  });

  it('keeps the design readable in metres and feet, not "1 × 0.1 m"', async () => {
    // Audit 2026-09-22: one fixed decimal in the DISPLAY unit made a 1050 mm ×
    // 52 mm rocket "1 × 0.1 m becomes 2 × 0.1 m", and two fixed decimals put
    // both catalogue sizes under one "0.03"/"0.10"-style label.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'm' } }));
    await render();
    expect(text()).toContain('1.05 × 0.052 m becomes 2.1 × 0.104 m');
    expect(text()).toContain('The widest body diameter is 0.052 m today');
    const labels = [...(host.querySelector('#scale-tube') as HTMLSelectElement)
      .querySelectorAll('optgroup')].map((g) => g.label);
    expect(labels).toEqual(['0.0334 m', '0.102 m']);

    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'ft' } }));
    await render();
    expect(text()).toContain('3.44 × 0.171 ft becomes 6.89 × 0.341 ft');
  });

  it('typing a target diameter sets the reciprocal-correct factor', async () => {
    await render();
    const [, target] = numberInputs();
    // 52 mm airframe → 102 mm tube. The factor must be 102/52 = 1.9615…,
    // NOT 52/102. A reversed division still "works" and still scales the
    // rocket, which is exactly why this is pinned.
    type(target!, '102');
    expect(text()).toContain('196.2 %');
    expect(text()).toContain('× 102 mm');
  });

  it('typing a factor moves the target diameter with it', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('50.0 %');
    expect(text()).toContain('× 26 mm'); // half of 52 mm
  });

  it('names the motor mount it is about to make un-buyable', async () => {
    await render();
    // 27.4 mm bore doubled is 54.8 mm — close to the standard 54, but not it.
    expect(text()).toContain('Motor mount');
    expect(text()).toMatch(/not a motor size you can buy/);
  });

  it('warns when the loaded motor will no longer fit', async () => {
    await render({ m: 0.029 }); // a 29 mm motor in the mount, then halve the rocket
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('no longer fit');
  });

  it('applies the factor that is on screen', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '3');
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(applied).not.toBeNull();
    const bt = applied!.tree.components[0]!.children![1]!;
    expect(bt['outerRadius']).toBeCloseTo(0.026 * 3, 12);
    expect(bt['length']).toBeCloseTo(0.8 * 3, 12);
  });

  it('picking a catalogue tube sets the factor from ITS diameter, not the reciprocal', async () => {
    await render();
    const sel = host.querySelector('select') as HTMLSelectElement;
    // EVERY tube is now an option; the 0.1 mm buckets became the <optgroup>s.
    // 0.102 and 0.10201 are the same nominal 4 inch size so they share a group,
    // and BOTH are selectable, which is the point of the change.
    expect(sel.options.length).toBe(1 + 3); // placeholder + all three body tubes
    // Scoped to the TUBE select: each motor mount now has its own size
    // pulldown, which carries a 'Standard sizes' optgroup of its own.
    expect(sel.querySelectorAll('optgroup').length).toBe(2); // 33.4 mm and 102 mm
    const loc = [...sel.options].find((o) => o.textContent?.includes('LOC 4.0in'))!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, loc.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 102 / 52 = 1.9615… — a reversed division gives 51.0 % and SHRINKS it.
    expect(text()).toContain('196.2 %');
    // …and the widget keeps the choice rather than snapping back, which is what
    // made it unusable from the keyboard.
    expect(sel.value).toBe(loc.value);
    expect(sel.value).not.toBe('');
  });

  it('a tube hidden behind the old "(+N more)" is selectable, and applies ITS OWN diameter', async () => {
    // The reported bug (2026-09-01a). The list showed ONE row per 0.1 mm bucket,
    // so 'Other dup' - the same nominal 4 inch size as 'LOC 4.0in' - had no
    // option of its own and could not be chosen at all. On the shipped data that
    // hid 1,094 of 1,309 body tubes; the owner's own Composite Warehouse
    // "4 Inch Airframe" sat 13th of 13 in its bucket, behind a label naming a
    // different manufacturer entirely.
    await render();
    const sel = host.querySelector('select') as HTMLSelectElement;
    const dup = [...sel.options].find((o) => o.textContent?.includes('Other dup'));
    expect(dup, 'the second tube in the 102 mm bucket needs its own option').toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, dup!.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The distinguishing assertion: 0.10201 is applied, NOT the bucket's first
    // row (0.102). Both round to "196.2 %" on screen, so the percentage cannot
    // tell them apart - the applied geometry can.
    const applyBtn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!;
    act(() => { applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const bt = applied!.tree.components[0]!.children![1]!;
    expect((bt['outerRadius'] as number) * 2).toBeCloseTo(0.10201, 9);
  });

  it('in inches, two group labels do not collapse onto the same number', async () => {
    // fmt(od, 2) in inches is 0.254 mm of resolution, so distinct sizes print
    // the same label - on the shipped catalogue 84 of 215 sizes shared a number
    // with another. The group heading is the ONLY thing telling one 4-inch
    // bucket from another, so it gets three decimals in inches.
    // 0.102 m = 4.016 in and 0.10201 m = 4.017 in: the same label at two
    // decimals (4.02 / 4.02), distinct at three. The mock has them in separate
    // 0.1 mm buckets only if they differ by >= 0.1 mm - they do not, so this
    // uses the 33.4 mm tube against a 4-inch one instead.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      units: { length: 'in' },
    }));
    await render();
    const tubeSel = host.querySelector('#scale-tube') as HTMLSelectElement;
    const labels = [...tubeSel.querySelectorAll('optgroup')].map((g) => g.label);
    expect(labels.length).toBe(2);
    for (const l of labels) expect(l).toMatch(/in$/);
    // Three decimals, not two: "4.016 in", never "4.02 in".
    expect(labels.some((l) => /\d\.\d{3} in/.test(l)), `got ${labels.join(' / ')}`).toBe(true);
  });

  it('setting the factor any other way clears the catalogue choice', async () => {
    // The catalogue select names a tube; the factor box names a number. Once
    // the factor is changed from anywhere else, the select is naming a tube
    // whose OD contradicts the factor on screen. This was pasted into two
    // handlers and MISSED on the 0.5x / 2x buttons, which is the bug — so all
    // three entry points are exercised here, not just the one that had it.
    const pick = (sel: HTMLSelectElement) => act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, 'value')!.set!;
      // The first real tube, whatever index it has.
      setter.call(sel, sel.options[1]!.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 1. the quick buttons — the entry point that lacked the clear
    await render();
    let sel = host.querySelector('select') as HTMLSelectElement;
    pick(sel);
    expect(sel.value).not.toBe('');
    const quick = [...host.querySelectorAll('button')].find((b) => b.textContent === '2×')!;
    act(() => { quick.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(sel.value, 'the 2× button must clear the catalogue choice').toBe('');
    expect(text()).toContain('200.0 %');

    // 2. typing a factor
    await render();
    sel = host.querySelector('select') as HTMLSelectElement;
    pick(sel);
    type(numberInputs()[0]!, '3');
    expect(sel.value, 'typing a factor must clear the catalogue choice').toBe('');

    // 3. typing a target diameter
    await render();
    sel = host.querySelector('select') as HTMLSelectElement;
    pick(sel);
    type(numberInputs()[1]!, '78');
    expect(sel.value, 'typing a diameter must clear the catalogue choice').toBe('');
  });

  it('the snap checkbox reaches the transform and changes the result', async () => {
    await render();
    const box = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box, 'the mount is off-class at 2x, so the box must be offered').toBeTruthy();
    // A real click: React tracks the node's checked value, so assigning it
    // directly and firing 'change' never reaches onChange - the checkbox
    // looked ticked and the state stayed false, which is precisely the
    // "checkbox is inert" symptom this test exists to rule out.
    act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // The LIST must show the bore the user gets, or it contradicts the fit
    // verdict on the same line: 54.0, not the 54.8 it passed through.
    expect(text()).toContain('54.0 mm');
    // DOWN, and the word is not decorative. 54.8 snaps to 54: both the bore and
    // the outer radius get SMALLER, and the copy said "snapped up" in every
    // case because the direction was hard-coded. This fixture is one of the two
    // the suite already had, and both of them snap downward — so the assertion
    // that pinned "up" was pinning the bug.
    expect(text()).toContain('snapped down from 54.8 mm');
    expect(text()).not.toContain('snapped up');
    // 27.4 mm bore x2 = 54.8, snapped to the standard 54: outer radius is
    // 54/2 + the scaled 0.8 mm wall = 28.6 mm.
    const mount = applied!.tree.components[0]!.children![1]!.children![0]!;
    expect(mount['outerRadius']).toBeCloseTo(0.054 / 2 + 0.0008 * 2, 12);
    // The note carries the direction too, and says the same thing the list
    // says — they are rendered from one `verdict`, not from two re-derivations.
    expect(applied!.notes.join(' ')).toContain('snapped down to the standard 54 mm');
  });

  it('the preview follows the snap setting, so a fixed warning disappears', async () => {
    // 27.4 mm bore at 1.9x is 52.1 mm - a 54 motor will not enter it - but
    // snapped the bore is exactly 54 and it fits. If the preview ignores the
    // checkbox it keeps warning about a problem the user has just solved.
    await render({ m: 0.054 });
    const [factor] = numberInputs();
    type(factor!, '1.9');
    expect(text()).toContain('no longer fit');
    const box = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(text()).not.toContain('no longer fit');
  });

  it('refuses a factor of 1 rather than committing a no-op undo step', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '1');
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('re-selecting the placeholder leaves the factor alone', async () => {
    // The placeholder is a real <option value="">, and `Number('')` is 0 — so
    // clearing the tube choice used to index tubeRows[0]. That list is sorted
    // ASCENDING by outside diameter, so it landed on the smallest tube in the
    // catalogue (here Estes BT-55 at 33.4 mm) and nothing reset it:
    // setFactorOffCatalogue only runs when the factor is edited elsewhere.
    // Found by the 2026-09-08 audit.
    await render();
    const sel = host.querySelector('select') as HTMLSelectElement;
    const setValue = (v: string) => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(sel, v);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    const loc = [...sel.options].find((o) => o.textContent?.includes('LOC 4.0in'))!;
    setValue(loc.value);
    const chosen = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!.textContent;
    // Now clear it. The factor must be exactly what the 4 inch tube set, not
    // the 33.4 mm one — which on this design reads a different percentage.
    setValue('');
    const after = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!.textContent;
    expect(after, 'clearing the tube choice must not re-scale off tubeRows[0]')
      .toBe(chosen);
  });

  /**
   * Audit 2026-09-22: the target-diameter spinner stepped 1 in the DISPLAY
   * unit, so in metres one ▴ added a metre to the airframe (×11.2 on a 98 mm
   * rocket). It steps a millimetre's worth in every unit now.
   */
  it('the target-diameter spinner steps a millimetre in metres, not a metre', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'm' } }));
    await render();
    const [, target] = numberInputs();
    const up = target!.closest('.numfield')!.querySelector('button')!;
    act(() => { up.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // (0.104 + 0.001) / 0.052, not (0.104 + 1) / 0.052 = 2123.1 %.
    expect(applyButton().textContent).toBe('Scale to 201.9 %');
  });

  /**
   * Audit 2026-09-22: nothing bounded the mount sizes or the factor. A 380 mm
   * custom bore previewed as "resized" in a 98 mm rocket and applied a motor
   * tube four times wider than the airframe around it; the Standard sizes list
   * took an oversized class the same way; and the target diameter and the
   * catalogue could set a factor the factor box itself refuses.
   *
   * This design at ×2: the body tube is 2 × 49 = 98 mm inside and the mount's
   * scaled walls are 1.6 mm, so the widest bore that fits is 98 − 3.2 = 94.8 mm.
   */
  describe('bounds', () => {
    const mountSelect = () => host.querySelector<HTMLSelectElement>('#mount-size-m')!;
    const customBore = () =>
      host.querySelector<HTMLInputElement>('input[aria-label^="Custom mount bore"]')!;
    const pick = (el: HTMLSelectElement, v: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const mountOf = (r: ScaleResult) => r.tree.components[0]!.children![1]!.children![0]!;

    it('refuses a custom bore wider than the body tube it sits in', async () => {
      await render();
      pick(mountSelect(), 'custom');
      type(customBore(), '380');
      expect(customBore().getAttribute('aria-invalid')).toBe('true');
      expect(text()).not.toContain('380.0 mm mount you chose');
      expect(text()).toContain('at most 94.8 mm');
      type(customBore(), '94');
      expect(customBore().getAttribute('aria-invalid')).toBeNull();
      expect(text()).toContain('the 94.0 mm mount you chose');
      type(customBore(), '95');
      expect(customBore().getAttribute('aria-invalid')).toBe('true');
      act(() => { applyButton().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      // The last size that fitted is the one applied, inside the 98 mm bore.
      const mt = mountOf(applied!);
      expect((mt['outerRadius'] as number) * 2).toBeCloseTo(0.094 + 0.0032, 9);
    });

    it('greys out a standard size that would not fit, and keeps the ones that do', async () => {
      await render();
      const opt = (v: string) => [...mountSelect().options].find((o) => o.value === v)!;
      for (const big of ['c98', 'c132', 'c152']) expect(opt(big).disabled, big).toBe(true);
      for (const ok of ['c54', 'c75']) expect(opt(ok).disabled, ok).toBe(false);
    });

    it('will not apply a snap that makes a mount wider than its body tube', async () => {
      // A mount that nearly fills its tube: 46.4 mm bore, 48 mm outside, in a
      // 49 mm bore. At ×1.13 the scaled bore is 52.43 mm and the room
      // (49 − 1.6) × 1.13 = 53.56 mm, but the nearest standard size is 54.
      const tight = tree();
      const mt = tight.components[0]!.children![1]!.children![0]!;
      mt['outerRadius'] = 0.024;
      await render({}, tight);
      type(numberInputs()[0]!, '1.13');
      const snap = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      act(() => { snap.click(); });
      expect(text()).toContain('snapped up from 52.4 mm');
      expect(text()).toContain('at most 53.6 mm');
      expect(applyButton().disabled).toBe(true);
      // Nearest is not offered as a choice either, and the scaled size still is.
      expect([...mountSelect().options].find((o) => o.value === 'nearest')!.disabled).toBe(true);
      pick(mountSelect(), 'scaled');
      expect(applyButton().disabled).toBe(false);
    });

    it('refuses a typed target diameter past the factor box’s own 100×', async () => {
      await render();
      const [, target] = numberInputs();
      act(() => target!.focus());
      type(target!, '6000'); // 6000 / 52 = 115×
      expect(target!.getAttribute('aria-invalid')).toBe('true');
      expect(applyButton().textContent).toBe('Scale to 200.0 %');
    });

    it('will not apply a catalogue factor outside 0.01–100', async () => {
      // A 1 mm model: the 102 mm catalogue tube is ×102.
      const tiny: RocketTree = {
        name: 'tiny',
        components: [{
          type: 'stage', id: 's', children: [
            { type: 'bodytube', id: 'b', length: 0.02, outerRadius: 0.0005, thickness: 0.0001 } as ComponentNode,
          ],
        } as ComponentNode],
      };
      await render({}, tiny);
      const sel = host.querySelector('#scale-tube') as HTMLSelectElement;
      pick(sel, [...sel.options].find((o) => o.textContent?.includes('LOC 4.0in'))!.value);
      expect(applyButton().textContent).toBe('Scale to 10200.0 %');
      expect(applyButton().disabled).toBe(true);
      expect(text()).toContain('between 0.01× and 100×');
    });
  });

  it('closes on a backdrop click, not on a text selection dragged off the card', async () => {
    // Audit 2026-09-22 (useBackdropClose): the click after a drag lands on the
    // backdrop, the nearest element holding both the press and the release.
    await render();
    const backdrop = host.querySelector('.prefs-overlay')!;
    const heading = host.querySelector('[role="dialog"] h2')!;
    const gesture = (down: Element, up: Element) => act(() => {
      down.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      up.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    gesture(heading, backdrop);
    expect(closes).toBe(0);
    gesture(backdrop, backdrop);
    expect(closes).toBe(1);
  });

  it('says there is nothing to scale when the design has no airframe', async () => {
    act(() => {
      root.render(
        <PrefsProvider>
          <ScaleDialog
            tree={{ name: 'empty', components: [] }}
            assignedMotorDiameters={{}}
            onApply={() => {}}
            onSaveBackup={() => {}}
            onClose={() => {}}
          />
        </PrefsProvider>,
      );
    });
    await flush();
    expect(text()).toContain('nothing to scale');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Scale to')))
      .toBe(false);
  });
});
