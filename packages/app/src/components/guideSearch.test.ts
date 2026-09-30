// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { findGuideMatches, highlightGuide, indexGuide } from './guideSearch.js';

describe('guide text matching', () => {
  const sections = [
    { id: 'first', title: 'Rocket guide', html: '<p>A <strong>rocket</strong> motor &amp; rocket motor. [x] İ ROCKET</p><p>separate</p><p>blocks</p>' },
    { id: 'glossary', title: 'Glossary', html: '<h3 id="glossary-rocket">Rocket motor</h3><p>Details.</p>' },
  ];

  it('matches inline-spanning phrases, entities, titles and multiple sections in reading order', () => {
    const index = indexGuide(sections);
    const matches = findGuideMatches(index, 'ROCKET motor');
    expect(matches.map((m) => m.sectionId)).toEqual(['first', 'first', 'glossary']);
    const content = document.createElement('div');
    content.innerHTML = highlightGuide(index[0]!, matches);
    expect(content.querySelector('strong mark')!.textContent).toBe('rocket');
    expect([...content.querySelectorAll('[data-guide-match="0"]')].map((m) => m.textContent).join('')).toBe('rocket motor');
    expect(content.querySelector('[data-guide-match="1"]')!.textContent).toBe('rocket motor');
    expect(findGuideMatches(index, '&')[0]!.length).toBe(1);
    expect(findGuideMatches(index, 'rocket guide')[0]!.block).toBe(0);
    expect(findGuideMatches(index, 'separateblocks')).toEqual([]);
    expect(highlightGuide(index[1]!, matches)).toContain('id="glossary-rocket"');
    expect(index[0]!.content.querySelector('mark')).toBeNull();
  });

  it('treats punctuation literally, rejects blank queries and preserves offsets after Unicode case folds', () => {
    const index = indexGuide(sections);
    expect(findGuideMatches(index, '[x]')).toHaveLength(1);
    expect(findGuideMatches(index, '.*')).toEqual([]);
    expect(findGuideMatches(index, '   ')).toEqual([]);
    const matches = findGuideMatches(index, 'rocket');
    const content = document.createElement('div');
    content.innerHTML = highlightGuide(index[0]!, matches);
    expect([...content.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Rocket', 'rocket', 'rocket', 'ROCKET']);
    expect(highlightGuide(index[0]!, [])).not.toContain('<mark');
  });
});
