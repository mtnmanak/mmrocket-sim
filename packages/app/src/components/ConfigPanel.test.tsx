// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigPanel } from './ConfigPanel.js';
import type { SavedConfig } from '../model/design.js';
import { renameConfig } from '../services/configSync.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The panel only reads labels — a cast partial motor is enough. */
const mm = (label: string) =>
  ({ label, spec: {}, meta: { label }, ignition: { event: 'automatic', delay: 0 } }
  ) as unknown as SavedConfig['motors'][string];

const CONFIGS: SavedConfig[] = [
  { id: 'cfg-a', name: 'Club field C6', isDefault: true, motors: { m1: mm('C6-5'), m2: mm('D12-0') } },
  { id: 'cfg-b', name: null, isDefault: false, motors: {} },
  // Nameless but carrying motors — the common case in a real .ork, where
  // desktop only writes <name> when the user renamed the configuration.
  { id: 'cfg-c', name: null, isDefault: false, motors: { m1: mm('J1026-CT') } },
  // Nameless, and its only motor could not be matched to our database.
  { id: 'cfg-d', name: null, isDefault: false, motors: {}, unmatched: ['K550W'] },
];

describe('ConfigPanel', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function mount(over: Partial<Parameters<typeof ConfigPanel>[0]> = {}) {
    const applied: string[] = [];
    const cleared: number[] = [];
    act(() => root.render(
      <ConfigPanel
        configs={CONFIGS}
        activeConfigId="cfg-a"
        hasMotors
        onApply={(c) => applied.push(c.id)}
        onEmpty={() => {}} onClear={() => cleared.push(1)}
        onCreate={() => null}
        onRename={() => {}}
        onDelete={() => {}}
        {...over}
      />,
    ));
    return { applied, cleared };
  }

  it('lists every config plus the None row: names, summaries, default marker, active state', () => {
    mount();
    const names = Array.from(host.querySelectorAll('.config-name')).map((el) => el.textContent);
    // A nameless configuration reads as its MOTOR SET, never as a raw GUID —
    // the picker used to show `33a7c4f9-1acd-…` as a user's first screen after
    // opening a file (one beta-thread design carries ten of them).
    expect(names).toEqual(['Club field C6', 'No motors', '[J1026-CT]', '[K550W]', 'None']);
    const summaries = Array.from(host.querySelectorAll('.config-motors')).map((el) => el.textContent);
    expect(summaries).toEqual(['C6-5, D12-0', 'no motors', 'J1026-CT', 'no motors', 'no motors loaded']);
    // The file's default is marked once, on cfg-a's row.
    const rows = Array.from(host.querySelectorAll('.config-row'));
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.config-default')).toBeTruthy();
    expect(rows[1]!.querySelector('.config-default')).toBeFalsy();
    // Active state rides the activeConfigId row only.
    expect(rows[0]!.querySelector('.config-active-tag')).toBeTruthy();
    expect(rows[1]!.querySelector('.config-active-tag')).toBeFalsy();
    expect(rows[2]!.querySelector('.config-active-tag')).toBeFalsy();
  });

  it('Apply fires onApply with that config; the None row fires onClear', () => {
    const { applied, cleared } = mount();
    const rows = Array.from(host.querySelectorAll('.config-row'));
    act(() => { (rows[1]!.querySelector('button') as HTMLButtonElement).click(); });
    expect(applied).toEqual(['cfg-b']);
    // The None row is always LAST, after every configuration.
    act(() => { (rows.at(-1)!.querySelector('button') as HTMLButtonElement).click(); });
    expect(cleared).toHaveLength(1);
  });

  it('the None row shows active only when nothing is loaded AND no config is active', () => {
    mount({ activeConfigId: null, hasMotors: false });
    const rows = Array.from(host.querySelectorAll('.config-row'));
    expect(rows.at(-1)!.querySelector('.config-active-tag')).toBeTruthy();
    // Custom set (active null but motors loaded): nothing claims active.
    mount({ activeConfigId: null, hasMotors: true });
    expect(host.querySelector('.config-active-tag')).toBeFalsy();
  });

  it('renders nothing when there are neither configurations nor motors', () => {
    mount({ configs: [], hasMotors: false });
    expect(host.querySelector('.config-panel')).toBeFalsy();
    expect(host.querySelector('.config-list')).toBeFalsy();
    expect(host.textContent).toBe('');
  });

  it.each([0, 1, 2])('shows %i configurations with loaded motors, and None only for a nonempty list', (count) => {
    mount({ configs: CONFIGS.slice(0, count) });
    expect(host.querySelector('.config-panel')).toBeTruthy();
    expect(host.querySelectorAll('.config-row')).toHaveLength(count ? count + 1 : 0);
    expect(host.textContent).toContain('+ New configuration from loaded motors');
    if (count === 0) expect(host.textContent).toContain('Keep this motor set');
  });

  it('disables creation without a loaded motor and at 256 configurations, explaining both', () => {
    const onCreate = vi.fn(() => null);
    const create = () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('+ New'))!;
    mount({ hasMotors: false, onCreate });
    expect(create().disabled).toBe(true);
    expect(create().title).toContain('Load a motor');
    act(() => create().click());
    mount({ configs: Array.from({ length: 256 }, (_, i) => ({ ...CONFIGS[0]!, id: String(i) })), onCreate });
    expect(create().disabled).toBe(true);
    expect(create().title).toContain('256');
    act(() => create().click());
    expect(onCreate).not.toHaveBeenCalled();
  });

  function click(label: string) {
    const b = [...host.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label)!;
    expect(b).toBeTruthy();
    act(() => b.click());
  }
  function key(value: string) {
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); });
  }
  function edit(value: string) {
    const input = host.querySelector('input')!;
    act(() => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  }

  it('renames with Enter/blur, trims, clears to unnamed, and Escape preserves the old name', () => {
    const renamed = vi.fn();
    function Harness() {
      const [configs, setConfigs] = useState([CONFIGS[0]!]);
      return <ConfigPanel configs={configs} activeConfigId="cfg-a" hasMotors onApply={() => {}}
        onEmpty={() => {}} onClear={() => {}} onCreate={() => null} onDelete={() => {}}
        onRename={(id, name) => { renamed(id, name); setConfigs(prev => renameConfig(prev, id, name)); }} />;
    }
    act(() => root.render(<Harness />));
    click('Rename Club field C6 — configuration 1');
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('input')!.maxLength).toBe(100);
    expect(host.querySelector('input')!.title).toContain('100');
    edit('  Club field  '); key('Enter');
    expect(host.querySelector('.config-name')?.textContent).toBe('Club field');
    expect(renamed).toHaveBeenCalledTimes(1);
    click('Rename Club field — configuration 1'); edit('cancelled'); key('Escape');
    expect(host.querySelector('.config-name')?.textContent).toBe('Club field');
    expect(renamed).toHaveBeenCalledTimes(1);
    click('Rename Club field — configuration 1'); const input = edit('  ');
    act(() => input.blur());
    expect(host.querySelector('.config-name')?.textContent).toBe('[C6-5, D12-0]');
    expect(renamed).toHaveBeenCalledTimes(2);
  });

  it('creates an active unnamed row and focuses its editor; Escape leaves it unnamed', () => {
    function Harness() {
      const [configs, setConfigs] = useState<SavedConfig[]>([]);
      return <ConfigPanel configs={configs} activeConfigId={configs[0]?.id ?? null} hasMotors
        onApply={() => {}} onEmpty={() => {}} onClear={() => {}} onRename={() => {}} onDelete={() => {}}
        onCreate={() => { setConfigs([{ ...CONFIGS[2]!, id: 'new' }]); return 'new'; }} />;
    }
    act(() => root.render(<Harness />));
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('[aria-current="true"] input')).toBeTruthy();
    edit('discard'); key('Escape');
    expect(host.querySelector('.config-name')?.textContent).toBe('[J1026-CT]');
  });

  it('unchanged Enter and blur never commit or shorten an imported name', () => {
    const onRename = vi.fn();
    for (const name of [null, 'Club', ' padded ', 'x'.repeat(120)]) {
      for (const action of ['Enter', 'blur']) {
        mount({ configs: [{ ...CONFIGS[0]!, name }], onRename });
        act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Rename "]')!.click());
        expect(host.querySelector('input')!.value).toBe(name ?? '');
        if (action === 'blur') act(() => host.querySelector('input')!.blur());
        else key(action);
        expect(onRename).not.toHaveBeenCalled();
      }
    }
    mount({ configs: [{ ...CONFIGS[0]!, name: 'Club' }], onRename });
    click('Rename Club — configuration 1'); edit(' Club '); key('Enter');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('disambiguates every same-label control and describes the deletion consequence', () => {
    mount({ configs: [CONFIGS[0]!, { ...CONFIGS[0]!, id: 'second' }] });
    click('Rename Club field C6 — configuration 2');
    expect(host.querySelector('input')!.getAttribute('aria-label')).toBe('Rename Club field C6 — configuration 2');
    key('Escape');
    click('Delete Club field C6 — configuration 2');
    const group = host.querySelector('[aria-label="Delete Club field C6 — configuration 2?"]')!;
    expect(group).toBeTruthy();
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Delete this configuration? Its motors stay loaded if it is the one you are flying.');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Cancel deleting Club field C6 — configuration 2');
    expect(group.querySelector('[aria-label="Confirm delete Club field C6 — configuration 2"]')).toBeTruthy();
    const names = [...host.querySelectorAll('button:not([aria-label^="Apply "])')]
      .map(b => b.getAttribute('aria-label')).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(['next', 'create', 'outside'] as const)('confirmed deletion focuses %s after the row disappears', (target) => {
    function Harness() {
      const [configs, setConfigs] = useState(target === 'next' ? CONFIGS.slice(0, 2) : CONFIGS.slice(0, 1));
      return <><h2 id="motors" tabIndex={-1}>Motors</h2>
        <ConfigPanel configs={configs} activeConfigId={null} hasMotors={target !== 'outside'}
          onApply={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}}
          onEmpty={() => document.getElementById('motors')!.focus()}
          onDelete={c => setConfigs(prev => prev.filter(row => row.id !== c.id))} /></>;
    }
    act(() => root.render(<Harness />));
    click('Delete Club field C6 — configuration 1');
    click('Confirm delete Club field C6 — configuration 1');
    const focused = document.activeElement;
    expect(focused).not.toBe(document.body);
    expect(focused?.isConnected).toBe(true);
    if (target === 'next') expect(focused?.getAttribute('aria-label')).toBe('Apply No motors');
    else if (target === 'create') expect(focused?.textContent).toBe('+ New configuration from loaded motors');
    else {
      expect(focused?.textContent).toBe('Motors');
      expect(host.querySelector('.config-panel')).toBeNull();
    }
  });

  it('confirms deletion in the row, focuses Cancel, and supports Cancel and Escape', () => {
    const onDelete = vi.fn();
    mount({ onDelete });
    click('Delete Club field C6 — configuration 1');
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(host.querySelector('.config-row')?.textContent).toContain('Its motors stay loaded');
    click('Cancel deleting Club field C6 — configuration 1');
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Delete Club field C6 — configuration 1');
    click('Delete Club field C6 — configuration 1'); key('Escape');
    expect(onDelete).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Delete this configuration?');
    click('Delete Club field C6 — configuration 1'); click('Confirm delete Club field C6 — configuration 1');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(CONFIGS[0]);
  });

  it.each(['Delete', 'Rename'] as const)('clears pending %s when configurations are replaced or removed', action => {
    const onDelete = vi.fn();
    const onRename = vi.fn();
    for (const replacement of ['same IDs', 'removed', 'empty'] as const) {
      mount({ onDelete, onRename });
      click(`${action} Club field C6 — configuration 1`);
      if (action === 'Rename') edit('uncommitted');
      const configs = replacement === 'same IDs' ? structuredClone(CONFIGS)
        : replacement === 'removed' ? CONFIGS.slice(1) : [];
      mount({ configs, hasMotors: replacement !== 'empty', onDelete, onRename });
      expect(host.querySelector('input')).toBeNull();
      expect(host.querySelector('[aria-label^="Confirm delete"]')).toBeNull();
      // Reintroducing an old object must not resurrect its discarded action.
      mount({ onDelete, onRename });
      expect(host.querySelector('input')).toBeNull();
      expect(host.querySelector('[aria-label^="Confirm delete"]')).toBeNull();
      expect(onDelete).not.toHaveBeenCalled();
      expect(onRename).not.toHaveBeenCalled();
    }
  });

  it.each(['Delete', 'Rename'] as const)('keeps pending %s during unrelated row and active-state changes', action => {
    mount();
    click(`${action} Club field C6 — configuration 1`);
    mount({ configs: [CONFIGS[0]!, { ...CONFIGS[1]!, name: 'Other' }], activeConfigId: 'cfg-b' });
    expect(host.querySelector(action === 'Rename' ? 'input' : '[aria-label^="Confirm delete"]')).toBeTruthy();
  });

  it('Apply leads every row, so the buttons line up where the eye lands first', () => {
    // The owner's call, 2026-08-26. Reordered in the DOM, not with CSS
    // `order` — assert the DOM, because that is what the tab order follows.
    mount();
    for (const row of host.querySelectorAll('.config-row')) {
      expect(row.firstElementChild!.tagName).toBe('BUTTON');
      expect(row.firstElementChild!.textContent).toBe('Apply');
    }
  });

  it('every Apply button says what it applies, not just "Apply"', () => {
    // Leading the row costs the screen-reader cue that came from reading the
    // configuration's name immediately before its button. Five buttons all
    // named "Apply" is what that would leave behind.
    mount();
    const labels = Array.from(host.querySelectorAll('.config-row button'))
      .map((b) => b.getAttribute('aria-label'));
    expect(labels.every((l) => l && l !== 'Apply')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe('Apply None — unload every motor');
  });

  it('the rows scroll inside the panel, below a heading that stays put', () => {
    mount();
    const list = host.querySelector('.config-list');
    expect(list).toBeTruthy();
    // The heading must be a SIBLING of the scroller, not inside it.
    expect(list!.querySelector('h2')).toBeFalsy();
    expect(host.querySelector('.config-panel > h2')?.textContent).toBe('Flight configurations');
    expect(list!.querySelectorAll('.config-row').length)
      .toBe(host.querySelectorAll('.config-row').length);
  });
});
