// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigPanel } from './ConfigPanel.js';
import { ThrustBalanceMark } from './ThrustBalanceNotes.js';
import { asymmetricThrustWarnings } from '../services/asymmetricThrust.js';
import { balanceMotor, balanceTree } from '../services/asymmetricThrust.testSupport.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); localStorage.clear(); });

it('row 127 shows the effective configuration tier, text, and ignition edits', () => {
  const tree = balanceTree(2), motor = balanceMotor();
  const props = { tree, motors: { m0: motor, m1: motor }, configs: [], activeConfigId: null, hasMotors: true,
    onApply: () => {}, onClear: () => {}, onCreate: () => null, onRename: () => {}, onDelete: () => {} };
  act(() => root.render(<ConfigPanel {...props} />));
  expect(host.querySelector('.message-danger')).toBeNull();
  act(() => root.render(<ConfigPanel {...props} detachedOverrides={{ ignitions: { m1: { event: 'never', delay: 0 } } }} />));
  expect(host.querySelector('.message-danger')?.textContent).toContain('Unbalanced thrust');
  expect(host.textContent).toContain('simulation does not show this turn');
  expect(host.textContent).toContain('Mount 1');
  act(() => root.render(<ConfigPanel {...props} motors={{ m0: balanceMotor(110), m1: balanceMotor(90) }} />));
  expect(host.querySelector('.message-caution')?.textContent).toContain('Caution:');
  expect(host.querySelector('.message-danger')).toBeNull();
  act(() => root.render(<ConfigPanel {...props} />));
  expect(host.querySelector('.message-caution')).toBeNull();
});

it('round 2 shows a saved active configuration rather than detached ignition settings', () => {
  const tree = balanceTree(2), motor = balanceMotor();
  const props = { tree, motors: { m0: motor, m1: motor }, activeConfigId: 'saved', hasMotors: true,
    configs: [{ id: 'saved', name: 'Saved', isDefault: true, motors: { m0: motor, m1: motor },
      ignitions: { m1: { event: 'never' as const, delay: 0 } } }],
    detachedOverrides: { ignitions: { m0: { event: 'never' as const, delay: 0 } } },
    onApply: () => {}, onClear: () => {}, onCreate: () => null, onRename: () => {}, onDelete: () => {} };
  act(() => root.render(<ConfigPanel {...props} />));
  expect(host.querySelector('.message-danger')?.textContent).toContain('Firing then: Mount 1.');
  act(() => root.render(<ConfigPanel {...props} activeConfigId={null} />));
  expect(host.querySelector('.message-danger')?.textContent).toContain('Firing then: Mount 2.');
});

it('round 2 config notes exclude stale and build-refused assignments', () => {
  const tree = balanceTree(), motor = balanceMotor();
  tree.components[0]!.children![0]!.children![0]!.motorMount = false;
  const props = { tree, motors: { m0: motor, m1: motor, m2: motor, m3: motor }, configs: [],
    activeConfigId: null, hasMotors: true,
    onApply: () => {}, onClear: () => {}, onCreate: () => null, onRename: () => {}, onDelete: () => {} };
  act(() => root.render(<ConfigPanel {...props} />));
  expect(host.querySelector('.message-danger')).not.toBeNull();
  act(() => root.render(<ConfigPanel {...props} motors={{ m0: motor }} />));
  expect(host.querySelector('.message-danger')).toBeNull();
  act(() => root.render(<ConfigPanel {...props} tree={balanceTree(2)} motors={{ m0: motor }} refusedMountIds={['m0']} />));
  expect(host.querySelector('.message-danger')).toBeNull();
});

it('round 2 batch marker is a keyboard control that expands visible warning text', () => {
  const warnings = asymmetricThrustWarnings(balanceTree(2), [['m0', balanceMotor()]]);
  act(() => root.render(<ThrustBalanceMark warnings={warnings} />));
  const mark = host.querySelector('.message-danger')!;
  expect(mark.textContent).toContain('Danger:');
  const control = mark.querySelector('summary')!;
  expect(control).not.toBeNull();
  expect(mark.querySelector('p')?.textContent).toContain('cartwheel');
  expect(mark.querySelector('p')?.textContent).toContain('simulation does not show this turn');
  expect(mark.tagName).toBe('DETAILS');
  expect(mark.hasAttribute('open')).toBe(false);
  act(() => control.click());
  expect(mark.hasAttribute('open')).toBe(true);
  act(() => root.render(<ThrustBalanceMark warnings={[]} />));
  expect(host.textContent).toBe('');
});
