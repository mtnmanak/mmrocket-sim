// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { IgnitionTuple } from '../model/design.js';
import { MountIgnitionField } from './MountIgnitionField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};

function render(own: IgnitionTuple, override: IgnitionTuple | undefined) {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<MountIgnitionField mountId="m" mountName="Mount" ownerKey="a" own={own} override={override}
    overrideLabel="Override for “A” only" isStaged={false} onEdit={noop} onEditStart={noop} onEditEnd={noop}
    onEditCancel={noop} onReset={noop} />));
  const status = [...host.querySelectorAll('p')].find(p => p.textContent?.includes('Ignition:'))!;
  return { host, status, unmount: () => act(() => root.unmount()) };
}

/**
 * Review of b9-int, finding 12: the motor card's ignition override takes the
 * Recovery and Stages rows' tier rule (D7 I10) — Caution only when it flies
 * differently from the mount's own setting, the Launch warning's comparison.
 */
describe('the motor card’s ignition status', () => {
  it('is Caution for an override that flies differently from the own setting', () => {
    const { status, unmount } = render({ event: 'automatic', delay: 0 }, { event: 'launch', delay: 2 });
    try {
      expect(status.className).toContain('message-caution');
      expect(status.textContent).toContain('Caution:');
      expect(status.textContent).toContain('Ignition: overridden here — Launch + delay (timer), delay 2 s; own setting: Automatic');
      expect(status.textContent).not.toContain('flies the same');
    } finally { unmount(); }
  });

  it('is quiet for an override that flies the same, and for the own setting', () => {
    // A stored delay Never does not use: a different tuple, the same flight.
    const same = render({ event: 'never', delay: 0 }, { event: 'never', delay: 3 });
    try {
      expect(same.status.className).not.toContain('message-caution');
      expect(same.status.textContent).not.toContain('Caution:');
      expect(same.status.textContent).toContain('(flies the same as the own setting).');
    } finally { same.unmount(); }
    const own = render({ event: 'automatic', delay: 0 }, undefined);
    try {
      expect(own.status.className).not.toContain('message-');
      expect(own.status.textContent).toContain("Ignition: uses the mount's own setting — Automatic");
    } finally { own.unmount(); }
  });
});
