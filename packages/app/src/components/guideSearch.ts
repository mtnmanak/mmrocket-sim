import type { GuideSection } from '../data/userGuide.js';

export interface GuideIndex {
  section: GuideSection;
  content: HTMLDivElement;
  blocks: string[];
}

export interface GuideMatch {
  sectionId: string;
  block: number;
  start: number;
  length: number;
}

const BLOCKS = 'h2, h3, p, li, th, td, pre';

export function indexGuide(sections: GuideSection[]): GuideIndex[] {
  return sections.map((section) => {
    const content = document.createElement('div');
    content.innerHTML = section.html;
    const title = document.createElement('h2');
    title.className = 'guide-section-title';
    title.textContent = section.title;
    content.prepend(title);
    return { section, content, blocks: Array.from(content.querySelectorAll(BLOCKS), (b) => b.textContent ?? '') };
  });
}

export function findGuideMatches(index: GuideIndex[], query: string): GuideMatch[] {
  if (!query.trim()) return [];
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches: GuideMatch[] = [];
  for (const { section, blocks } of index) {
    blocks.forEach((text, block) => {
      for (const match of text.matchAll(pattern)) {
        matches.push({ sectionId: section.id, block, start: match.index, length: match[0].length });
      }
    });
  }
  return matches;
}

export function highlightGuide(entry: GuideIndex, matches: GuideMatch[]): string {
  const content = entry.content.cloneNode(true) as HTMLDivElement;
  const blocks = content.querySelectorAll(BLOCKS);
  const byBlock = new Map<number, { match: GuideMatch; id: number }[]>();
  matches.forEach((match, id) => {
    if (match.sectionId !== entry.section.id) return;
    const group = byBlock.get(match.block) ?? [];
    group.push({ match, id });
    byBlock.set(match.block, group);
  });
  for (const [block, group] of byBlock) {
    const walker = document.createTreeWalker(blocks[block]!, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let offset = 0;
    for (const node of nodes) {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const { match, id } of group) {
        const start = Math.max(0, match.start - offset);
        const end = Math.min(text.length, match.start + match.length - offset);
        if (start >= end) continue;
        fragment.append(text.slice(cursor, start));
        const mark = document.createElement('mark');
        mark.dataset['guideMatch'] = String(id);
        mark.textContent = text.slice(start, end);
        fragment.append(mark);
        cursor = end;
      }
      fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
      offset += text.length;
    }
  }
  return content.innerHTML;
}
