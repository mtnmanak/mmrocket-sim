// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoticeBar, type Notice } from './NoticeBar.js';
import type { ImportNote } from '../services/importNotes.js';
import { importOrk } from '../services/orkFile.js';
import { planImport, resolveImportMotors } from '../services/importApply.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import type { MountMotor } from '../model/design.js';

/**
 * NOTES-2 (D7 §4, Eric 2026-10-12, ruling 3): ONE file-open group on the bar.
 * Collapsed, it takes its highest line's tier and leads with its most
 * important line plus "N changes" — never "Loaded …"; expanded, Danger →
 * Caution → Information, each line in its own treatment. The tiers come from
 * the lines' records; the words are never read.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const draw = (notices: Notice[]) => { act(() => { root.render(<NoticeBar notices={notices} />); }); };
const bar = () => host.querySelector('.notice-bar')!;
const toggle = () => host.querySelector<HTMLButtonElement>('.notice-toggle')!;
const polite = () => host.querySelector('.notice-announce[role="status"]')!;
const assertive = () => host.querySelector('.notice-announce[role="alert"]')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  document.body.classList.remove('has-notice');
});

const line = (tier: ImportNote['tier'], text: string): ImportNote => ({ kind: `test.${tier}`, tier, text });
const open = (lines: ImportNote[], severity: Notice['severity'] = 'info'): Notice => {
  const heading = 'Loaded “Goblin.ork”.';
  return { id: 'file-note', severity, text: [heading, ...lines.map(l => l.text)].join('\n'), group: { heading, lines } };
};

it('N046 shows producer codes beside import lines without changing their text or tier', () => {
  draw([open([{ kind: 'I03.left-out', tier: 'caution', text: 'Left out the named part.' }], 'warn')]);
  const code = host.querySelector<HTMLButtonElement>('button[aria-label="Explain note I03.left-out"]');
  expect(code).not.toBeNull();
  expect(code!.closest('.message-caution')?.textContent).toContain('Left out the named part.');
  act(() => code!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('missing parts');
});

describe('the collapsed file-open group', () => {
  it('takes the highest line’s tier and leads with that line and "N changes", not "Loaded …"', () => {
    draw([open([line('information', 'Translated a pod.'), line('caution', 'A fin outline was replaced.'),
      line('information', 'Opened “A”.')])]);
    expect(bar().classList.contains('expanded')).toBe(false);
    const item = bar().querySelector('.notice-item')!;
    expect(item.classList.contains('message-caution')).toBe(true);
    expect(item.classList.contains('message-danger')).toBe(false);
    const shown = item.querySelector('.notice-oneline')!.textContent!;
    expect(shown).toContain('Caution:');
    expect(shown).toContain('A fin outline was replaced. — 3 changes');
    expect(shown).not.toContain('Loaded');
  });

  it('Danger outranks Caution; an all-Information group stays unfilled', () => {
    draw([open([line('caution', 'c'), line('danger', 'd'), line('information', 'i')])]);
    expect(bar().querySelector('.notice-item')!.classList.contains('message-danger')).toBe(true);
    expect(bar().querySelector('.notice-oneline')!.textContent).toContain('d — 3 changes');
    draw([open([line('information', 'Only a receipt.')])]);
    const item = bar().querySelector('.notice-item')!;
    expect(item.classList.contains('message-tier')).toBe(false);
    expect(item.querySelector('.notice-oneline')!.textContent).toContain('Only a receipt. — 1 change');
  });

  it('a clean open (no lines) shows its heading as before', () => {
    draw([open([])]);
    expect(bar().querySelector('.notice-oneline')!.textContent).toContain('Loaded “Goblin.ork”.');
  });

  it('a headless one-line group (a configuration switch) reads as its line, in its tier, with no count', () => {
    const text = "Motor “Z1” couldn't be matched when the file was opened.";
    draw([{ id: 'file-note', severity: 'warn', text, group: { lines: [line('caution', text)] } }]);
    act(() => { toggle().click(); });
    const item = bar().querySelector('.notice-item')!;
    expect(item.classList.contains('message-caution')).toBe(true);
    const shown = item.querySelector('.notice-oneline')!.textContent!;
    expect(shown).toContain(`Caution: ${text}`);
    expect(shown).not.toContain('change');
  });
});

describe('the expanded file-open group', () => {
  it('lists Danger, then Caution, then Information, stable within each, each line in its own tier', () => {
    draw([open([line('information', 'i1'), line('caution', 'c1'), line('danger', 'd1'), line('information', 'i2'),
      line('caution', 'c2')])]);
    act(() => { toggle().click(); });
    const group = bar().querySelector('.notice-item.notice-group')!;
    // The group itself is not painted: only the lines that earned it.
    expect(group.classList.contains('message-tier')).toBe(false);
    expect(group.querySelector('.notice-group-heading')!.textContent).toBe('Loaded “Goblin.ork”.');
    const lines = [...group.querySelectorAll('.notice-line')];
    expect(lines.map(li => li.textContent!.replace(/^.*?(?:Danger|Caution): /, ''))).toEqual(['d1', 'c1', 'c2', 'i1', 'i2']);
    expect(lines.map(li => li.classList.contains('message-danger') ? 'danger'
      : li.classList.contains('message-caution') ? 'caution' : 'information'))
      .toEqual(['danger', 'caution', 'caution', 'information', 'information']);
    expect(group.querySelector('.notice-lines')!.getAttribute('aria-label')).toBe('5 changes');
  });

  it('never reads the words: an alarming Information line stays quiet, a bland Caution line is filled', () => {
    draw([open([line('information', 'Danger: refused, failed, not applied, dropped.'), line('caution', 'All is well.')])]);
    expect(bar().querySelector('.notice-oneline')!.textContent).toContain('All is well. — 2 changes');
    act(() => { toggle().click(); });
    const [first, second] = [...bar().querySelectorAll('.notice-line')];
    expect(first!.textContent).toContain('All is well.');
    expect(first!.classList.contains('message-caution')).toBe(true);
    expect(second!.classList.contains('message-tier')).toBe(false);
  });

  it('a note written as plain text (an older session’s, no group) renders as one Information item', () => {
    draw([{ id: 'file-note', severity: 'info', text: 'Old line one.\nOld line two.' }]);
    act(() => { toggle().click(); });
    const item = bar().querySelector('.notice-item')!;
    expect(item.classList.contains('message-tier')).toBe(false);
    expect(item.querySelector('.notice-line')).toBeNull();
    expect(item.textContent).toContain('Old line one.');
  });
});

describe('announcing the group', () => {
  it('says the summary once — heading, tier word, lead line, count — rather than every line', () => {
    draw([open([line('information', 'i1'), line('caution', 'c1'), line('information', 'i2')], 'warn')]);
    expect(assertive().textContent).toBe('Warning: Loaded “Goblin.ork”. Caution: c1 — 3 changes.');
    expect(polite().textContent).toBe('');
    // A warning still opens the bar on arrival (unchanged).
    expect(bar().classList.contains('expanded')).toBe(true);
  });

  it('keeps the expand-on-arrival flag for an Information group and a later collapse wins', () => {
    const note = { ...open([line('caution', 'Recovery: overrides.')]), expand: true };
    draw([note]);
    expect(bar().classList.contains('expanded')).toBe(true);
    expect(polite().textContent).toBe('Notice: Loaded “Goblin.ork”. Caution: Recovery: overrides. — 1 change.');
    act(() => { toggle().click(); });
    draw([{ ...note }]);
    expect(bar().classList.contains('expanded')).toBe(false);
  });

  it('a Caution group leads a quiet notice of the same severity on the collapsed bar', () => {
    draw([{ id: 'copied', severity: 'info', text: 'Share link copied.' }, open([line('caution', 'c')])]);
    expect(bar().querySelector('.notice-oneline')!.textContent).toContain('c — 1 change');
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const LEM = join(here, '../../../../docs/User files/atestani files/LEM-1-2026_2.ork');

it.skipIf(!existsSync(LEM))('LEM-1-2026_2.ork: the bar leads with the Caution override note', async () => {
  const b = readFileSync(LEM);
  const imported = { ...importOrk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer), sourceFormat: 'ork' as const };
  const loaded: MountMotor = {
    label: 'F67C-8', meta: { label: 'F67C', manufacturer: 'AeroTech', motorId: 'db-F67C' }, ignition: { event: 'automatic', delay: 0 },
    spec: { designation: 'F67C', diameter: 0.029, length: 0.1, cgX: 0.05, ejectionDelay: 8, times: [0, 1], thrusts: [0, 0], masses: [0.1, 0.05] },
  };
  const plan = planImport(imported, await resolveImportMotors(imported, async () => ({ motor: loaded, note: '' })),
    { launch: DEFAULT_CONDITIONS, text: { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` } });
  draw([{ id: 'file-note', severity: plan.note.severity, text: plan.note.text, group: plan.note.group,
    ...(plan.note.expand ? { expand: true } : {}) }]);
  act(() => { toggle().click(); });
  const item = bar().querySelector('.notice-item')!;
  expect(item.classList.contains('message-caution')).toBe(true);
  expect(item.querySelector('.notice-oneline')!.textContent).toMatch(/Caution: Recovery: Flight configuration “.*” overrides the deployment setting/);
  act(() => { toggle().click(); });
  const first = bar().querySelector('.notice-line')!;
  expect(first.classList.contains('message-caution')).toBe(true);
  expect(first.textContent).toContain('Parachute (×2)');
});
