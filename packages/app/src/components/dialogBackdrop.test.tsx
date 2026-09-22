// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { BatchSimulate } from './BatchSimulate.js';
import { ChangelogDialog } from './ChangelogDialog.js';
import { GuideDialog } from './GuideDialog.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { MotorBrowser } from './MotorBrowser.js';
import { PreferencesDialog } from './PreferencesDialog.js';
import { PresetPicker } from './PresetPicker.js';

// The preset catalogue is a 1.3 MB lazy import the picker's backdrop does not need.
vi.mock('../data/presets.json', () => ({ default: { presets: [] } }));

/**
 * Audit 2026-09-22: a dialog's backdrop closed it on ANY click whose target
 * was the backdrop — and a click's target is the nearest element holding both
 * the press and the release. Select text in the guide, let the drag run off
 * the card's edge, and that element is the backdrop: the dialog closed under
 * the selection. Only a press AND a release on the backdrop itself close it.
 *
 * Every backdrop that closes its dialog, not only the three the audit named:
 * the batch dialog holds a finished sweep in its own state, so a motor name
 * drag-selected in its results table and released past the card's edge threw
 * the whole batch away; the motor browser and the preset picker each open on
 * a search box, which is where a selection drag starts.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let closed: number;

beforeEach(() => {
  localStorage.clear();
  closed = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pointer = (el: Element, type: string) => act(() => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
});
/** What the browser sends for a press on `down` released over `up`. */
const gesture = (down: Element, up: Element, clickTarget: Element) => {
  pointer(down, 'pointerdown');
  pointer(up, 'pointerup');
  act(() => { clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const BATCH_TREE: RocketTree = {
  name: 'R',
  components: [{
    type: 'stage', id: 'st0',
    children: [{ type: 'bodytube', id: 'bt', length: 0.6,
      children: [{ type: 'innertube', id: 'mount', length: 0.07 }] }],
  }],
};

const DIALOGS: [string, () => ReactElement][] = [
  ['the user guide', () => <GuideDialog onClose={() => { closed++; }} />],
  ['the changelog', () => <ChangelogDialog onClose={() => { closed++; }} />],
  ['preferences', () => <PrefsProvider><PreferencesDialog onClose={() => { closed++; }} /></PrefsProvider>],
  ['the motor browser', () => (
    <PrefsProvider>
      <MotorBrowser mountDiameterMm={24} maxMotorLengthM={null}
        onSelect={() => {}} onClose={() => { closed++; }} />
    </PrefsProvider>
  )],
  ['the preset picker', () => (
    <PrefsProvider>
      <PresetPicker type={'bodytube' as ComponentNode['type']} onApply={() => {}}
        onClose={() => { closed++; }} />
    </PrefsProvider>
  )],
  ['the batch dialog', () => (
    <PrefsProvider>
      <BatchSimulate tree={BATCH_TREE} info={{} as never}
        mounts={[{ id: 'mount', label: '24 mm', diameterMm: 24, motorCount: 1, maxMotorLengthM: null }]}
        initialMountId="mount" assignedMotors={{}} assignedMotorIds={{}} assignedIgnitions={{}}
        launch={DEFAULT_CONDITIONS} rocketName="R" onRunsChange={() => {}}
        onClose={() => { closed++; }} />
    </PrefsProvider>
  )],
];

describe.each(DIALOGS)('the backdrop of %s', (_name, dialog) => {
  const mount = () => act(() => root.render(dialog()));
  const backdrop = () => host.querySelector('.prefs-overlay')!;
  const inside = () => host.querySelector('[role="dialog"] h2')!;

  it('does not close when a text selection is dragged off the card', () => {
    mount();
    // Pressed on the heading, released on the backdrop: the click lands on
    // the backdrop, their nearest common ancestor.
    gesture(inside(), backdrop(), backdrop());
    expect(closed).toBe(0);
  });

  it('does not close when a press on the backdrop is released on the card', () => {
    mount();
    gesture(backdrop(), inside(), backdrop());
    expect(closed).toBe(0);
  });

  it('still closes on a click on the backdrop itself', () => {
    mount();
    gesture(backdrop(), backdrop(), backdrop());
    expect(closed).toBe(1);
  });
});

/**
 * The batch dialog's backdrop must stay inert while a sweep runs, as it was
 * before (`onClick={running ? undefined : onClose}`). `running` is reachable
 * only by flying a real sweep, so this pins the wiring in the source, the way
 * BatchSimulate.guards.test.tsx pins the Escape guard beside it.
 */
it('the batch dialog routes its backdrop through the running check', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './BatchSimulate.tsx'), 'utf8');
  expect(src).toContain('useBackdropClose(() => { if (!runningRef.current) onClose(); })');
  expect(src).not.toContain('useBackdropClose(onClose)');
});
