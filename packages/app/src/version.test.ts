import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANGELOG } from './changelog.js';
import { APP_VERSION } from './version.js';
import versionJson from '../../../version.json';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The release tooling reads these two files as TEXT, not by importing them,
 * so their shape is a contract (audit 2026-09-22, row 510, which moved the
 * changelog out of version.ts). The deploy workflow's version-pairing step and
 * scripts/package-dist.mjs match APP_VERSION with the first pattern. The
 * release helper bumps APP_VERSION by matching the second, and writes the new
 * entry directly after the array's opening line, found byte for byte. That
 * helper is kept outside this repo, so this is the only place here that says
 * what it depends on. A reformat that still type-checks would break them.
 */
describe('version.ts and changelog.ts keep the shape the release tooling reads', () => {
  const versionTs = readFileSync(join(here, 'version.ts'), 'utf8');
  const changelogTs = readFileSync(join(here, 'changelog.ts'), 'utf8');

  it('version.ts states APP_VERSION in the exact form both patterns match', () => {
    expect(versionTs.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1]).toBe(APP_VERSION);
    expect(versionTs.match(/export const APP_VERSION = '([0-9.]+)';/)?.[1]).toBe(APP_VERSION);
  });

  it('version.ts holds APP_VERSION and nothing else, so importing it stays cheap', () => {
    expect(versionTs.match(/^export /gm)).toHaveLength(1);
    expect(versionTs).not.toMatch(/^import /m);
  });

  it("changelog.ts opens the array on the release helper's anchor line, once", () => {
    const anchor = '\nexport const CHANGELOG: ChangelogEntry[] = [\n';
    expect(changelogTs.split(anchor)).toHaveLength(2);
  });
});

/**
 * The changelog is the user-facing record of what a refresh gives them, and it
 * has now missed its own release TWICE: v0.091's entry described one change out
 * of ten commits, and v0.095 + v0.096 shipped with no entry at all (found
 * 2026-09-03 — the in-app What's New stopped at v0.094 while the app read
 * 0.096, and the two silent releases included the parachute-Cd fix that moves
 * users' descent rates). The deploy gate runs `npm test`, so this is the guard.
 */
describe('APP_VERSION / CHANGELOG / version.json pairing', () => {
  it('the newest changelog entry IS the shipped version', () => {
    expect(CHANGELOG[0]?.version).toBe(APP_VERSION);
  });

  it('version.json agrees (the deploy workflow checks this too; here it fails in milliseconds)', () => {
    expect((versionJson as { version: string }).version).toBe(APP_VERSION);
  });

  it('entries run strictly downward with no duplicates', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const newer = Number(CHANGELOG[i - 1]!.version);
      const older = Number(CHANGELOG[i]!.version);
      expect(older, `${CHANGELOG[i]!.version} listed after ${CHANGELOG[i - 1]!.version}`).toBeLessThan(newer);
    }
  });

  /**
   * Strictly downward was not enough (audit 2026-09-22): release v0.137 RENAMED
   * the deployed v0.136 entry to 0.137 and added one item to it, so What's New
   * jumped from 0.137 to 0.135 and version.json's "everything in v0.136 still
   * applies" pointed at an entry that no longer existed. Every release since
   * 0.001 has its own entry, so consecutive entries differ by exactly one.
   */
  it('every release has its own entry: consecutive versions differ by exactly 0.001', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const newer = Math.round(Number(CHANGELOG[i - 1]!.version) * 1000);
      const older = Math.round(Number(CHANGELOG[i]!.version) * 1000);
      expect(newer - older, `${CHANGELOG[i - 1]!.version} is followed by ${CHANGELOG[i]!.version}`).toBe(1);
    }
  });

  it('every entry carries a date, a title and at least one item', () => {
    for (const e of CHANGELOG) {
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.length, e.version).toBeGreaterThan(0);
      expect(e.items.length, e.version).toBeGreaterThan(0);
    }
  });
});

/**
 * A PERCENTAGE BESIDE A CHANGE OF DIAMETER MUST SAY WHICH IT IS, AND BE RIGHT.
 *
 * Area goes as the square of diameter, and this project's notes have mixed the
 * two up more than once: v0.130 corrected "five and a half times the AREA" (it
 * was four), and v0.133's own correction of v0.132 then called two DIAMETER
 * increases "more area" - 01500-10 from .180 to .242 in is 34 % wider and 81 %
 * more area, and 01500-15 from .180 to .281 in is 56 % wider and 144 % more
 * area. So a note that writes "from <d1> to <d2> in" and puts a percentage after
 * it is held to its own two numbers here: "wider" is the diameter ratio, "more
 * area" the square of it, and a bare "percent more" names neither, which is how
 * the second of those two shipped.
 */
describe('changelog percentages beside a change of diameter', () => {
  const CHANGE = /from (\d*\.\d+) to (\d*\.\d+) in(?:ch(?:es)?)?,\s*(?:which is\s+)?(\d+) percent (wider|more area|more)(?: and (\d+) percent more area)?/g;
  const pct = (ratio: number) => Math.round(100 * (ratio - 1));

  function wrongClaims(text: string): string[] {
    const bad: string[] = [];
    for (const m of text.matchAll(CHANGE)) {
      const [said, d1, d2, first, noun, second] = m;
      const ratio = Number(d2) / Number(d1);
      if (noun === 'more') bad.push(`"${said}": percent more of what, the diameter or the area?`);
      if (noun === 'wider' && Number(first) !== pct(ratio)) bad.push(`"${said}": the diameter grows ${pct(ratio)} %`);
      const area = noun === 'more area' ? first : second;
      if (area !== undefined && Number(area) !== pct(ratio ** 2)) bad.push(`"${said}": the area grows ${pct(ratio ** 2)} %`);
    }
    return bad;
  }

  it('states each one as the diameter or the area, and gets it right', () => {
    const bad = CHANGELOG.flatMap((e) => e.items.flatMap((item) => wrongClaims(item).map((b) => `${e.version}: ${b}`)));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('is not vacuous: it reads the v0.133 throat correction, both parts of it', () => {
    const entry = CHANGELOG.find((e) => e.version === '0.133');
    expect(entry).toBeDefined();
    expect(entry!.items.flatMap((item) => [...item.matchAll(CHANGE)])).toHaveLength(2);
  });

  it('refuses the shapes that shipped: a diameter figure called area, and a percentage of nothing', () => {
    expect(wrongClaims('from .180 to .242 in, which is 34 percent more area')).toHaveLength(1);
    expect(wrongClaims('from .180 to .281 in, 56 percent more - and')).toHaveLength(1);
    expect(wrongClaims('from .180 to .242 in, which is 34 percent wider and 81 percent more area')).toEqual([]);
  });
});
