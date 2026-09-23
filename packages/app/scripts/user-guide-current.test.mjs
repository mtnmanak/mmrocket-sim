/**
 * The committed packages/app/src/data/userGuide.ts must be exactly what
 * scripts/build-user-guide.mjs compiles from the markdown and the shipped motor
 * data TODAY (audit 2026-09-22, Tests row 526).
 *
 * WHY THE COMMITTED COPY MATTERS when every deploy recompiles it: the deploy runs
 * `npm test` BEFORE `npm run build`, so GuideDialog.test.tsx and anything else
 * that imports GUIDE_SECTIONS test whatever was last committed; and the guide's
 * {{TOKENS}} (motor counts, the catalogue date, the curve shares) are compiled
 * from motors.json and motorCurves.json, which the weekly refresh rewrites. A
 * refresh that committed only the JSON left the repo's guide quoting the
 * previous catalogue until some unrelated build happened to rewrite it.
 *
 * NOT FLAKY BY CONSTRUCTION: the compile is a pure function of three committed
 * files (no clock, no network, no locale beyond the pinned 'en-US'), and the
 * comparison ignores only a Windows checkout's CRLF, which git's autocrlf adds
 * and removes and the generator never writes.
 *
 * The fix when this fails is always the same, and the message says it:
 *   node scripts/build-user-guide.mjs
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA, GuideError, OUT, SRC, compileGuide } from '../../../scripts/build-user-guide.mjs';

const committed = () => readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');

describe('the committed userGuide.ts is current', () => {
  it('matches a fresh compile of user-guide.md and the shipped motor data, byte for byte', () => {
    const { ts } = compileGuide();
    // Not toBe(): a 50 kB string diff is unreadable, and the remedy is one command.
    if (ts !== committed()) {
      expect.fail('packages/app/src/data/userGuide.ts is stale: it is not what user-guide.md and the '
        + 'shipped motors.json / motorCurves.json compile to. Run `node scripts/build-user-guide.mjs` '
        + 'and commit the result.');
    }
    expect(ts).toBe(committed());
  });

  it('is a pure function of its inputs: two compiles agree', () => {
    expect(compileGuide().ts).toBe(compileGuide().ts);
  });

  it('is recompiled by `npm run motors:refresh`, after both data files it quotes', () => {
    // Every "run `npm run motors:refresh`" remedy in the repo (check-upstream,
    // motor-db-age.test.mjs, motor-diff-summary) is a hand-run refresh. If the
    // script wrote only the JSON, committing its output as told would fail the
    // first test in this file on the deploy. The weekly workflow runs the same
    // script, so this is the one place the order lives.
    const pkg = JSON.parse(readFileSync(join(DATA, '..', '..', '..', '..', 'package.json'), 'utf8'));
    const steps = pkg.scripts['motors:refresh'].split('&&').map((s) => s.trim());
    expect(steps).toEqual([
      'node packages/app/scripts/fetch-motor-db.mjs',
      'node packages/app/scripts/fetch-motor-curves.mjs',
      'node scripts/build-user-guide.mjs',
    ]);
  });
});

describe('the check can see what it exists to see', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-current-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a catalogue refresh without a recompile reads as stale', () => {
    // The refresh stamps a new `generated` date into motors.json; the guide
    // prints it as {{MOTOR_DB_DATE}}. Nothing else changes, and that alone
    // must be enough to make the committed file stale.
    copyFileSync(join(DATA, 'motorCurves.json'), join(dir, 'motorCurves.json'));
    const motors = JSON.parse(readFileSync(join(DATA, 'motors.json'), 'utf8'));
    const refreshed = motors.generated === '2099-01-04' ? '2099-01-05' : '2099-01-04';
    writeFileSync(join(dir, 'motors.json'), JSON.stringify({ ...motors, generated: refreshed }));
    const { ts } = compileGuide({ dataDir: dir });
    expect(ts).not.toBe(committed());
    expect(ts).toContain(refreshed === '2099-01-04' ? '4 January 2099' : '5 January 2099');
  });

  it('an edited markdown without a recompile reads as stale', () => {
    const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const at = md.indexOf('\n## ', md.indexOf('<a id='));
    const edited = `${md.slice(0, at + 1)}## ${md.slice(at + 4).replace(/\n/, ' (edited)\n')}`;
    expect(compileGuide({ markdown: edited }).ts).not.toBe(committed());
  });

  it('refuses unsupported markdown by THROWING, so importing it never exits the test runner', () => {
    const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
    const bad = md.replace(/\n## /, '\n<div>raw html</div>\n\n## ');
    expect(() => compileGuide({ markdown: bad })).toThrow(GuideError);
    expect(() => compileGuide({ markdown: bad })).toThrow(/^build-user-guide: .*\n {2}at packages\/app\/user-guide\.md:\d+$/);
  });
});
