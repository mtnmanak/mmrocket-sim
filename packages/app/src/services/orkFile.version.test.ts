// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { NoticeBar } from '../components/NoticeBar.js';
import { planImport } from './importApply.js';
import { importOrk } from './orkFile.js';

const design = (version: string | null, extra = '') => `<openrocket${version === null ? '' : ` version="${version}"`} creator="OpenRocket 24.12">
  <rocket><name>Version check</name><subcomponents><stage><name>Sustainer</name><subcomponents>
    <bodytube><name>Body</name><length>0.4</length><radius>0.025</radius><thickness>0.001</thickness></bodytube>
    ${extra}
  </subcomponents></stage></subcomponents></rocket></openrocket>`;

describe('.ork newer-format warning', () => {
  it.each(['1.11', '1.20', '2.0'])(
    'shows and announces the clean format %s import warning without manual expansion', (version) => {
      const imported = importOrk(design(version));
      expect(imported.motors).toEqual({});
      expect(imported.notes).toHaveLength(1);
      const plan = planImport(imported, { working: {}, configs: {} }, {
        launch: DEFAULT_CONDITIONS,
        text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
      });
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        act(() => { root.render(createElement(NoticeBar, { notices: [] })); });
        const alert = host.querySelector('[role="alert"]');
        act(() => { root.render(createElement(NoticeBar, {
          notices: [{ id: 'file-note', ...plan.note }],
        })); });
        expect.soft(host.querySelector('[role="region"]')?.textContent).toContain(imported.notes[0]);
        expect.soft(host.querySelector('.notice-toggle')?.getAttribute('aria-expanded')).toBe('true');
        expect(host.querySelector('[role="alert"]')).toBe(alert);
        expect.soft(alert?.textContent).toContain(imported.notes[0]);
        expect(alert?.getAttribute('aria-live')).toBe('assertive');
        expect.soft(plan.note.severity).toBe('warn');
      } finally {
        act(() => { root.unmount(); });
        host.remove();
      }
    });

  it.each(['1.11', '1.20', '2.0'])(
    'opens format %s and warns about settings being ignored or lost on saving', (version) => {
      const result = importOrk(design(version));
      expect(result.name).toBe('Version check');
      expect(result.tree.components[0]!.children![0]).toMatchObject({ type: 'bodytube', length: 0.4 });
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toContain(version);
      expect(result.notes[0]).toMatch(/newer OpenRocket/);
      expect(result.notes[0]).toMatch(/settings may be ignored/);
      expect(result.notes[0]).toMatch(/lost.*sav/i);
    });

  it.each(['1.3', '1.4', '1.9', '1.10', null, '', 'unknown'])(
    'keeps the existing quiet import for version %j', (version) => {
      const result = importOrk(design(version));
      expect(result.tree.components[0]!.children![0]).toMatchObject({ type: 'bodytube', length: 0.4 });
      expect(result.notes).toEqual([]);
      const plan = planImport(result, { working: {}, configs: {} }, {
        launch: DEFAULT_CONDITIONS,
        text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
      });
      expect(plan.note.severity).toBe('info');
    });

  it('keeps unrelated reader notes informational', () => {
    const imported = importOrk(design('1.10', '<futurepart><name>Future</name></futurepart>'));
    const plan = planImport(imported, { working: {}, configs: {} }, {
      launch: DEFAULT_CONDITIONS,
      text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
    });
    expect(plan.note.text).toContain('Ignored unsupported components: futurepart.');
    expect(plan.note.severity).toBe('info');
  });

  it('carries the warning and ignored-component note from a zipped file into the import notice', () => {
    const bytes = zipSync({ 'rocket.ork': strToU8(design('1.11', '<futurepart><name>Future</name></futurepart>')) });
    const imported = importOrk(bytes.buffer as ArrayBuffer);
    const plan = planImport(imported, { working: {}, configs: {} }, {
      launch: DEFAULT_CONDITIONS,
      text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
    });
    expect(plan.snapshot.tree.components[0]!.children![0]!.type).toBe('bodytube');
    expect(plan.note.text).toMatch(/Loaded.*Version check/);
    expect(plan.note.text).toMatch(/newer OpenRocket/);
    expect(plan.note.text).toContain('Ignored unsupported components: futurepart.');
  });
});
