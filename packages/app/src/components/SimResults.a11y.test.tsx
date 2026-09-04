// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimHistory } from './SimResults.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { SimRun } from '../services/simReport.js';

/**
 * Keyboard reach into the Saved simulations table.
 *
 * The rows were `<tr onClick=…>` with a `title` and nothing else. A keyboard
 * user tabbed straight past the row into its own ✕ Delete and 📈 Charts
 * buttons — so they could delete a saved run but never open one, and `onSelect`
 * is the only path that loads a stored run into the launch report. The whole
 * run-comparison workflow the table exists for was mouse-only.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (id: string): SimRun => ({
  id, when: 1_756_000_000_000, rocket: 'Big Dog 4in', motor: 'C6',
  manufacturer: 'Estes', motorDiameterMm: 18, delayS: 5,
  maxAltitude: 331.7, maxVelocity: 116.2, maxMach: 0.35, maxAcceleration: 227.5,
  timeToApogee: 6.8, timeToBurnout: 2, timeToRodDeparture: 0.15,
  rodExitVelocity: 18.4, thrustToWeightAtRod: 12.3,
  launchMass: 0.051, burnoutMass: 0.04,
  rodExitAoa: 0, launchCG: 0.26, launchCP: 0.29,
  launchStaticMarginCal: 1.3, launchStaticMarginPct: 3.5,
  altitudeAtDeployment: 331, velocityAtDeployment: 4.2,
  deployments: [],
  landingRate: 3.4, safeLandingRate: true,
  groundHitVelocity: 5.1, totalFlightTime: 104,
  optimumDelayS: 4.9, recommendedDelayS: 5,
  safeLiftoffSpeed: true, safeThrustToWeight: true, safeDeployment: true,
  staticMarginOk: true, weathercockRisk: 'low',
} as unknown as SimRun);

describe('SimHistory rows — reachable without a mouse', () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (node: React.ReactNode) => act(() => root.render(
    <PrefsProvider>{node}</PrefsProvider>,
  ));

  /** The table starts collapsed; the rows only exist once it is open. */
  const openTable = () => act(() => {
    Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '') === 'Show')
      ?.click();
  });

  const rowEl = () => host.querySelector('tbody tr.motor-row') as HTMLTableRowElement;

  const press = (el: Element, key: string) => act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

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

  it('gives each row a tab stop', () => {
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} onSelect={() => {}} />);
    openTable();
    expect(rowEl().tabIndex).toBe(0);
  });

  it('opens the run on Enter and on Space', () => {
    const picked: string[] = [];
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} onSelect={(r) => picked.push(r.id)} />);
    openTable();
    press(rowEl(), 'Enter');
    press(rowEl(), ' ');
    expect(picked).toEqual(['a', 'a']);
  });

  it('leaves the <tr> a table row — no role override', () => {
    // clickable() deliberately does not set a role: a <tr> that stops being a
    // row costs the screen reader the column headers for every cell in it.
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} onSelect={() => {}} />);
    openTable();
    expect(rowEl().getAttribute('role')).toBe(null);
  });

  it('ignores keys aimed at the Delete button inside the row', () => {
    // Enter on a nested <button> is that button's activation, not the row's —
    // otherwise deleting a run would also select it.
    const picked: string[] = [];
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} onSelect={(r) => picked.push(r.id)} />);
    openTable();
    const del = host.querySelector('.fin-row-del') as HTMLButtonElement;
    press(del, 'Enter');
    expect(picked).toEqual([]);
  });

  it('is not a tab stop when there is nothing to select', () => {
    // SimHistory is also rendered read-only; a row that activates nothing must
    // not sit in the tab order pretending it does.
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} />);
    openTable();
    expect(rowEl().tabIndex).toBe(-1);
  });

  it('still opens the run on a plain click', () => {
    const picked: string[] = [];
    render(<SimHistory runs={[run('a')]} onRunsChange={() => {}} onSelect={(r) => picked.push(r.id)} />);
    openTable();
    act(() => { rowEl().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(picked).toEqual(['a']);
  });
});
