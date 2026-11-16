// @vitest-environment happy-dom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { IgnitionTuple } from '../model/design.js';
import { MountIgnitionField } from './MountIgnitionField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function render(own: IgnitionTuple, override: IgnitionTuple | undefined) {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<MountIgnitionField mountId="m" mountName="Mount" ownerKey="a" own={own} override={override}
    overrideLabel="Override for “A” only" isStaged={false} onEdit={noop} onEditStart={noop} onEditEnd={noop}
    onEditCancel={noop} onReset={noop} />));
  const status = [...host.querySelectorAll('p')].find(p => p.textContent?.includes('Ignition:'))!;
  return { host, status, unmount: () => act(() => root.unmount()) };
}

/**
 * Review of b9-int, finding 12: the motor card's ignition override takes the
 * Recovery and Stages rows' tier rule (D7 I10) — Caution only when it flies
 * differently from the mount's own setting, the Launch warning's comparison.
 */
describe('the motor card’s ignition status', () => {
  it('row 142: keeps status, scope, reset and controls in separate ordered rows', () => {
    const { host, status, unmount } = render({ event: 'automatic', delay: 0 }, { event: 'launch', delay: 2 });
    try {
      const editor = host.querySelector('.mount-ignition-field')!;
      expect(editor).not.toBeNull();
      expect([...editor.children].map(child => child.tagName)).toEqual(['LABEL', 'P', 'FIELDSET', 'BUTTON', 'DIV']);
      expect(status.parentElement).toBe(editor);
      expect(status.nextElementSibling?.className).toBe('flight-scope');
      const controls = editor.querySelector('.mount-ignition-controls')!;
      expect(controls).toBe(editor.lastElementChild);
      expect(editor.querySelector('label')?.htmlFor).toBe(controls.querySelector('select')?.id);
      for (const label of editor.querySelectorAll('.flight-scope label')) {
        expect([...label.children].map(child => child.tagName)).toEqual(['INPUT', 'SPAN']);
        expect(label.querySelector('span')?.textContent).not.toBe('');
      }
    } finally { unmount(); }
  });

  it('row 142: shared scope CSS contains wrapping and beats full-width field inputs', () => {
    expect(css).toMatch(/\.mount-ignition-field\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.mount-ignition-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 70px auto;/);
    expect(css).toMatch(/\.flight-scope\s*\{[^}]*min-width:\s*0;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*align-self:\s*flex-start;[^}]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.flight-scope label\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/);
    // The attribute raises specificity above the later .field input width:100%.
    expect(css).toMatch(/\.flight-scope input\[type=['"]radio['"]\]\s*\{\s*width:\s*auto;/);
  });

  it('is Caution for an override that flies differently from the own setting', () => {
    const { status, unmount } = render({ event: 'automatic', delay: 0 }, { event: 'launch', delay: 2 });
    try {
      expect(status.className).toContain('message-caution');
      expect(status.textContent).toContain('Caution:');
      expect(status.textContent).toContain('Ignition: overridden here — Launch + delay (timer), delay 2 s; own setting: Automatic');
      expect(status.textContent).not.toContain('flies the same');
    } finally { unmount(); }
  });

  it('is quiet for an override that flies the same, and for the own setting', () => {
    // A stored delay Never does not use: a different tuple, the same flight.
    const same = render({ event: 'never', delay: 0 }, { event: 'never', delay: 3 });
    try {
      expect(same.status.className).not.toContain('message-caution');
      expect(same.status.textContent).not.toContain('Caution:');
      expect(same.status.textContent).toContain('(flies the same as the own setting).');
    } finally { same.unmount(); }
    const own = render({ event: 'automatic', delay: 0 }, undefined);
    try {
      expect(own.status.className).not.toContain('message-');
      expect(own.status.textContent).toContain("Ignition: uses the mount's own setting — Automatic");
    } finally { own.unmount(); }
  });
});
