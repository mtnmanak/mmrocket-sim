// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { OVERRIDE_INCLUDES_MOTOR } from '../services/statedLaunchWeight.js';

/**
 * A stage whose mass and CG overrides are the RASAero file's stated LAUNCH
 * figures, with the weight of a motor the catalogue does not have still inside
 * them (services/statedLaunchWeight.ts).
 *
 * TWO DEFECTS, both 2026-09-08 from review. The Overrides panel said nothing
 * about the mark — the fields looked like any other pair of typed numbers. And
 * nothing cleared it when the user retyped one: `onCommit` patches through
 * `updateNode`, which spreads and cannot delete, so the mark survived the
 * user's own measurement. Type 3.6 kg over the file's figure, load the M787,
 * and the reconcile subtracted a motor from a number the file never stated —
 * then blamed the file for it ("the 3.6 kg the RASAero file stated for that
 * stage … the file's weight cannot be right").
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const stage = (over: Record<string, unknown> = {}): ComponentNode => ({
  id: 's1',
  type: 'stage',
  name: 'Sustainer',
  overrideMass: 10.573,
  overrideSubcomponentsMass: true,
  overrideCGX: 1.168,
  overrideSubcomponentsCG: true,
  ...over,
  children: [{ id: 'b1', type: 'bodytube', length: 2.4, outerRadius: 0.04, thickness: 0.002 }],
} as unknown as ComponentNode);

const treeOf = (node: ComponentNode): RocketTree =>
  ({ name: 'R', components: [node] } as unknown as RocketTree);

const mount = (node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={treeOf(node)} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const field = (label: string): HTMLInputElement =>
  host.querySelector(`input[aria-label="${label}"]`)!;

/** Native setter + input event — how React sees a real keystroke. */
const type = (label: string, value: string) => {
  act(() => {
    const el = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const banner = () => host.querySelector('.override-stated-launch');

beforeEach(() => {
  localStorage.clear();
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('PropertyPanel — a stage still holding the file’s stated launch weight', () => {
  it('says the figures came from the file with the motor still in them', () => {
    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787' }));
    const note = banner();
    expect(note).toBeTruthy();
    const text = note!.textContent!;
    expect(text).toContain('RASAero file');
    expect(text).toContain('M787');       // the motor whose weight is inside them
    expect(text).toContain('Browse motor database');
    // House voice: it explains, it does not sell.
    expect(text).not.toMatch(/\bwe\b/i);
  });

  it('names only the figure that is actually there', () => {
    // 2026-09-08, from review. The mark follows whichever override the import
    // landed, and either can land alone — a stage stating a CG and no usable
    // weight gets the CG by itself, one whose CG works out to a place outside
    // its own extent gets the mass by itself. The banner said "the launch mass
    // and CG" on the mark alone, pointing at a blank field.
    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787', overrideMass: undefined }));
    const cgOnly = banner()!.textContent!;
    expect(cgOnly).toContain('It is the launch CG the file states');
    expect(cgOnly).not.toContain('mass and CG');
    expect(cgOnly).toContain('where the stage balances');

    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787', overrideCGX: undefined }));
    const massOnly = banner()!.textContent!;
    expect(massOnly).toContain('It is the launch mass the file states');
    expect(massOnly).not.toContain('mass and CG');
    expect(massOnly).toContain('what the stage weighs');

    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787' }));
    const both = banner()!.textContent!;
    expect(both).toContain('They are the launch mass and CG the file states');
    expect(both).toContain('both become yours');
  });

  it('says nothing on an ordinary stage', () => {
    mount(stage());
    expect(banner()).toBeNull();
  });

  it('typing a mass takes the stage OFF the file’s stated weight', () => {
    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787' }));
    type('Mass override', '3600');
    expect(patches).toHaveLength(1);
    const p = patches[0]!;
    expect(typeof p['overrideMass']).toBe('number');
    expect(OVERRIDE_INCLUDES_MOTOR in p).toBe(true);
    expect(p[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });

  it('typing a CG does too — the mark covers both figures', () => {
    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787' }));
    type('CG override, from component top', '900');
    expect(patches).toHaveLength(1);
    const p = patches[0]!;
    expect(typeof p['overrideCGX']).toBe('number');
    expect(p[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(OVERRIDE_INCLUDES_MOTOR in p).toBe(true);
  });

  it('CLEARING a marked override drops the mark as well', () => {
    // A cleared override leaves nothing for the reconcile to correct, so a mark
    // left behind could only produce a notice about a number that is gone.
    mount(stage({ [OVERRIDE_INCLUDES_MOTOR]: 'M787' }));
    type('Mass override', '');
    expect(patches[0]).toEqual({
      overrideMass: undefined,
      overrideSubcomponentsMass: undefined,
      [OVERRIDE_INCLUDES_MOTOR]: undefined,
    });
  });

  it('an unmarked stage’s commits are untouched', () => {
    mount(stage());
    type('Mass override', '3600');
    expect(OVERRIDE_INCLUDES_MOTOR in patches[0]!).toBe(false);
  });
});
