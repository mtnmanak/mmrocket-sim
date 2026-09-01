// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '../App.tsx'), 'utf8');

/**
 * WHICH actions are allowed to say "this design is saved".
 *
 * `markSaved` clears the unsaved-changes guard, so every call site is a place
 * the Open prompt can be silenced. Three are correct, and the rest of the
 * app's "save" and "share" actions must NOT be in the list:
 *
 *  - a .ork save        — the only format that round-trips everything
 *  - an import          — the design now IS the file on disk
 *  - New                — an empty design is not work anybody would mind losing
 *
 * Deliberately excluded, and this is the part worth pinning:
 *  - .rkt / .CDX1 exports are LOSSY. RockSim drops launch conditions, flight
 *    configurations and the measured mass/CG; RASAero keeps launch but drops
 *    configurations, measured and flight data. Marking either as saved would
 *    let the next Open discard precisely the parts the file does not hold.
 *  - Copying a share link puts nothing on disk, and on the clipboard fallback
 *    the URL goes into a window.prompt() where the app cannot tell whether it
 *    was ever copied.
 *
 * These are absences, and an absence is invisible to every other test in the
 * suite: adding `markSaved` to onSaveRkt would break nothing and would quietly
 * re-open the data-loss hole. Hence a source-text guard.
 */
describe('only a full-fidelity save clears the unsaved-changes mark', () => {
  it('marks from exactly three places', () => {
    const calls = app().match(/\bmarkSaved\(/g) ?? [];
    // onSaveOrk, applyImported, startNewDesign — plus its own definition,
    // which is `const markSaved = (` and does not match this pattern.
    expect(calls.length, 'a new markSaved call site appeared — is it full fidelity?')
      .toBe(3);
  });

  it('the .ork save marks, and only after a real write', () => {
    const src = app();
    expect(src).toContain("if (out.kind !== 'cancelled') markSaved(mark);");
    // The mark is taken before the await, or edits made while the Save-As
    // picker sits open get blessed as saved.
    expect(/const mark = designFingerprint\(snapshotNow\(\)\);[\s\S]{0,400}?await download\(exportOrk/
      .test(src)).toBe(true);
  });

  it('the lossy exports do NOT mark', () => {
    const src = app();
    for (const fn of ['onSaveRkt', 'onSaveCdx1']) {
      const start = src.indexOf(`const ${fn} = async`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      // Body runs to the next top-level `const on...` declaration.
      const rest = src.slice(start + 10);
      const end = rest.search(/\n  const on[A-Z]/);
      const body = rest.slice(0, end === -1 ? 4000 : end);
      expect(body.includes('markSaved'), `${fn} must not clear the unsaved-changes mark`)
        .toBe(false);
    }
  });

  it('copying a share link does NOT mark', () => {
    const src = app();
    const i = src.indexOf('await navigator.clipboard.writeText(url)');
    expect(i).toBeGreaterThan(-1);
    // The whole share-link builder, from the payload to the copy.
    const start = src.lastIndexOf('const frag = await encodeShareFragment', i);
    expect(src.slice(start, i + 400).includes('markSaved'),
      'copying a share link must not clear the unsaved-changes mark').toBe(false);
  });
});
