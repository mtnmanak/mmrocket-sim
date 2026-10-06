// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import type { SessionState } from './services/session.js';
import { APP_VERSION } from './version.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ctx2d = new Proxy({}, {
  get: (_t, prop) => prop === 'measureText' ? () => ({ width: 0 }) : () => undefined,
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
const sessionKey = 'online-openrocket.session.v1';
let root: Root;
let host: HTMLDivElement;
const stored = () => JSON.parse(localStorage.getItem(sessionKey)!) as SessionState;
const flush = () => window.dispatchEvent(new Event('pagehide'));
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
async function waitFor(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 8000) throw new Error('Open did not settle');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  }
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem(sessionKey, JSON.stringify({
    tree: { name: 'Before open', components: [] }, launch: DEFAULT_CONDITIONS,
    appVersion: APP_VERSION, savedAt: Date.now(),
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
});
afterEach(async () => { flush(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function open() {
  const motor = (id: string) => `<motor configid="${id}"><manufacturer>Enerjet</manufacturer><designation>F67</designation><diameter>0.0286</diameter><length>0.127</length><delay>9</delay></motor>`;
  const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Ask motor</name>
    <motorconfiguration configid="a" default="true"><name>First</name></motorconfiguration>
    <motorconfiguration configid="b"><name>Second</name></motorconfiguration>
    <subcomponents><stage><name>Sustainer</name><subcomponents><bodytube><name>Motor tube</name>
    <length>0.5</length><radius>0.016</radius><thickness>0.001</thickness>
    <motormount><ignitionevent>automatic</ignitionevent>${motor('a')}${motor('b')}</motormount>
    </bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
  const picker = host.querySelector<HTMLInputElement>('input[aria-label="Open a design file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File([xml], 'Ask.ork')] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  const discard = button('Open without saving');
  if (discard) await act(async () => discard.click());
  await waitFor(() => !!host.querySelector('[aria-label="Choose motors for this file"]'));
  flush();
}

it('the real file-open dialog applies all configurations, marks dirty, and undoes/redoes once', async () => {
  await open();
  expect(host.querySelectorAll('[aria-label="Choose motors for this file"]')).toHaveLength(1);
  const before = stored();
  expect(before.savedConfigs).toHaveLength(2);
  expect(Object.values(before.mountMotors!)[0]!.openNote).toContain('Enerjet');
  await act(async () => button('Apply').click());
  await waitFor(() => !host.querySelector('[aria-label="Choose motors for this file"]'));
  flush();
  const after = stored();
  expect(Object.values(after.mountMotors!)[0]!.openNote).toBeUndefined();
  expect(after.savedConfigs!.every(c => Object.values(c.motors).every(m => !m.openNote))).toBe(true);
  await act(async () => button('✕ New').click());
  expect(host.textContent).toContain('Start a new design?');
  await act(async () => button('Cancel').click());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })));
  flush();
  expect(stored().mountMotors).toEqual(before.mountMotors);
  expect(stored().savedConfigs).toEqual(before.savedConfigs);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true })));
  flush();
  expect(stored().mountMotors).toEqual(after.mountMotors);
  expect(stored().savedConfigs).toEqual(after.savedConfigs);
}, 20000);

it('Escape leaves the imported motors and repeating notes untouched', async () => {
  await open();
  const before = stored();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[aria-label="Choose motors for this file"]')).toBeNull();
  flush();
  expect(stored().mountMotors).toEqual(before.mountMotors);
  expect(stored().savedConfigs).toEqual(before.savedConfigs);
}, 20000);
