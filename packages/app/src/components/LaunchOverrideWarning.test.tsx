// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { describeFlightOverrides } from '../services/flightOverrideSummary.js';
import { FlyScreen } from './FlyScreen.js';
import { DEFAULT_CONDITIONS, LaunchPanel } from './LaunchPanel.js';
import { LaunchOverrideWarning } from './LaunchOverrideWarning.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const summary = describeFlightOverrides({ components: [{ type: 'streamer', id: 'ribbon', name: 'Ribbon' }] },
  { deployments: { ribbon: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 2 } } }, {}, 'Field flight', 'ft')!;

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

it.each(['panel', 'fly'] as const)('%s Launch has a full description immediately below it and Show identifies the editor', site => {
  const show = vi.fn();
  for (const overrideSummary of [summary, null]) {
    const props = { overrideSummary, onShowOverride: show, onLaunch: () => {}, simulating: false, canLaunch: true };
    act(() => root.render(<PrefsProvider>{site === 'panel'
      ? <LaunchPanel {...props} value={DEFAULT_CONDITIONS} onChange={() => {}} />
      : <FlyScreen {...props} tree={{ components: [] }} info={null} run={null} motorLabel="C6"
        launch={DEFAULT_CONDITIONS} onLaunchChange={() => {}} onChangeMotor={() => {}}
        onCompare={() => {}} canCompare={false} />}</PrefsProvider>));
    const launch = host.querySelector<HTMLButtonElement>('.launch-btn')!;
    if (overrideSummary) {
      const description = document.getElementById(launch.getAttribute('aria-describedby')!)!;
      expect(description.textContent).toBe(summary.text);
      expect(description.classList.contains('sr-only')).toBe(false);
      expect(launch.nextElementSibling).toBe(description.parentElement);
      expect(description.parentElement?.classList.contains('launch-override-callout')).toBe(true);
      expect(description.parentElement?.querySelector('.launch-override-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(description.parentElement?.querySelector('.launch-override-icon')?.textContent).toBe('⚠');
      act(() => description.parentElement!.querySelector<HTMLButtonElement>('button')!.click());
      expect(show).toHaveBeenCalledWith({ id: 'ribbon', family: 'recovery' });
    } else {
      expect(launch.getAttribute('aria-describedby')).toBeNull();
      expect(host.querySelector('.launch-override-warning')).toBeNull();
    }
  }
});

it('compact warnings retain the full accessible text and Show action without a title tooltip', () => {
  const show = vi.fn();
  act(() => root.render(<LaunchOverrideWarning id="compact-description" summary={summary} onShow={show} compact />));
  expect(host.querySelector('.launch-override-short')?.textContent).toBe(summary.shortText);
  expect(host.querySelector('.launch-override-warning')?.classList.contains('launch-override-callout')).toBe(true);
  expect(host.querySelector('.launch-override-icon')?.textContent).toBe('⚠');
  expect(host.querySelector('.launch-override-icon')?.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('#compact-description')?.textContent).toBe(summary.text);
  expect(host.querySelector('[title]')).toBeNull();
  const button = host.querySelector<HTMLButtonElement>('button')!;
  expect(button.getAttribute('aria-describedby')).toBe('compact-description');
  act(() => button.click());
  expect(show).toHaveBeenCalledWith(summary.first);
});
