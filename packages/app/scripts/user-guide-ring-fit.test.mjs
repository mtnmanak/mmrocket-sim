import { describe, expect, it } from 'vitest';
import { compileGuide } from '../../../scripts/build-user-guide.mjs';

describe('Centering ring glossary fabrication caution', () => {
  it('states the tolerance and names its section when opened directly', () => {
    const { ts } = compileGuide();
    const sections = JSON.parse(ts.match(/export const GUIDE_SECTIONS[^=]*= ([\s\S]*);/)[1]);
    const glossary = sections.find(section => section.id === 'glossary');
    const entry = glossary.html.match(/<p id="glossary-centering-ring"[^>]*>([\s\S]*?)<\/p>/)[1];
    expect(entry).toContain('0.25 mm radius');
    expect(entry).toContain('0.5 mm diameter');
    expect(entry).toContain('Printing oversized parts on a 3D printer');
    expect(entry).not.toContain('described above');
  });
});
