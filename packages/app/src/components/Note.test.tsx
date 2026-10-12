// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Note, type NoteTier } from './Note.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each<NoteTier>(['information', 'caution', 'danger'])('%s has a visible word and hidden glyph, without unsolicited alerts', tier => {
  act(() => root.render(<Note tier={tier} as="p" className="comp-stats">The operation's consequence.</Note>));
  const p = host.querySelector('p')!;
  expect(p.hasAttribute('role')).toBe(false);
  expect(p.classList.contains('message-tier')).toBe(tier !== 'information');
  if (tier === 'information') {
    expect(p.textContent).toBe("The operation's consequence.");
    expect(p.querySelector('.message-label')).toBeNull();
  } else {
    expect(p.classList.contains(`message-${tier}`)).toBe(true);
    expect(p.querySelector('.message-label')!.textContent).toContain(tier === 'danger' ? 'Danger:' : 'Caution:');
    expect(p.querySelector('[aria-hidden="true"]')!.textContent).toContain(tier === 'danger' ? '⛔' : '⚠');
  }
});

it('retains the caller’s live role and field association', () => {
  act(() => root.render(<Note tier="danger" id="failed-save" role="alert">Nothing written.</Note>));
  expect(host.querySelector('#failed-save[role="alert"]')!.textContent).toContain('Nothing written.');
});
