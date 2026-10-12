// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesignConfirms } from './DesignConfirms.js';
import { FormatLossDialog } from './FormatLossDialog.js';
import { FlightOverrideBanner } from './FlightOverrideBanner.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const noop = () => {};

it.each([false, true])('lossy save/refusal has one operation block; refused=%s', refused => {
  act(() => root.render(<FormatLossDialog report={{ format: 'rkt', losses: ['Launch settings omitted'], refused: refused ? 'Cannot save this geometry' : null }}
    confirm onClose={noop} onSave={noop} onSaveOrk={noop} />));
  expect(host.querySelectorAll('.message-tier')).toHaveLength(1);
  expect(host.querySelector(refused ? '.message-danger' : '.message-caution')).not.toBeNull();
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Save .rkt anyway')).toBe(!refused);
});

it.each([false, true])('New keeps protected replacement quiet; unprotected=%s', unprotected => {
  act(() => root.render(<DesignConfirms tree={{ name: 'Test', components: [] }} unprotected={unprotected}
    lossDialog={null} setLossDialog={noop} saveLossy={noop} confirmNew setConfirmNew={noop} replaceLoss={null}
    startNewDesign={noop} onSaveOrk={async () => ({ kind: 'cancelled' })} pendingOpen={null} setPendingOpen={noop}
    onOpenOrk={async () => {}} shareOffer={null} setShareOffer={noop} applyImported={async () => {}}
    shroudPrompt={null} setShroudPrompt={noop} hasOpenMotorQuestion={false} onConvertShrouds={noop} />));
  expect(host.querySelectorAll('.message-danger')).toHaveLength(unprotected ? 1 : 0);
  expect(host.textContent).toContain('Save .ork first');
});

it('a lossy last save puts its exact losses in the one Danger block, directly above the buttons (D7 §5, G21)', () => {
  const loss = 'You saved “Before.rkt”, but it does not keep: launch settings.';
  const confirms = (over: Partial<Parameters<typeof DesignConfirms>[0]>) => <DesignConfirms tree={{ name: 'Test', components: [] }}
    lossDialog={null} setLossDialog={noop} saveLossy={noop} confirmNew={false} setConfirmNew={noop} replaceLoss={loss}
    startNewDesign={noop} onSaveOrk={async () => ({ kind: 'cancelled' })} pendingOpen={null} setPendingOpen={noop}
    onOpenOrk={async () => {}} shareOffer={null} setShareOffer={noop} applyImported={async () => {}}
    shroudPrompt={null} setShroudPrompt={noop} hasOpenMotorQuestion={false} onConvertShrouds={noop} {...over} />;
  for (const over of [{ confirmNew: true }, { pendingOpen: new File([''], 'next.ork') },
    { shareOffer: { name: 'Linked', tree: { name: 'Linked', components: [] }, notes: [], motors: {} } }]) {
    act(() => root.render(confirms(over)));
    const blocks = host.querySelectorAll('.message-danger');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.querySelector('.replacement-loss')?.textContent).toBe(loss);
    expect(blocks[0]!.nextElementSibling?.classList.contains('modal-actions')).toBe(true);
    act(() => root.render(<></>));
  }
});

it.each([false, true])('recovery override ignores dormant altitude but marks an effective change: %s', effective => {
  const edit = vi.fn();
  act(() => root.render(<PrefsProvider><FlightOverrideBanner
    node={{ type: 'parachute', id: 'p', deployEvent: 'apogee', deployAltitude: 100, deployDelay: 0 }}
    overrides={{ deployments: { p: { deployEvent: 'apogee', deployAltitude: 300, deployDelay: effective ? 1 : 0 } } }}
    configLabel="Flight" onEdit={edit} onEditStart={noop} onEditEnd={noop} onEditCancel={noop} onReset={noop} onEverywhere={noop}
  /></PrefsProvider>));
  expect(host.querySelectorAll('.message-caution')).toHaveLength(effective ? 1 : 0);
  expect(edit).not.toHaveBeenCalled();
});
