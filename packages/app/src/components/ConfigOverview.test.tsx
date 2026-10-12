// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfigOverview } from './ConfigOverview.js';
import { ConfigPartEditors } from './ConfigPartEditors.js';
import { ConfigPanel } from './ConfigPanel.js';
import type { FlightOverrides, FlightTree, SavedConfig } from '../model/design.js';
import { describeFlightOverrides } from '../services/flightOverrideSummary.js';
import { activeFlightOverrides } from '../services/flightState.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
/** CFG-2 replaced CFG-1's read-only summaries with the scoped editors; the destinations are the same rows. */
function PartRows({ tree, overrides }: { tree: FlightTree; overrides: FlightOverrides }) {
  return <ConfigPartEditors tree={tree} overrides={overrides} ownerKey="a" configLabel="Flight A" detached={false}
    onEdit={noop} onEditStart={noop} onEditEnd={noop} onEditCancel={noop} onReset={noop} onResetAll={noop} onEverywhere={noop} />;
}
const tree: FlightTree = { name: 'T', ignitionDefaults: { mount: { event: 'automatic', delay: 0 } }, components: [
  { id: 'top', type: 'stage', name: 'Sustainer', children: [
    { id: 'mount', type: 'bodytube', name: 'Mount', motorMount: true },
    { id: 'chute', type: 'parachute', name: 'Main', deployEvent: 'altitude', deployAltitude: 100 },
    { id: 'streamer', type: 'streamer', name: 'Streamer', deployEvent: 'apogee' },
    { id: 'parallel', type: 'parallelstage', name: 'Boosters', separationEvent: 'burnout' },
  ] },
  { id: 'lower', type: 'stage', name: 'Lower', separationEvent: 'ejection' },
] };
const config: SavedConfig = { id: 'a', name: 'Flight A', isDefault: true,
  motors: { mount: { label: 'C6-5', ignition: { event: 'burnout', delay: 0 }, spec: {}, meta: {} } as SavedConfig['motors'][string] },
  deployments: { chute: { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 } },
  separations: { lower: { separationEvent: 'launch', separationDelay: 2, separationAltitude: 200 },
    top: { separationEvent: 'launch', separationDelay: 2, separationAltitude: 200 } },
  ignitions: { mount: { event: 'launch', delay: 2 }, gone: { event: 'never', delay: 0 } },
};

describe('CFG-1 comparison and summary', () => {
  it.each([
    ['lowerstageseparation', "Motor ejection charge, delay 2 s (the file's 'lower stage separation' is not supported here)"],
    ['foreign-event', "Motor ejection charge, delay 2 s (the file's 'foreign-event' is not supported here)"],
    ['NEVER', 'Never'],
  ])('CFG-1b shows flown recovery for %s in the grid and Recovery summary', (deployEvent, expected) => {
    const host = document.createElement('div'), root = createRoot(host);
    const tuple = { deployEvent, deployAltitude: 300, deployDelay: 2 };
    const overridden = { ...config, deployments: { chute: tuple } };
    const overrides = { deployments: overridden.deployments };
    const ownTree: FlightTree = { name: 'Own', components: [{ id: 'own', name: 'Own chute', type: 'parachute', ...tuple }] };
    try {
      act(() => root.render(<>
        <ConfigOverview tree={tree} configs={[overridden]} activeConfigId="a" onApply={() => {}} onShowPart={() => {}} />
        <PartRows tree={tree} overrides={overrides} />
        <ConfigOverview tree={ownTree} configs={[config]} activeConfigId="a" onApply={() => {}} onShowPart={() => {}} />
        <PartRows tree={ownTree} overrides={{}} />
      </>));
      const grids = host.querySelectorAll('table');
      expect(grids[0]!.querySelectorAll('td')[1]!.textContent).toBe(`${expected} — override`);
      expect(host.querySelectorAll('#cfg-part-chute p')[1]!.textContent).toBe(`⚠ Caution: This configuration: overridden — ${expected}`);
      expect(grids[1]!.querySelector('td')!.textContent).toBe(expected);
      expect(host.querySelectorAll('#cfg-part-own p')[0]!.textContent).toBe(`Own setting: ${expected}`);
      expect(host.querySelectorAll('#cfg-part-own p')[1]!.textContent).toBe('This configuration: uses own setting');
      expect(describeFlightOverrides(tree, overrides, config.motors, config.name, 'm')!.text).toContain(expected);
    } finally { act(() => root.unmount()); }
  });

  it('is collapsed, uses a keyboard scroll region and semantic table, and marks active/default/override in text', () => {
    const host = document.createElement('div'), root = createRoot(host);
    const onApply = vi.fn(), onShowPart = vi.fn();
    try {
      act(() => root.render(<ConfigOverview tree={tree} configs={[config, { ...config, id: 'b', isDefault: false, motors: {}, deployments: {}, ignitions: {}, separations: {} }]}
        activeConfigId="a" onApply={onApply} onShowPart={onShowPart} />));
      expect(host.querySelector('details')!.open).toBe(false);
      expect(host.querySelector('[role="region"]')!.getAttribute('tabindex')).toBe('0');
      const headers = [...host.querySelectorAll('thead th')].map(th => th.textContent);
      expect(headers).toEqual(['Configuration', 'MountMotor · ignition', 'MainRecovery', 'StreamerRecovery', 'BoostersSeparation', 'LowerSeparation']);
      const rows = host.querySelectorAll('tbody tr');
      expect(rows[0]!.textContent).toContain('file default — active');
      expect(rows[1]!.textContent).not.toContain('active');
      expect(rows[0]!.textContent).toContain('C6-5 · Launch + delay (timer), delay 2 s — override');
      expect(rows[0]!.textContent).toContain('Motor ejection charge — override');
      expect(rows[0]!.textContent).toContain('Apogee');
      expect(rows[0]!.textContent).toContain("This stage's motor burnout");
      expect(rows[1]!.textContent).toContain('No motor');
      expect(rows[1]!.textContent).toContain('Altitude (descending), 100 m');
      const labels = [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
      expect(new Set(labels).size).toBe(labels.length);
      act(() => { rows[0]!.querySelector('th button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onApply).toHaveBeenCalledExactlyOnceWith(config); expect(onShowPart).not.toHaveBeenCalled();
      const cells = rows[0]!.querySelectorAll<HTMLButtonElement>('td button');
      act(() => cells[1]!.click());
      expect(onApply).toHaveBeenCalledTimes(2); expect(onShowPart).toHaveBeenLastCalledWith('chute', 'recovery');
      act(() => cells[0]!.click()); expect(onShowPart).toHaveBeenLastCalledWith('mount', 'ignition');
      act(() => cells[4]!.click()); expect(onShowPart).toHaveBeenLastCalledWith('lower', 'separation');
    } finally { act(() => root.unmount()); }
  });

  it('uses the exact Launch summary filter and provides stable part destinations', () => {
    const host = document.createElement('div'), root = createRoot(host);
    const overrides = activeFlightOverrides([config], 'a', {});
    const summary = describeFlightOverrides(tree, overrides, config.motors, config.name, 'm')!;
    try {
      act(() => root.render(<><ConfigPanel tree={tree} configs={[config]} activeConfigId="a" hasMotors
        onApply={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}} onDelete={() => {}} />
        <PartRows tree={tree} overrides={overrides} /></>));
      const chooser = host.querySelector('select')!;
      expect(host.querySelector(`[id="${chooser.getAttribute('aria-describedby')}"]`)!.textContent).toBe(summary.shortText);
      expect(summary.shortText).toContain('parachute'); expect(summary.shortText).toContain('stage'); expect(summary.shortText).toContain('motor mount');
      expect(summary.shortText).not.toContain('Sustainer'); expect(summary.shortText).not.toContain('gone');
      for (const id of ['chute', 'streamer', 'parallel', 'lower']) expect(host.querySelector(`#cfg-part-${id}`)!.getAttribute('tabindex')).toBe('-1');
      expect(host.querySelector('#cfg-part-top')).toBeNull();
    } finally { act(() => root.unmount()); }
  });
});
