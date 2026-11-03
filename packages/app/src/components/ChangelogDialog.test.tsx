// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGELOG, PRE_VERSIONING_NOTE } from '../changelog.js';
import { APP_VERSION } from '../version.js';
import { renderReleaseNotes } from '../../scripts/release-notes.mjs';
import { ChangelogDialog } from './ChangelogDialog.js';

vi.mock('../changelog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../changelog.js')>();
  const changelog = structuredClone(original.CHANGELOG);
  for (const entry of changelog.slice(1, 11)) {
    entry.summary = [`Earlier summary for v${entry.version}`, `More summary for v${entry.version}`, `Last summary for v${entry.version}`];
  }
  return { ...original, CHANGELOG: changelog };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const newest = CHANGELOG[0]!;
const originalSummary = newest.summary;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  newest.summary = originalSummary;
});
const mount = (onClose = () => {}) => act(() => root.render(<ChangelogDialog onClose={onClose} />));

describe('the version badge summary', () => {
  it('shows only the newest summary, with metadata, header and full-notes link', () => {
    mount();
    expect(host.querySelector('h2')?.textContent).toBe(`What's new — v${APP_VERSION} beta`);
    const section = host.querySelector('section')!;
    expect(section.textContent).toContain(newest.title);
    expect(section.textContent).toContain(newest.date);
    expect([...section.querySelectorAll('li')].map((li) => li.textContent)).toEqual(newest.summary);
    for (const item of newest.items) expect(host.textContent).not.toContain(item);
    expect(host.textContent).not.toContain(PRE_VERSIONING_NOTE);
    const link = section.querySelector('a')!;
    expect(link.textContent?.trim()).toBe(`Full release notes for v${newest.version}`);
    expect([...host.querySelectorAll('p')].filter((p) => p.textContent === 'Release notes open in a new tab.')).toHaveLength(1);
    expect(link.href).toBe(`https://mmrsim.mountainmanrockets.com/releases/#v${newest.version}`);
    const page = new DOMParser().parseFromString(renderReleaseNotes(CHANGELOG, PRE_VERSIONING_NOTE).replace(/<link[^>]*>/g, ''), 'text/html');
    expect(page.getElementById(new URL(link.href).hash.slice(1))?.querySelector('.title')?.textContent).toBe(newest.title);
  });
  it('lists exactly the next ten releases as version links, dates and titles', () => {
    mount();
    const earlier = host.querySelectorAll('section')[1]!;
    expect(earlier.querySelector('h3')?.textContent).toBe('Earlier releases');
    const list = earlier.querySelector('.changelog-earlier')!;
    expect(list.getAttribute('role')).toBe('list');
    const rows = [...list.children];
    expect(rows).toHaveLength(10);
    for (const [i, row] of rows.entries()) {
      const entry = CHANGELOG[i + 1]!;
      expect(row.querySelector('a')?.textContent).toBe(`v${entry.version}`);
      expect(row.querySelector('a')?.href).toBe(`https://mmrsim.mountainmanrockets.com/releases/#v${entry.version}`);
      expect(row.textContent).toContain(entry.date);
      expect(row.textContent).toContain(entry.title);
      expect(entry.summary).toHaveLength(3);
      for (const item of [...entry.items, ...entry.summary!]) expect(row.textContent).not.toContain(item);
    }
    const all = [...earlier.querySelectorAll('a')].find((a) => a.textContent === 'All releases')!;
    expect(all.href).toBe('https://mmrsim.mountainmanrockets.com/releases/');
    for (const link of host.querySelectorAll('a')) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
  });
  it('falls back to newest items when its mocked summary is absent', () => {
    delete newest.summary;
    mount();
    expect([...host.querySelector('section')!.querySelectorAll('li')].map((li) => li.textContent)).toEqual(newest.items);
  });
  it('keeps Close and Escape working', () => {
    const close = vi.fn();
    mount(close);
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(close).toHaveBeenCalledTimes(1);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
