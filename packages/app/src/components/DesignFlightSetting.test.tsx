// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { nozzleEditableStageIds } from '../tree/treeModel.js';
import type { DesignFlightContext } from './DesignFlightSetting.js';
import { MotorLengthReadout } from './MotorLengthField.js';
import { PropertyPanel } from './PropertyPanel.js';

/**
 * CFG-3 (CFG-SPEC B1 and A4, ruling D2a): Design shows deployment, separation
 * and the nozzle exit READ-ONLY, with a link to their one editor on Motors &
 * Configuration; Max motor length is edited only on Design, with its Estimate,
 * and the motor card shows it read-only.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];
let opened: string[];

const tree = {
  name: 'R',
  components: [
    { id: 'top', type: 'stage', name: 'Sustainer', separationEvent: 'launch', nozzleExitDiameter: 0.0381, children: [
      { id: 'tube', type: 'bodytube', name: 'Body', length: 0.5, outerRadius: 0.02, thickness: 0.001, children: [
        { id: 'mount', type: 'innertube', name: 'Mount', length: 0.2, outerRadius: 0.0145, thickness: 0.0005,
          motorMount: true, maxMotorLength: 0.15 },
        { id: 'ribbon', type: 'streamer', name: 'Ribbon', deployEvent: 'apogee' },
      ] },
    ] },
    { id: 'booster', type: 'stage', name: 'Booster', separationEvent: 'burnout', separationDelay: 1, children: [
      { id: 'btube', type: 'bodytube', name: 'Booster body', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
    ] },
  ],
} as unknown as RocketTree;
const node = (id: string) => {
  const find = (nodes: ComponentNode[]): ComponentNode | undefined =>
    nodes.map((n) => (n.id === id ? n : find(n.children ?? []))).find(Boolean);
  return find(tree.components)!;
};

const context = (over: Partial<DesignFlightContext> = {}): DesignFlightContext => ({
  overrides: { separations: { booster: { separationEvent: 'never', separationDelay: 0, separationAltitude: 200 } } },
  configLabel: 'Club field', detached: false,
  onOpenPart: (id) => opened.push(`part:${id}`), onOpenNozzle: (id) => opened.push(`nozzle:${id}`),
  nozzleEditable: nozzleEditableStageIds(tree),
  ...over,
});

const mount = (id: string, flight?: DesignFlightContext) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node(id)} onPatch={(p) => patches.push(p as Record<string, unknown>)} flight={flight} />
  </PrefsProvider>,
));
const group = (label: string) => host.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);

it('offers definitions for read-only deployment, separation and nozzle settings on Design', () => {
  mount('ribbon', context());
  expect(group('Deployment')?.querySelector('button[aria-label="Definition: Deployment"]')).not.toBeNull();
  mount('booster', context());
  expect(group('Separation')?.querySelector('button[aria-label="Definition: Separation"]')).not.toBeNull();
  expect(group('Nozzle exit')?.querySelector('button[aria-label="Definition: Nozzle exit"]')).not.toBeNull();
});

beforeEach(() => {
  localStorage.clear();
  patches = [];
  opened = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('Design shows separation read-only', () => {
  it('a lower stage: own setting, the active override, and a link to its row; no editable separation field', () => {
    mount('booster', context());
    expect(host.querySelector('select[aria-label^="Separate at"]')).toBeNull();
    expect(host.querySelector('input[aria-label^="Separation"]')).toBeNull();
    const block = group('Separation')!;
    expect(block.querySelector('h3')!.textContent).toBe('Separation');
    expect(block.textContent).toContain("Own setting: This stage's motor burnout, delay 1 s");
    expect(block.textContent).toContain('In “Club field”: overridden — Never');
    // D7 I10 (carried from the retired FlightOverrideBanner): beside each
    // setting, whether it is the one that flies; the effective override is a
    // Caution note that says so in words.
    expect([...block.querySelectorAll('p')].map(p => p.textContent)).toEqual([
      "Own setting: This stage's motor burnout, delay 1 s — not flown in “Club field”",
      '⚠ Caution: In “Club field”: overridden — Never']);
    expect(block.querySelector('p.message-caution')).not.toBeNull();
    act(() => block.querySelector<HTMLButtonElement>('button[aria-label="Separation: set on Motors & Configuration"]')!.click());
    expect(opened).toEqual(['part:booster']);
    expect(patches).toEqual([]);
  });

  it('the top stage says it never separates and offers no link, since it has no row to go to', () => {
    mount('top', context());
    const block = group('Separation')!;
    expect(block.textContent).toContain('The top stage never separates');
    expect(block.querySelector('button[aria-label="Separation: set on Motors & Configuration"]')).toBeNull();
    expect(host.querySelector('select[aria-label^="Separate at"]')).toBeNull();
  });

  it('a streamer gets the Deployment heading and no deploy fields', () => {
    mount('ribbon', context());
    const block = group('Deployment')!;
    expect(block.textContent).toContain('Own setting: Apogee');
    expect(block.textContent).not.toContain('overridden');
    expect(block.textContent).not.toContain('not flown');
    expect(block.querySelector('.message-tier')).toBeNull();
    expect(host.querySelector('select[aria-label="Deploy at"]')).toBeNull();
    act(() => block.querySelector('button')!.click());
    expect(opened).toEqual(['part:ribbon']);
  });
});

describe('Design shows the nozzle exit read-only (A4)', () => {
  it('names the value and links to the stage field when the stage has a mount', () => {
    mount('top', context());
    expect(host.querySelector('input[aria-label^="Nozzle exit diameter"]')).toBeNull();
    const block = group('Nozzle exit')!;
    expect(block.textContent).toContain('Nozzle exit: 38.1 mm');
    act(() => block.querySelector('button')!.click());
    expect(opened).toEqual(['nozzle:top']);
  });

  it('says automatic for a blank value, and offers no link where Motors & Configuration shows no field', () => {
    mount('booster', context());
    const block = group('Nozzle exit')!;
    expect(block.textContent).toContain('Nozzle exit: automatic');
    expect(block.textContent).toContain('once this stage has a motor mount');
    expect(block.querySelector('button[aria-label="Nozzle exit: edit on Motors & Configuration"]')).toBeNull();
  });

  it('lists a stage for the motors-tab field when it has a mount or already carries a value', () => {
    expect([...nozzleEditableStageIds(tree)]).toEqual(['top']);
    const valued = { ...tree, components: [tree.components[0]!, { ...tree.components[1]!, nozzleExitDiameter: 0 }] } as RocketTree;
    expect([...nozzleEditableStageIds(valued)].sort()).toEqual(['booster', 'top']);
  });
});

describe('Max motor length is edited on Design, with its Estimate (A4)', () => {
  it('the mount panel has the field under a stable id and the Estimate button', () => {
    mount('mount', context());
    const field = document.getElementById('design-motor-length-mount') as HTMLInputElement;
    expect(field.getAttribute('aria-label')).toBe('Max motor length for Mount');
    expect(field.value).toBe('150');
    const estimate = host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Mount"]')!;
    expect(estimate).not.toBeNull();
    expect(host.textContent).toMatch(/Room for [\d.]+ mm to /);
    act(() => estimate.click());
    expect(patches).toHaveLength(1);
    expect(typeof patches[0]!['maxMotorLength']).toBe('number');
  });

  it('the motor card shows it read-only and links to Design', () => {
    const go: string[] = [];
    const render = (value: number | null) => act(() => root.render(<PrefsProvider>
      <MotorLengthReadout mountName="Mount" value={value} onOpenDesign={() => go.push('design')} />
    </PrefsProvider>));
    render(0.15);
    expect(host.textContent).toContain('Max motor length: 150 mm');
    expect(host.querySelector('input')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Max motor length for Mount: set on Design"]')!.click());
    expect(go).toEqual(['design']);
    expect(host.querySelector('button')!.textContent).toBe('set on Design ▸');
    render(null);
    expect(host.textContent).toContain('Max motor length: no limit');
  });
});
