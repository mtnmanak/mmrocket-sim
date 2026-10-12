// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPartEditors } from './ConfigPartEditors.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { FlightOverrides, FlightTree } from '../model/design.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree: FlightTree = { name: 'T', components: [
  { id: 'top', type: 'stage', name: 'Sustainer', children: [
    { id: 'chute', type: 'parachute', name: 'Main', deployEvent: 'altitude', deployAltitude: 100, deployDelay: 0 },
    { id: 'streamer', type: 'streamer', name: 'Ribbon', deployEvent: 'apogee' },
  ] },
  { id: 'lower', type: 'stage', name: 'Booster', separationEvent: 'ejection', children: [
    { id: 'drogue', type: 'parachute', name: 'Drogue', deployEvent: 'ejection' },
  ] },
] };
const overrides: FlightOverrides = {
  deployments: { chute: { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 1 } },
  separations: { lower: { separationEvent: 'launch', separationDelay: 2, separationAltitude: 200 },
    top: { separationEvent: 'launch', separationDelay: 2, separationAltitude: 200 } },
};

function setup(props: Partial<Parameters<typeof ConfigPartEditors>[0]> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handlers = { onEdit: vi.fn(), onEditStart: vi.fn(), onEditEnd: vi.fn(), onEditCancel: vi.fn(),
    onReset: vi.fn(), onResetAll: vi.fn(), onEverywhere: vi.fn() };
  const render = (next: Partial<Parameters<typeof ConfigPartEditors>[0]> = {}) => act(() => root.render(
    <ConfigPartEditors tree={tree} overrides={overrides} ownerKey="a" configLabel="Flight A" detached={false}
      {...handlers} {...props} {...next} />));
  render();
  const row = (id: string) => host.querySelector<HTMLElement>(`[id="cfg-part-${id}"]`)!;
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
  const buttonIn = (el: Element, text: string) => [...el.querySelectorAll('button')].find(b => b.textContent === text);
  const cleanup = () => { act(() => root.unmount()); host.remove(); };
  return { host, row, click, buttonIn, handlers, render, cleanup };
}

describe('CFG-2 Recovery and Stages rows', () => {
  it('list every recovery device and every lower stage, never the top stage, with own and flown text', () => {
    const { host, row, cleanup } = setup();
    try {
      expect([...host.querySelectorAll('section')].map(s => s.getAttribute('aria-label'))).toEqual(['Recovery', 'Stages']);
      expect(row('top')).toBeNull();
      expect(row('chute').querySelector('strong')!.textContent).toBe('Main (in Sustainer)');
      expect(row('drogue').querySelector('strong')!.textContent).toBe('Drogue (in Booster)');
      expect(row('lower').querySelector('strong')!.textContent).toBe('Booster');
      const lines = (id: string) => [...row(id).querySelectorAll('p')].map(p => p.textContent);
      expect(lines('chute')).toEqual(['Own setting: Altitude (descending), 100 m', 'This configuration: overridden — Motor ejection charge, delay 1 s']);
      expect(lines('streamer')).toEqual(['Own setting: Apogee', 'This configuration: uses own setting']);
      expect(lines('lower')).toEqual(["Own setting: This stage's ejection charge", 'This configuration: overridden — Launch, delay 2 s']);
    } finally { cleanup(); }
  });

  it('opens the inline editor in the override scope only when the active owner overrides the part', () => {
    const { row, click, buttonIn, cleanup } = setup();
    try {
      expect(row('chute').querySelector('.config-part-editor')).toBeNull();
      click(buttonIn(row('chute'), 'Edit…')!);
      const radios = [...row('chute').querySelectorAll<HTMLInputElement>('fieldset input[type="radio"]')];
      expect(row('chute').querySelector('fieldset legend')!.textContent).toBe('Apply changes to');
      expect(radios.map(r => r.parentElement!.textContent!.trim())).toEqual([
        "Change the part's own setting — every configuration that uses it", 'Override for “Flight A” only']);
      expect(radios.map(r => r.checked)).toEqual([false, true]);
      expect(row('chute').querySelector('select')!.value).toBe('ejection');
      expect(buttonIn(row('chute'), 'Use the override everywhere')).toBeDefined();
      click(buttonIn(row('streamer'), 'Edit…')!);
      expect([...row('streamer').querySelectorAll<HTMLInputElement>('fieldset input')].map(r => r.checked)).toEqual([true, false]);
      expect(row('streamer').querySelector('select')!.value).toBe('apogee');
      expect(buttonIn(row('streamer'), 'Use the override everywhere')).toBeUndefined();
      expect(buttonIn(row('streamer'), 'Reset to own setting')).toBeUndefined();
    } finally { cleanup(); }
  });

  it('offers only the own setting without an owner, and names the working settings when detached', () => {
    const { row, click, buttonIn, render, cleanup } = setup({ configLabel: null, detached: false, overrides: {} });
    try {
      // With no configuration the row does not claim one (review of CFG-2).
      expect(row('chute').textContent).toContain('The working settings: uses own setting');
      expect(row('chute').textContent).not.toContain('This configuration');
      click(buttonIn(row('chute'), 'Edit…')!);
      expect(row('chute').querySelector('fieldset')).toBeNull();
      expect(row('chute').textContent).toContain("Changes the part's own setting");
      render({ configLabel: null, detached: true, overrides, ownerKey: 'working' });
      click(buttonIn(row('chute'), 'Edit…')!);
      expect(row('chute').querySelectorAll('fieldset label')[1]!.textContent!.trim()).toBe('Override in the working settings only');
      expect(row('chute').textContent).toContain('The working settings: overridden');
    } finally { cleanup(); }
  });

  it('routes own-scope edits as a one-field patch and override edits as the whole override tuple', () => {
    const { row, click, buttonIn, handlers, cleanup } = setup();
    try {
      click(buttonIn(row('chute'), 'Edit…')!);
      const select = row('chute').querySelector('select')!;
      act(() => { select.value = 'launch'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      const node = expect.objectContaining({ id: 'chute' });
      expect(handlers.onEdit).toHaveBeenLastCalledWith(node, 'override',
        { deployEvent: 'launch', deployAltitude: 200, deployDelay: 1 }, { deployEvent: 'launch' }, false);
      click(row('chute').querySelector('fieldset input')!);
      act(() => { select.value = 'apogee'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(handlers.onEdit).toHaveBeenLastCalledWith(node, 'own',
        { deployEvent: 'apogee', deployAltitude: 100, deployDelay: 0 }, { deployEvent: 'apogee' }, false);
      const delay = row('chute').querySelector<HTMLInputElement>('[aria-label="Main deploy delay (s)"]')!;
      act(() => { delay.focus(); });
      expect(handlers.onEditStart).toHaveBeenCalledTimes(1);
      act(() => { delay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(handlers.onEditCancel).toHaveBeenCalledTimes(1);
      click(buttonIn(row('chute'), 'Reset to own setting')!);
      expect(handlers.onReset).toHaveBeenCalledExactlyOnceWith(node);
      click(row('chute').querySelectorAll('fieldset input')[1]!);
      click(buttonIn(row('chute'), 'Use the override everywhere')!);
      expect(handlers.onEverywhere).toHaveBeenCalledExactlyOnceWith(node);
    } finally { cleanup(); }
  });

  it('offers a section reset only when a listed part is overridden, naming only those parts', () => {
    const { host, click, buttonIn, handlers, render, cleanup } = setup();
    try {
      const recovery = 'Reset all recovery overrides in this configuration';
      const stage = 'Reset all stage overrides in this configuration';
      click(buttonIn(host, recovery)!);
      expect(handlers.onResetAll).toHaveBeenLastCalledWith('recovery', ['chute']);
      click(buttonIn(host, stage)!);
      expect(handlers.onResetAll).toHaveBeenLastCalledWith('separation', ['lower']);
      // A stored override on the top stage is not a row, so it offers no section reset.
      render({ overrides: { separations: { top: overrides.separations!['top']! } } });
      expect(buttonIn(host, recovery)).toBeUndefined();
      expect(buttonIn(host, stage)).toBeUndefined();
    } finally { cleanup(); }
  });
});

describe('CFG-3 ports from the Design deployment fields (ruling D2a moved their editor here)', () => {
  const chuteTree = (deployEvent: unknown): FlightTree => ({ name: 'T', components: [
    { id: 'top', type: 'stage', name: 'Sustainer', children: [
      { id: 'p1', type: 'parachute', name: 'Main', deployEvent, deployAltitude: 300 } as FlightTree['components'][number],
    ] },
  ] });

  it('RECOV-CASE: the Deploy at menu shows the event the kernel flies, not its first option', () => {
    const { row, click, buttonIn, render, cleanup } = setup({ tree: chuteTree('Altitude'), overrides: {} });
    try {
      click(buttonIn(row('p1'), 'Edit…')!);
      expect(row('p1').querySelector('select')!.value).toBe('altitude');
      render({ tree: chuteTree('NEVER') });
      expect(row('p1').querySelector('select')!.value).toBe('never');
      render({ tree: chuteTree(undefined) });
      expect(row('p1').querySelector('select')!.value).toBe('ejection');
    } finally { cleanup(); }
  });

  it('flags a deployment-altitude overflow even without a density ceiling', () => {
    // Was PropertyPanel.limits: 1e306 km is finite as typed and infinite in SI.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'km' } }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onEdit = vi.fn();
    try {
      act(() => root.render(<PrefsProvider>
        <ConfigPartEditors tree={chuteTree('altitude')} overrides={{}} ownerKey="a" configLabel={null} detached={false}
          onEdit={onEdit} onEditStart={vi.fn()} onEditEnd={vi.fn()} onEditCancel={vi.fn()}
          onReset={vi.fn()} onResetAll={vi.fn()} onEverywhere={vi.fn()} />
      </PrefsProvider>));
      act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Edit…')!.click());
      const el = host.querySelector<HTMLInputElement>('input[aria-label="Main deploy altitude (km)"]')!;
      act(() => el.focus());
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '1e306');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(onEdit).not.toHaveBeenCalled();
      expect(el.getAttribute('aria-invalid')).toBe('true');
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  });
});
