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
  TRF_POST_LIMIT,
  bbcodePathFor,
  checkTags,
  looksAlreadyConverted,
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
