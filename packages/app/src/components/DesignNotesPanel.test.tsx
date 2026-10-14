// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { DesignNotesPanel } from './DesignNotesPanel.js';
import { useTreeHistory } from '../hooks/useTreeHistory.js';
import type { FlightTree } from '../model/design.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('edits, clears, adds dated notes and undoes each entry without changing parts', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const components: FlightTree['components'] = [{ type: 'stage', id: 's', comment: 'Stage only' }];
  let current: FlightTree;
  function Probe() {
    const history = useTreeHistory({ components });
    current = history.tree as FlightTree;
    return <><DesignNotesPanel tree={current} onChange={history.setTree} onAddRevision={history.commitStep} />
      <button onClick={history.undo}>Undo</button><button onClick={history.redo}>Redo</button></>;
  }
  const field = (label: string) => {
    const el = [...host.querySelectorAll('label')].find(l => l.textContent === label)!;
    expect(el).toBeDefined();
    return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${el.htmlFor}"]`)!;
  };
  const input = async (label: string, value: string) => {
    const el = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const click = async (text: string) => act(async () => {
    [...host.querySelectorAll('button')].find(b => b.textContent === text)!.click();
  });
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toContain('No dated revisions');
    for (const [label, value] of [['Designer', 'Zoë'], ['Kit name', 'Kit'], ['Kit manufacturer', 'Maker'],
      ['Kit part number', 'BT-2+'], ['Design comments', 'First\n钛 <&>'], ['Revision', 'Rev A']]) await input(label!, value!);
    expect(current!.provenance).toMatchObject({ designer: 'Zoë', kitName: 'Kit', kitManufacturer: 'Maker', kitPartNumber: 'BT-2+', comment: 'First\n钛 <&>', revision: 'Rev A' });
    await input('Designer', '');
    expect(current!.provenance?.designer).toBeUndefined();
    await input('Entry date', '2026-10-13');
    await input('Revision note', 'Rounded fins\n钛 <&>');
    await click('Add revision');
    expect(current!.provenance?.revisions).toEqual([{ date: '2026-10-13', text: 'Rounded fins\n钛 <&>' }]);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-13');
    expect(field('Revision note').value).toBe('');
    await click('Undo'); expect(current!.provenance?.revisions).toBeUndefined();
    await click('Redo'); expect(current!.provenance?.revisions).toHaveLength(1);
    await input('Entry date', '2026-10-14');
    await input('Revision note', 'Weighed again');
    await click('Add revision');
    expect(current!.provenance?.revisions).toEqual([{ date: '2026-10-13', text: 'Rounded fins\n钛 <&>' },
      { date: '2026-10-14', text: 'Weighed again' }]);
    await click('Undo'); expect(current!.provenance?.revisions).toHaveLength(1);
    expect(current!.components).toBe(components);
    expect(host.textContent).toContain('desktop OpenRocket');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('keeps an invalid or empty dated entry out of the design and explains the date error', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let current: FlightTree = { components: [] };
  const render = () => root.render(<DesignNotesPanel tree={current} onChange={t => { current = t; render(); }}
    onAddRevision={t => { current = t; render(); }} />);
  try {
    await act(async () => render());
    const add = [...host.querySelectorAll('button')].find(b => b.textContent === 'Add revision')!;
    expect(add.disabled).toBe(true);
    const note = host.querySelector<HTMLTextAreaElement>('[aria-label="Revision note"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Keep draft');
      note.dispatchEvent(new Event('input', { bubbles: true }));
      const date = host.querySelector<HTMLInputElement>('input[type="date"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(date, '');
      date.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => add.click());
    expect(current.provenance?.revisions).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('date');
    const date = host.querySelector('input[type="date"]')!;
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(date.getAttribute('aria-describedby')!)?.textContent).toContain('date');
    expect(note.value).toBe('Keep draft');
    expect(document.activeElement).toBe(date);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
