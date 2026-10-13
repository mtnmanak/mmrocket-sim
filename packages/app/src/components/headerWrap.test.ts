import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .find((match) => {
      const prefix = css.slice(0, match.index);
      return (prefix.match(/\{/g)?.length ?? 0) === (prefix.match(/\}/g)?.length ?? 0);
    });
  expect(block, `${selector} has no unconditional rule in styles.css`).toBeDefined();
  return block![1]!;
};

/**
 * Tier 2 header overflow (11 October 2026 docs audit): the 979px wrap gate
 * left Save As squeezed and the row overflowing near 1024px. As in
 * panelHeadWrap.test.ts, these checks hold the CSS contract, not pixel layout.
 * Geometry needs a browser; happy-dom does not lay out this flex row.
 */
describe('header controls wrap before overflowing', () => {
  it('lets the row and brand wrap without a viewport gate', () => {
    expect(rule('.app-header-row')).toContain('display: flex');
    expect(rule('.app-header-row')).toContain('flex-wrap: wrap');
    expect(rule('.app-header-brand')).toContain('flex-wrap: wrap');
    // Basis 0, floored at min-content: the brand wraps inside itself before a button leaves the row.
    expect(rule('.app-header-brand')).toContain('flex: 1 1 0');
    expect(rule('.app-header-brand')).toContain('min-width: min-content');
  });

  it('keeps complete button labels together rather than squeezing Save As', () => {
    const controls = rule('.app-header-row > .file-btn, .app-header-row > .file-menu-wrap');
    expect(controls).toContain('flex: 0 0 auto');
    expect(rule('.app-header-row .file-btn')).toContain('white-space: nowrap');
  });

  it('anchors both disclosures to the wrapping row and bounds their outer width', () => {
    expect(rule('.app-header-row')).toContain('position: relative');
    expect(rule('.app-header-row .file-menu-wrap')).toContain('position: static');
    const menu = rule('.app-header-row .file-menu');
    expect(menu).toContain('box-sizing: border-box');
    expect(menu).toContain('min-width: min(240px, 100%)');
    expect(menu).toContain('max-width: 100%');
    expect(rule('.file-menu')).toContain('right: 0');
    expect(rule('.file-menu')).toContain('top: calc(100% + 4px)');
  });

  it('lets the filename, save status and loss-warning control use separate lines', () => {
    expect(rule('.design-file')).toContain('flex-wrap: wrap');
    expect(rule('.design-file-name')).toContain('max-width: 100%');
    expect(rule('.design-loss-warning')).toContain('max-width: 100%');
  });
});
