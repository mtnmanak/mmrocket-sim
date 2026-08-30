/**
 * Tests for scripts/bbcode-from-blurb.mjs — the one automated check standing between a
 * draft and an unpostable TRF post.
 *
 * It lives here, outside `src`, because it tests a repo-level tool rather than app code:
 * `packages/app/tsconfig.json` includes only `src`, so tsc never sees it, while vitest's
 * default glob (rooted at the app package) does.
 *
 * These tests exist because the two rules the script enforces — TRF's 10,000-character
 * limit and BBCode tag balance — were pinned by nothing at all: the CLI body ran at module
 * top level, so importing the helpers called process.exit(1) before a test could run.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTINUED,
  CONTINUES,
  TRF_POST_LIMIT,
  bbcodePartPathFor,
  bbcodePathFor,
  checkTags,
  looksAlreadyConverted,
  splitBBCode,
  toBBCode,
} from '../../../scripts/bbcode-from-blurb.mjs';

describe('toBBCode', () => {
  it('turns a run of bullets into one list', () => {
    expect(toBBCode('- one\n- two')).toBe('[LIST]\n[*]one\n[*]two\n[/LIST]');
  });

  it('closes the list on a blank line', () => {
    expect(toBBCode('- one\n\n- two')).toBe('[LIST]\n[*]one\n[/LIST]\n\n[LIST]\n[*]two\n[/LIST]');
  });

  it('converts **bold** inline', () => {
    expect(toBBCode('a **b** c')).toBe('a [B]b[/B] c');
  });

  it('makes a bare URL an [URL]', () => {
    expect(toBBCode('https://example.com')).toBe('[URL]https://example.com[/URL]');
  });

  // A `- Title (V0.0NN)` line is a section HEADER, not a list item: a one-item [LIST]
  // renders wrong on XenForo.
  it('renders a release header as bold, not a one-item list', () => {
    expect(toBBCode('- UI Changes (V0.074)')).toBe('[B]UI Changes (V0.074)[/B]');
  });

  // Regression: the match was uppercase-only, but CLAUDE.md and every blurb write versions
  // lowercase in prose, so one keystroke silently produced a one-item [LIST] — and because
  // that output is well-formed, checkTags could never see it.
  it('renders a LOWERCASE release header as bold too', () => {
    expect(toBBCode('- Fixes (v0.075)')).toBe('[B]Fixes (v0.075)[/B]');
  });

  it('closes an open list before a release header', () => {
    expect(toBBCode('- one\n- Fixes (v0.075)'))
      .toBe('[LIST]\n[*]one\n[/LIST]\n[B]Fixes (v0.075)[/B]');
  });

  // Regression: indented bullets used to fall through to raw text, splitting one list into
  // three and leaving `  - sub bullet` sitting between them as literal characters.
  it('nests an indented sub-bullet instead of shattering the list', () => {
    expect(toBBCode('- one\n  - sub a\n  - sub b\n- two')).toBe(
      '[LIST]\n[*]one\n[LIST]\n[*]sub a\n[*]sub b\n[/LIST]\n[*]two\n[/LIST]');
  });

  it('closes every open nesting level at end of input', () => {
    expect(checkTags(toBBCode('- one\n  - sub\n    - deeper'))).toEqual([]);
  });

  it('leaves prose untouched', () => {
    const prose = 'V0.075 is published. Refresh until it reads 0.075.';
    expect(toBBCode(prose)).toBe(prose);
  });
});

describe('checkTags', () => {
  it('passes balanced output', () => {
    expect(checkTags(toBBCode('- one\n- two\n\n**Not fixed yet**'))).toEqual([]);
  });

  it('catches an unbalanced [LIST]', () => {
    expect(checkTags('[LIST]\n[*]one')).toContain('[LIST] 1 vs [/LIST] 0');
  });

  it('catches an unbalanced [B]', () => {
    expect(checkTags('[B]one')).toContain('[B] 1 vs [/B] 0');
  });

  it('catches leftover markdown bold', () => {
    expect(checkTags('a **b')).toContain('leftover ** (markdown bold that did not convert)');
  });

  // Regression: this filter was anchored at column 0, where it was dead code — every
  // column-0 `- ` line has already become [*] or [B] by the time checkTags runs, so it
  // could only ever report 0 and gave false assurance. The lines it can actually catch
  // are the indented ones.
  it('catches an unconverted INDENTED bullet', () => {
    expect(checkTags('[LIST]\n[*]a\n[/LIST]\n  - leaked'))
      .toContain('1 line(s) still start with "- " (not converted to [*])');
  });

  it('does not flag a [*] item that merely contains a dash', () => {
    expect(checkTags(toBBCode('- a - b'))).toEqual([]);
  });
});

describe('the TRF post limit', () => {
  it('is 10,000 characters, counted on the BBCode', () => {
    expect(TRF_POST_LIMIT).toBe(10000);
  });

  // The rule the script exists to enforce. A draft that converts to more than this cannot
  // be posted at all, and the conversion ADDS characters, so the plain-text ceiling is lower.
  it('conversion grows the text, so the plain-text ceiling is below the limit', () => {
    const plain = '- one\n- two\n- three';
    expect(toBBCode(plain).length).toBeGreaterThan(plain.length);
  });
});

describe('path handling', () => {
  it('names the output beside the input', () => {
    expect(bbcodePathFor('docs/TRF Blurbs/TRF Blurb - 2026-08-27 v0.075.txt'))
      .toBe('docs/TRF Blurbs/TRF Blurb - 2026-08-27 v0.075 BBCODE.txt');
  });

  // Tab-completion offers both the .txt and its " BBCODE.txt". Re-converting the latter
  // used to succeed silently: no `**` and no column-0 `- ` survive a first pass, so every
  // check reported success while writing a double-converted "<stem> BBCODE BBCODE.txt".
  it('recognises an already-converted file so the CLI can refuse it', () => {
    expect(looksAlreadyConverted('x BBCODE.txt')).toBe(true);
    expect(looksAlreadyConverted('x BBCODE.OUTDATED.txt')).toBe(true);
    expect(looksAlreadyConverted('x.txt')).toBe(false);
    expect(looksAlreadyConverted('TRF Blurb - 2026-08-27 v0.072-v0.075 (2 of 2).txt')).toBe(false);
  });
});

describe('importing this module', () => {
  // The whole point of the entry-point guard: this file could not exist before, because
  // importing the script ran its CLI and called process.exit(1) during module evaluation.
  it('does not run the CLI', () => {
    expect(typeof toBBCode).toBe('function');
    expect(typeof checkTags).toBe('function');
  });
});

/**
 * Splitting moved here from the drafting stage on 2026-08-30 (Eric): he edits ONE
 * consolidated .txt however long it runs, and the cut happens during conversion, from his
 * edited text. So the script stopped refusing an over-length draft and started cutting it,
 * and these are the properties that make a cut safe to paste.
 */
describe('splitBBCode', () => {
  const para = (n, ch = 'x') => ch.repeat(n);

  it('leaves a post that fits as a single part, untouched', () => {
    const bb = 'short enough';
    expect(splitBBCode(bb)).toEqual([bb]);
  });

  it('cuts at a blank line and joins the parts with the continuation lines', () => {
    const bb = [para(60), '', para(60), '', para(60)].join('\n');
    const parts = splitBBCode(bb, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].endsWith(CONTINUES)).toBe(true);
    expect(parts[parts.length - 1].startsWith(CONTINUED)).toBe(true);
    expect(parts[parts.length - 1].endsWith(CONTINUES)).toBe(false);
  });

  it('every part fits the limit, joining lines included', () => {
    const bb = Array.from({ length: 40 }, (_, i) => para(300, String.fromCharCode(97 + (i % 26)))).join('\n\n');
    for (const part of splitBBCode(bb)) {
      expect(part.length).toBeLessThanOrEqual(TRF_POST_LIMIT);
    }
  });

  it('rejoins to the original text word for word', () => {
    const bb = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${para(200)}`).join('\n\n');
    const parts = splitBBCode(bb, 700);
    const rejoined = parts
      .map((p) => p.replace(CONTINUED + '\n\n', '').replace('\n\n' + CONTINUES, ''))
      .join('\n\n');
    expect(rejoined.replace(/\s+/g, ' ').trim()).toBe(bb.replace(/\s+/g, ' ').trim());
  });

  it('never cuts inside a [LIST] — a part that opens one must close it', () => {
    const bb = [
      para(400),
      '',
      '[LIST]',
      ...Array.from({ length: 12 }, (_, i) => `[*]item ${i} ${para(120)}`),
      '[/LIST]',
      '',
      para(400),
    ].join('\n');
    for (const part of splitBBCode(bb, 2600)) {
      const opens = (part.match(/\[LIST\]/g) ?? []).length;
      const closes = (part.match(/\[\/LIST\]/g) ?? []).length;
      expect(opens, part.slice(0, 60)).toBe(closes);
      expect(checkTags(part)).toEqual([]);
    }
  });

  it('refuses rather than cutting badly when one run is longer than a post', () => {
    expect(() => splitBBCode(para(300), 100)).toThrow(/unbreakable run/);
  });

  it('names the parts so they paste in order', () => {
    expect(bbcodePartPathFor('a/b - Blurb.txt', 2, 3)).toBe('a/b - Blurb BBCODE (2 of 3).txt');
    expect(bbcodePathFor('a/b - Blurb.txt')).toBe('a/b - Blurb BBCODE.txt');
  });
});
