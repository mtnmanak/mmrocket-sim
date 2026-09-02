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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOLINK_GROWTH,
  CONTINUED,
  CONTINUES,
  MENTION_GROWTH,
  TRF_POST_LIMIT,
  bbcodePartPathFor,
  bbcodePathFor,
  checkTags,
  existingPartPaths,
  isHeadingLine,
  looksAlreadyConverted,
  partsOverLimit,
  postLength,
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
    // The limit moved 100 → 150 when the joining lines started being budgeted per position:
    // head + foot is 62 characters, so at 100 a middle part had only 38 left for content and
    // a 60-character paragraph genuinely did not fit. The fixture was wrong, not the reserve.
    const bb = [para(60), '', para(60), '', para(60)].join('\n');
    const parts = splitBBCode(bb, 150);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].endsWith(CONTINUES)).toBe(true);
    expect(parts[parts.length - 1].startsWith(CONTINUED)).toBe(true);
    expect(parts[parts.length - 1].endsWith(CONTINUES)).toBe(false);
  });

  it('every part fits the limit, joining lines included', () => {
    const bb = Array.from({ length: 40 }, (_, i) => para(300, String.fromCharCode(97 + (i % 26)))).join('\n\n');
    const parts = splitBBCode(bb);
    expect(parts.length, 'a fixture that does not split tests nothing').toBeGreaterThan(1);
    for (const part of parts) {
      // postLength, not String.length: the measurement is the thing under test.
      expect(postLength(part)).toBeLessThanOrEqual(TRF_POST_LIMIT);
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

/**
 * What TRF really counts.
 *
 * This block used to assert the OPPOSITE of what it now asserts. It pinned a CRLF model —
 * "a browser submits a textarea as CRLF, so every newline costs two" — which is refuted by
 * XenForo's own source: `XF\InputFilterer::cleanInternal()`'s `str` case runs
 * `str_replace("\r\n", "\n", …)` and `cleanString()` then strips `"\x0D"` outright. Its
 * comment reads *"carriage returns, because jQuery does so in .val()"*.
 *
 * The cost of getting an oracle wrong is on display here: the mechanism was asserted,
 * mutation-tested and documented in three places, and all of that only made a false model
 * harder to dislodge. What the old model was accidentally doing was reserving about one
 * character per line, and that slack was the only thing keeping mention-heavy posts under
 * the limit — the growth that really matters was never modelled at all.
 */
describe('postLength — what TRF really counts', () => {
  it('counts a newline ONCE, because XenForo normalises CRLF away before measuring', () => {
    expect(postLength('a\nb')).toBe(3);
    expect(postLength('a\nb\nc')).toBe(5);
    expect(postLength('no newlines')).toBe(11);
  });

  it('counts CODE POINTS, the way utf8_strlen does', () => {
    // An astral character is one character to PHP and two to JS `.length`. The blurbs use
    // ⬇ and 📈 when naming on-screen buttons.
    expect('📈'.length, 'the premise: JS disagrees with PHP here').toBe(2);
    expect(postLength('📈')).toBe(1);
  });

  it('adds the growth of an @mention, which XenForo applies BEFORE it measures', () => {
    // Preparer::prepare() calls processMessage() and hands the REWRITTEN string to
    // checkValidity(), so `@Buckeye` is counted as `[USER=<id>]@Buckeye[/USER]`. Blurbs
    // credit every reporter inline by handle, so a long one carries a dozen of these.
    const line = 'found by @Buckeye';
    expect(postLength(line)).toBe(line.length + MENTION_GROWTH);
    expect(postLength('found by Buckeye')).toBe('found by Buckeye'.length);
  });

  it('adds the growth of a bare URL, but not of one already in an [URL] tag', () => {
    const bare = 'see https://example.com for the thread';
    expect(postLength(bare)).toBe(bare.length + AUTOLINK_GROWTH);
    const tagged = toBBCode('https://example.com');
    expect(postLength(tagged)).toBe(tagged.length);
  });

  it('splits a mention-heavy post whose raw length fits', () => {
    // The case the old CRLF slack was masking, and the reason this is not merely tidier:
    // eleven credits are ~220 characters TRF counts that the author never typed.
    const credits = Array.from({ length: 11 }, (_, i) => `thanks @tester${i}`).join(' ');
    const body = `${'w'.repeat(9700)}\n\n${credits}`;
    expect([...body].length, 'the premise: it fits as raw text').toBeLessThan(TRF_POST_LIMIT);
    expect(postLength(body), 'and not as TRF counts it').toBeGreaterThan(TRF_POST_LIMIT);

    const parts = splitBBCode(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(postLength(p)).toBeLessThanOrEqual(TRF_POST_LIMIT);
  });
});

describe('splitting — the properties that make a cut postable', () => {
  it('a MIDDLE part carries BOTH joining lines and still fits', () => {
    // The case a 2-part fixture cannot see. The old code reserved room for ONE joining
    // line; every middle part of a 3+-part split receives the head AND the foot, and this
    // body produced middle parts of 10,006 characters while the docstring claimed that
    // could not happen.
    const body = Array.from({ length: 700 }, () => 'x'.repeat(40)).join('\n\n');
    const parts = splitBBCode(body);
    expect(parts.length, 'need a middle part for this to test anything').toBeGreaterThan(2);

    const middle = parts.slice(1, -1);
    for (const p of middle) {
      expect(p.startsWith(CONTINUED), 'a middle part carries the head').toBe(true);
      expect(p.endsWith(CONTINUES), 'a middle part carries the foot').toBe(true);
    }
    for (const p of parts) expect(postLength(p)).toBeLessThanOrEqual(TRF_POST_LIMIT);
  });

  it('does not split a document that fits in ONE post', () => {
    // A single post carries no joining lines, so it is measured against the whole limit.
    // Reserving the join here split a blurb that fitted, and refused one that had no
    // blank line to cut at.
    const body = `${'z'.repeat(5000)}\n\n${'y'.repeat(4976)}`;
    expect(postLength(body)).toBeLessThanOrEqual(TRF_POST_LIMIT);
    expect(postLength(body), 'the premise: inside the band the old reserve stole')
      .toBeGreaterThan(TRF_POST_LIMIT - 60);
    expect(splitBBCode(body)).toEqual([body]);
    expect(() => splitBBCode('z'.repeat(9980))).not.toThrow();
  });

  it('never strands a heading at the foot of a post', () => {
    // Sized so the LAST cut that fits is the one immediately after the heading — which is
    // what the greedy fill did to the real v0.088–v0.091 blurb, leaving "OPENING A DESIGN
    // FILE NOW ASKS BEFORE THROWING YOUR WORK AWAY" alone at the end of post 1.
    const heading = 'THE PARTS DATABASE CLEANUP';
    const body = ['a'.repeat(9000), '', heading, '', 'b'.repeat(2000), '', 'c'.repeat(2000)]
      .join('\n');
    const parts = splitBBCode(body);
    expect(parts.length).toBeGreaterThan(1);

    for (const p of parts) {
      const solid = p.replace(CONTINUES, '').trimEnd().split('\n').filter((l) => l.trim());
      expect(isHeadingLine(solid[solid.length - 1]), 'a post ends on a stranded heading')
        .toBe(false);
    }
    // The positive half: the heading leads the NEXT post, with its body under it.
    const after = parts[1].split('\n').filter((l) => l.trim() && l !== CONTINUED);
    expect(after[0]).toBe(heading);
  });

  /**
   * Strip the joining lines to get at what the part actually posts.
   *
   * The obvious assertion — that the remainder is non-empty — is too weak, and mutation
   * testing is what showed it: deleting the blank-line skip left a part whose body began
   * with a blank line, which `.trim().length > 0` cannot see. A post must not open or close
   * on blank lines, so pin THAT.
   */
  const core = (p) => p.replace(`${CONTINUED}\n\n`, '').replace(`\n\n${CONTINUES}`, '');

  it('a trailing newline does not produce an empty or blank-led post', () => {
    // Every editor saves a trailing newline and toBBCode preserves it. It used to register
    // as a cut, so the last "post" was nothing but "Continued from the post above."
    const body = `${Array.from({ length: 400 }, () => 'q'.repeat(40)).join('\n\n')}\n`;
    const parts = splitBBCode(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(core(p).length, 'a post with no content in it').toBeGreaterThan(0);
      expect(core(p), 'a post opening or closing on a blank line').toBe(core(p).trim());
    }
  });

  it('steps over blank lines rather than posting them', () => {
    // Mutation testing rewrote this test twice, and both rewrites are the lesson.
    //
    // The first fixture used a run of capital A's, which `isHeadingLine` correctly reads as
    // a HEADING — so the cut moved for a reason that had nothing to do with blank lines.
    // The second still could not fail: `trimEnd()` makes every blank in a run measure the
    // same, so the greedy cut always clears a mid-document run on its own.
    //
    // Where the skip is genuinely load-bearing is LEADING blank lines, which a .txt that
    // opens on an empty line really has. Without it the first post opens on blank lines.
    const body = `\n\n${'a'.repeat(9960)}\n\n${'b'.repeat(4000)}\n\n${'c'.repeat(4000)}`;
    const parts = splitBBCode(body);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(core(p).length).toBeGreaterThan(0);
      expect(core(p), 'a post opening or closing on a blank line').toBe(core(p).trim());
    }
    expect(core(parts[0])).toBe('a'.repeat(9960));

    const small = splitBBCode(['A'.repeat(50), '', '', '', 'P'.repeat(50), '', 'bbb'].join('\n'), 100);
    for (const p of small) {
      expect(core(p).length).toBeGreaterThan(0);
      expect(core(p)).toBe(core(p).trim());
    }
  });

  it('treats a lone carriage return as a line break', () => {
    // `\r\n` alone left a bare `\r` in the output, where split('\n') never breaks — the
    // paragraphs collapsed into one run the splitter then called unbreakable.
    expect(toBBCode('a\rb')).toBe('a\nb');
    expect(toBBCode('a\r\nb')).toBe('a\nb');
  });
});

describe('isHeadingLine', () => {
  it('recognises the two shapes the blurbs use', () => {
    expect(isHeadingLine('PARTS DATABASE')).toBe(true);
    expect(isHeadingLine('[B]Fixes (v0.075)[/B]')).toBe(true);
  });

  it('does not mistake BBCode markup for a heading', () => {
    // Both are uppercase and full of letters; without the tag bail-out every list in the
    // document would read as a heading and the splitter would refuse most of its cuts.
    expect(isHeadingLine('[/LIST]')).toBe(false);
    expect(isHeadingLine('[LIST]')).toBe(false);
    expect(isHeadingLine('[*]AN ITEM IN CAPS')).toBe(false);
  });

  it('does not mistake prose or a blank line for a heading', () => {
    expect(isHeadingLine('The app measured CP in one plane.')).toBe(false);
    expect(isHeadingLine('')).toBe(false);
    expect(isHeadingLine('   ')).toBe(false);
    expect(isHeadingLine('0.091')).toBe(false);
  });
});

describe('the guards around writing', () => {
  it('names any part TRF would refuse', () => {
    expect(partsOverLimit(['short', 'also short'])).toEqual([]);
    expect(partsOverLimit(['x'.repeat(TRF_POST_LIMIT + 1), 'ok']))
      .toEqual([{ n: 1, len: TRF_POST_LIMIT + 1 }]);
  });

  it('recognises a generated PART file, not just a single BBCODE.txt', () => {
    // Splitting is now the normal outcome, so tab-completion on the stem offers the part
    // files first — and re-converting one succeeded silently, writing
    // "<stem> BBCODE (1 of 2) BBCODE (1 of 2).txt" with every check green.
    expect(looksAlreadyConverted('x BBCODE (1 of 2).txt')).toBe(true);
    expect(looksAlreadyConverted('x BBCODE (10 of 12).OUTDATED.txt')).toBe(true);
    expect(looksAlreadyConverted('x BBCODE.txt')).toBe(true);
    expect(looksAlreadyConverted('x.txt')).toBe(false);
    // The pre-2026-08-30 hand-split naming has no BBCODE in it and is still a source file.
    expect(looksAlreadyConverted('TRF Blurb - 2026-08-27 v0.075 (2 of 2).txt')).toBe(false);
  });

  it('finds the part files really on disk, whatever the part count', () => {
    // The sweep used to ask for "(1 of 9)" … "(9 of 9)" — names no run has ever written —
    // so a real "(n of 4)" set survived every later run, sitting beside the new output
    // looking perfectly postable.
    const dir = mkdtempSync(join(tmpdir(), 'bbcode-sweep-'));
    try {
      const src = join(dir, 'TRF Blurb - 2026-09-01 v0.091.txt');
      writeFileSync(src, 'draft', 'utf8');
      for (const n of [1, 2, 3, 4]) {
        writeFileSync(join(dir, `TRF Blurb - 2026-09-01 v0.091 BBCODE (${n} of 4).txt`), 'x', 'utf8');
      }
      writeFileSync(join(dir, 'A Different Blurb BBCODE (1 of 2).txt'), 'x', 'utf8');

      const found = existingPartPaths(src).map((p) => basename(p)).sort();
      expect(found).toHaveLength(4);
      expect(found.every((f) => f.includes('of 4'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
