import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

it('bounds shared modal cards in short viewports with a vh fallback before dvh', () => {
  const css = read('../src/styles.css');
  const card = /(?:^|\n\n)\.modal-card \{([^}]+)\}/.exec(css)[1];
  const heights = [...card.matchAll(/max-height:\s*([^;]+);/g)].map(m => m[1]);
  expect(heights).toEqual(['calc(100vh - 32px)', 'calc(100dvh - 32px)']);
  expect(card).toMatch(/box-sizing:\s*border-box/);
  expect(card).toMatch(/overflow-y:\s*auto/);
  expect(read('../src/components/MyMaterialsDialog.tsx')).not.toContain("maxHeight: 'calc(100dvh");
});

it('uses themed material entry and destructive preset confirmation buttons', () => {
  expect(read('../src/components/PreferencesDialog.tsx')).toMatch(/<button className="file-btn" type="button" onClick=\{\(\) => setMaterialsOpen\(true\)\}>My materials/);
  expect(read('../src/components/PresetPicker.tsx')).toMatch(/<button className="file-btn modal-danger" onClick=\{deletePart\}/);
});
