// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONFIG_DELETE_LOSS, ConfigPanel } from './ConfigPanel.js';
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

  it.each([false, true])('fills deletion only when the configuration has unprotected work: %s', deletionUnprotected => {
    mount({ deletionUnprotected });
    act(() => (host.querySelector('[aria-label="Delete Club field C6 — configuration 1"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll('.message-danger')).toHaveLength(deletionUnprotected ? 1 : 0);
    // Colour is never the only cue (review of NOTES-1, finding 5): the
    // unprotected prompt says "Danger:" in words, and so does its description.
    const group = host.querySelector('[aria-label="Delete Club field C6 — configuration 1?"]')!;
    const description = document.getElementById(group.getAttribute('aria-describedby')!)!;
    expect(description.querySelector('.message-label')?.textContent ?? null)
      .toBe(deletionUnprotected ? '⛔ Danger: ' : null);
    // D7 G21 (review of NOTES-1b, finding 2): Delete is not an undo step, so
    // the Danger block names what is lost, directly above Delete; the quiet
    // prompt says nothing about loss it would not cause.
    expect(description.textContent).toBe(`${deletionUnprotected ? '⛔ Danger: ' : ''}`
      + 'Delete this configuration? Its motors stay loaded if it is the one you are flying.'
      + (deletionUnprotected ? ` ${CONFIG_DELETE_LOSS}` : ''));
    expect(CONFIG_DELETE_LOSS).toContain('Ctrl+Z does not bring a deleted configuration back');
    expect(description.nextElementSibling?.getAttribute('aria-label')).toBe('Confirm delete Club field C6 — configuration 1');
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

  it('CFG-1 chooses a flight configuration or None in one action at the top', () => {
    const { applied, cleared } = mount();
    const chooser = host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]');
    expect(chooser).not.toBeNull();
    expect(chooser!.value).toBe('cfg-a');
    act(() => { chooser!.value = 'cfg-b'; chooser!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(applied).toEqual(['cfg-b']);
    act(() => { chooser!.value = ''; chooser!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(cleared).toEqual([1]);
  });


  const chooser = () => host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!;
  it('CFG-1b treats empty override maps as None and offers no reset', () => {
    mount({ activeConfigId: null, hasMotors: false,
      detachedOverrides: { deployments: {}, separations: {}, ignitions: {} } });
    expect(chooser().value).toBe('');
    expect(host.textContent).not.toContain('Working settings (not saved)');
    expect(host.textContent).not.toContain('Reset every override in this configuration');
  });

  const choose = (id: string) => act(() => { chooser().value = id; chooser().dispatchEvent(new Event('change', { bubbles: true })); });
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
  function click(label: string) {
    const b = [...host.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label)!;
    expect(b).toBeTruthy(); act(() => b.click());
  }
  function key(value: string) {
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); });
  }
  function edit(value: string) {
    const input = host.querySelector('input')!;
    act(() => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
    return input;
  }

  it('lists every name and motor fallback, the file default, active selection and None', () => {
    mount();
    expect([...chooser().options].map(o => o.textContent)).toEqual([
      'Club field C6 — file default', 'No motors', '[J1026-CT]', '[K550W]', 'None (no motors)',
    ]);
    expect(chooser().selectedOptions[0]!.textContent).toBe('Club field C6 — file default');
    expect(chooser().options[1]!.textContent).not.toContain('file default');
  });

  it('choosing each entry applies exactly that config and None clears once', () => {
    const { applied, cleared } = mount();
    for (const c of CONFIGS) choose(c.id);
    expect(applied).toEqual(CONFIGS.map(c => c.id));
    choose(''); expect(cleared).toEqual([1]);
  });

  it('None is selected only without an active config, motors or detached overrides', () => {
    mount({ activeConfigId: null, hasMotors: false }); expect(chooser().value).toBe('');
    mount({ activeConfigId: null }); expect(chooser().selectedOptions[0]!.textContent).toBe('Working settings (not saved)');
    mount({ activeConfigId: null, hasMotors: false, detachedOverrides: { ignitions: { m1: { event: 'never', delay: 0 } } } });
    expect(chooser().value).toBe('__working__');
  });

  it('keeps an empty chooser and disabled New when there are no saved configurations or motors', () => {
    mount({ configs: [], activeConfigId: null, hasMotors: false });
    expect(chooser().value).toBe('');
    // Review of b9-int, finding 7: nothing loaded, so nothing "flies as a working set".
    expect(host.textContent).toContain('No saved configurations.');
    expect(host.textContent).not.toContain('the loaded motors fly');
    expect(host.textContent).toContain("No configuration: the parts' own settings, with no motors");
    expect(button('+ New from loaded motors').disabled).toBe(true);
    // A motor the file named that could not be loaded is working settings with no motor.
    mount({ configs: [], activeConfigId: null, hasMotors: false, unmatchedRefs: { m1: { designation: 'Z999' } as never } });
    expect(chooser().value).toBe('__working__');
    expect(host.textContent).toContain('No saved configurations — working settings, with no motor loaded');
    mount({ configs: [], activeConfigId: null });
    expect(host.textContent).toContain('No saved configurations — the loaded motors fly as a working set');
  });

  it.each([0, 1, 2])('shows %i saved configurations with loaded motors and always offers None', count => {
    mount({ configs: CONFIGS.slice(0, count) });
    expect([...chooser().options].filter(o => o.value && o.value !== '__working__')).toHaveLength(count);
    expect([...chooser().options].at(-1)!.textContent).toBe('None (no motors)');
    expect(button('+ New from loaded motors').disabled).toBe(false);
  });

  it('disables New without a motor and both New and Duplicate at 256, explaining the limit', () => {
    const onCreate = vi.fn(() => null), onDuplicate = vi.fn();
    mount({ hasMotors: false, onCreate, onDuplicate });
    expect(button('+ New from loaded motors').title).toContain('Load a motor');
    act(() => button('+ New from loaded motors').click());
    mount({ configs: Array.from({ length: 256 }, (_, i) => ({ ...CONFIGS[0]!, id: String(i) })), activeConfigId: '0', onCreate, onDuplicate });
    for (const label of ['+ New from loaded motors', 'Duplicate']) {
      expect(button(label).disabled).toBe(true); expect(button(label).title).toContain('256');
      act(() => button(label).click());
    }
    expect(onCreate).not.toHaveBeenCalled(); expect(onDuplicate).not.toHaveBeenCalled();
  });

  it('duplicates an active empty configuration, but not detached settings or None', () => {
    const onDuplicate = vi.fn();
    mount({ activeConfigId: 'cfg-b', hasMotors: false, onDuplicate });
    act(() => button('Duplicate').click()); expect(onDuplicate).toHaveBeenCalledTimes(1);
    for (const hasMotors of [true, false]) {
      mount({ activeConfigId: null, hasMotors, onDuplicate });
      for (const label of ['Duplicate', 'Rename', 'Delete']) expect(button(label).disabled).toBe(true);
      act(() => button('Duplicate').click());
    }
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('renames with Enter/blur, trims, clears to unnamed, and Escape preserves the old name', () => {
    const renamed = vi.fn();
    function Harness() {
      const [configs, setConfigs] = useState([CONFIGS[0]!]);
      return <ConfigPanel configs={configs} activeConfigId="cfg-a" hasMotors onApply={() => {}}
        onClear={() => {}} onCreate={() => null} onDelete={() => {}}
        onRename={(id, name) => { renamed(id, name); setConfigs(prev => renameConfig(prev, id, name)); }} />;
    }
    act(() => root.render(<Harness />));
    click('Rename Club field C6 — configuration 1');
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('input')!.maxLength).toBe(100);
    expect(host.querySelector('input')!.title).toContain('100');
    edit('  Club field  '); key('Enter');
    expect(chooser().selectedOptions[0]!.textContent).toContain('Club field');
    expect(renamed).toHaveBeenCalledTimes(1);
    click('Rename Club field — configuration 1'); edit('cancelled'); key('Escape');
    expect(chooser().selectedOptions[0]!.textContent).toContain('Club field');
    expect(renamed).toHaveBeenCalledTimes(1);
    click('Rename Club field — configuration 1'); const input = edit('  ');
    act(() => input.blur());
    expect(chooser().selectedOptions[0]!.textContent).toContain('[C6-5, D12-0]');
    expect(renamed).toHaveBeenCalledTimes(2);
  });

  it('creates an active unnamed configuration and focuses its editor; Escape leaves it unnamed', () => {
    function Harness() {
      const [configs, setConfigs] = useState<SavedConfig[]>([]);
      return <ConfigPanel configs={configs} activeConfigId={configs[0]?.id ?? null} hasMotors
        onApply={() => {}} onClear={() => {}} onRename={() => {}} onDelete={() => {}}
        onCreate={() => { setConfigs([{ ...CONFIGS[2]!, id: 'new' }]); return 'new'; }} />;
    }
    act(() => root.render(<Harness />));
    act(() => button('+ New from loaded motors').click());
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('[aria-current="true"] input')).toBeTruthy();
    edit('discard'); key('Escape');
    expect(chooser().selectedOptions[0]!.textContent).toBe('[J1026-CT]');
  });

  it('unchanged Enter and blur never commit or shorten an imported name', () => {
    const onRename = vi.fn();
    for (const name of [null, 'Club', ' padded ', 'x'.repeat(120)]) {
      for (const action of ['Enter', 'blur']) {
        mount({ configs: [{ ...CONFIGS[0]!, name }], onRename });
        act(() => button('Rename').click());
        expect(host.querySelector('input')!.value).toBe(name ?? '');
        if (action === 'blur') act(() => host.querySelector('input')!.blur()); else key(action);
        expect(onRename).not.toHaveBeenCalled();
      }
    }
    mount({ configs: [{ ...CONFIGS[0]!, name: 'Club' }], onRename });
    click('Rename Club — configuration 1'); edit(' Club '); key('Enter');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('disambiguates same-label active controls and describes the deletion consequence', () => {
    mount({ configs: [CONFIGS[0]!, { ...CONFIGS[0]!, id: 'second' }], activeConfigId: 'second' });
    click('Rename Club field C6 — configuration 2');
    expect(host.querySelector('input')!.getAttribute('aria-label')).toBe('Rename Club field C6 — configuration 2');
    key('Escape'); click('Delete Club field C6 — configuration 2');
    const group = host.querySelector('[aria-label="Delete Club field C6 — configuration 2?"]')!;
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent)
      .toBe('Delete this configuration? Its motors stay loaded if it is the one you are flying.');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Cancel deleting Club field C6 — configuration 2');
    expect(group.querySelector('[aria-label="Confirm delete Club field C6 — configuration 2"]')).toBeTruthy();
  });

  it.each(['next', 'create', 'empty'] as const)('confirmed deletion keeps focus on the chooser with %s remaining', target => {
    function Harness() {
      const [configs, setConfigs] = useState(target === 'next' ? CONFIGS.slice(0, 2) : CONFIGS.slice(0, 1));
      return <ConfigPanel configs={configs} activeConfigId={configs.some(c => c.id === 'cfg-a') ? 'cfg-a' : null} hasMotors={target !== 'empty'}
        onApply={() => {}} onClear={() => {}} onCreate={() => null} onRename={() => {}}
        onDelete={c => setConfigs(prev => prev.filter(row => row.id !== c.id))} />;
    }
    act(() => root.render(<Harness />));
    click('Delete Club field C6 — configuration 1'); click('Confirm delete Club field C6 — configuration 1');
    expect(document.activeElement).toBe(chooser()); expect(document.activeElement?.isConnected).toBe(true);
  });

  it('confirms deletion inline, focuses Cancel, and supports Cancel and Escape', () => {
    const onDelete = vi.fn(); mount({ onDelete });
    click('Delete Club field C6 — configuration 1'); expect(document.activeElement?.textContent).toBe('Cancel');
    expect(host.textContent).toContain('Its motors stay loaded');
    click('Cancel deleting Club field C6 — configuration 1'); expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Delete Club field C6 — configuration 1');
    click('Delete Club field C6 — configuration 1'); key('Escape'); expect(onDelete).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Delete this configuration?');
    click('Delete Club field C6 — configuration 1'); click('Confirm delete Club field C6 — configuration 1');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(CONFIGS[0]);
  });

  it.each(['Delete', 'Rename'] as const)('clears pending %s when configurations are replaced or removed', action => {
    const onDelete = vi.fn(), onRename = vi.fn();
    for (const replacement of ['same IDs', 'removed', 'empty'] as const) {
      mount({ onDelete, onRename }); click(`${action} Club field C6 — configuration 1`);
      if (action === 'Rename') edit('uncommitted');
      const configs = replacement === 'same IDs' ? structuredClone(CONFIGS) : replacement === 'removed' ? CONFIGS.slice(1) : [];
      mount({ configs, hasMotors: replacement !== 'empty', onDelete, onRename });
      expect(host.querySelector('input')).toBeNull(); expect(host.querySelector('[aria-label^="Confirm delete"]')).toBeNull();
      mount({ onDelete, onRename });
      expect(host.querySelector('input')).toBeNull(); expect(host.querySelector('[aria-label^="Confirm delete"]')).toBeNull();
      expect(onDelete).not.toHaveBeenCalled(); expect(onRename).not.toHaveBeenCalled();
    }
  });

  it.each(['Delete', 'Rename'] as const)('keeps pending %s during unrelated row and active-state changes', action => {
    mount(); click(`${action} Club field C6 — configuration 1`);
    mount({ configs: [CONFIGS[0]!, { ...CONFIGS[1]!, name: 'Other' }], activeConfigId: 'cfg-b' });
    expect(host.querySelector(action === 'Rename' ? 'input' : '[aria-label^="Confirm delete"]')).toBeTruthy();
  });

  it('the labelled chooser precedes actions in DOM and associates the visible summary', () => {
    mount(); expect(host.querySelector('.config-bar')!.firstElementChild!.contains(chooser())).toBe(true);
    expect(document.getElementById(chooser().getAttribute('aria-describedby')!)?.textContent).toBe("Uses every part's own setting.");
  });

  it('reset confirms inline with Cancel focused, Escape cancels, and confirmation calls once', () => {
    const onResetOverrides = vi.fn();
    mount({ configs: [{ ...CONFIGS[0]!, ignitions: { m1: { event: 'never', delay: 0 } } }], onResetOverrides });
    act(() => button('Reset every override in this configuration').click());
    expect(document.activeElement?.textContent).toBe('Cancel'); key('Escape');
    expect(onResetOverrides).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe('Reset every override in this configuration');
    act(() => button('Reset every override in this configuration').click());
    act(() => button('Confirm reset every override').click()); expect(onResetOverrides).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(chooser());
  });

  it('reset confirmation cannot follow an owner switch or a same-id file replacement', () => {
    const config = { ...CONFIGS[0]!, ignitions: { m1: { event: 'never' as const, delay: 0 } } };
    for (const replaced of [false, true]) {
      mount({ configs: [config] }); act(() => button('Reset every override in this configuration').click());
      mount({ configs: replaced ? [structuredClone(config)] : [config], activeConfigId: replaced ? 'cfg-a' : null });
      expect(host.querySelector('[aria-label="Reset every override?"]')).toBeNull();
    }
  });
});
