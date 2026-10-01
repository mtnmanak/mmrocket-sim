import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANGELOG, type ChangelogEntry } from './changelog.js';
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
 * EVERY AREA THE CHANGELOG WORKS OUT FROM TWO DIAMETERS SAYS WHICH IT IS, AND IS RIGHT.
 *
 * Area goes as the square of diameter, and this project's notes have mixed the
 * two up more than once: v0.130 corrected "five and a half times the AREA" (it
 * was four), and v0.133's own correction of v0.132 then called two DIAMETER
 * increases "more area" - 01500-10 from .180 to .242 in is 34 % wider and 81 %
 * more area, and 01500-15 from .180 to .281 in is 56 % wider and 144 % more
 * area - the second as a bare "56 percent more" that named neither.
 *
 * A pattern for "from <d1> to <d2> in, N percent ..." caught those two and none
 * of the others, each worded its own way ("2.0 inches is 21 percent more area
 * than 1.818", "two and a half times the area", "2.78× too much area"). So the
 * figures are LISTED here, each with the two diameters it compares, and checked:
 * the words must name what the figure is of (an area, or a diameter "wider"),
 * state the value listed, and be right for those two diameters at the precision
 * they are written to. And every percentage or "N times" in a changelog sentence
 * that names an area must be listed - as one of these figures, or in
 * NOT_FROM_DIAMETERS with what it is instead - so a new one fails the deploy
 * until its diameters are written down beside it and its arithmetic holds.
 */
describe('changelog areas worked out from two diameters', () => {
  type AreaClaim =
    /** "81 percent more area": the square of the diameters' ratio, as a percentage. */
    | { areaPercent: number }
    /** "34 percent wider": the ratio itself. */
    | { widerPercent: number }
    /** "2.4 times the area", rounded to `step` as written: "two and a half" is a step of 0.5. */
    | { areaTimes: number; step: number }
    /** "just over FOUR times": above it, and short of the next half. */
    | { areaTimesJustOver: number }
    /** "(2.60 against 0.64 square inches)": each diameter's own area, as written - `to`'s, then `from`'s. */
    | { squareInches: [string, string] };

  interface AreaFigure {
    version: string;
    /** Verbatim words of that entry, in one sentence: the figure and what it is of. */
    says: string;
    /** The diameter the figure is measured against, and the other one. */
    from: number;
    to: number;
    claim: AreaClaim;
    /** A wrong figure quoted in order to correct it: it must still be wrong. */
    quoted?: true;
  }

  const AREA_FIGURES: AreaFigure[] = [
    { version: '0.133', says: 'from .180 to .242 in, which is 34 percent wider', from: 0.18, to: 0.242, claim: { widerPercent: 34 } },
    { version: '0.133', says: '34 percent wider and 81 percent more area', from: 0.18, to: 0.242, claim: { areaPercent: 81 } },
    { version: '0.133', says: 'from .180 to .281 in, 56 percent wider', from: 0.18, to: 0.281, claim: { widerPercent: 56 } },
    { version: '0.133', says: '56 percent wider and 144 percent more area', from: 0.18, to: 0.281, claim: { areaPercent: 144 } },
    {
      version: '0.130', says: 'A 1.818 inch exit is five and a half times the AREA of the 0.900 inch one',
      from: 0.9, to: 1.818, claim: { areaTimes: 5.5, step: 0.5 }, quoted: true,
    },
    { version: '0.130', says: 'the AREA of the 0.900 inch one" - it is just over FOUR times', from: 0.9, to: 1.818, claim: { areaTimesJustOver: 4 } },
    { version: '0.130', says: 'FOUR times (2.60 against 0.64 square inches)', from: 0.9, to: 1.818, claim: { squareInches: ['2.60', '0.64'] } },
    { version: '0.129', says: '2.0 inches against the standard 1.818 is 21 percent more AREA', from: 1.818, to: 2.0, claim: { areaPercent: 21 } },
    {
      version: '0.129', says: 'the area changes for that particular motor - 21 percent on the 1.818 inch band',
      from: 1.818, to: 2.0, claim: { areaPercent: 21 },
    },
    {
      version: '0.129', says: 'the area changes for that particular motor - 21 percent on the 1.818 inch band, 78 percent on the 1.500 inch one',
      from: 1.5, to: 2.0, claim: { areaPercent: 78 },
    },
    {
      version: '0.128', says: 'a 1.818 inch exit is just over FOUR times the AREA of the 0.900 inch 38 mm one',
      from: 0.9, to: 1.818, claim: { areaTimesJustOver: 4 },
    },
    {
      version: '0.128', says: 'the AREA of the 0.900 inch 38 mm one (2.60 against 0.64 square inches)',
      from: 0.9, to: 1.818, claim: { squareInches: ['2.60', '0.64'] },
    },
    { version: '0.128', says: '2.0 inches is 21 percent more area than 1.818', from: 1.818, to: 2.0, claim: { areaPercent: 21 } },
    // A tester's RASAero file's N1000W exit, against AeroTech's drawing for the N1000W-P.
    {
      version: '0.122', says: 'a 2.737 inch exit where AeroTech\'s drawing says 1.750, which is 2.4 times the area',
      from: 1.75, to: 2.737, claim: { areaTimes: 2.4, step: 0.1 },
    },
    // The K1100T-L's two published exits (nozzles.json): 1.250 in, and part 01700-12's 1.0458 in.
    { version: '0.122', says: 'the K1100T\'s two options differ by 43 percent in area', from: 1.0458, to: 1.25, claim: { areaPercent: 43 } },
    { version: '0.120', says: 'says 1.750, which is two and a half times the area', from: 1.75, to: 2.737, claim: { areaTimes: 2.5, step: 0.5 } },
    // A 40 mm tube fin taken as the reference diameter of a 24 mm airframe.
    { version: '0.070', says: '40 mm tube fins that was 2.78× too much area', from: 24, to: 40, claim: { areaTimes: 2.78, step: 0.01 } },
  ];

  /** Percentages and "times" in a sentence that names an area which compare no two diameters. */
  const NOT_FROM_DIAMETERS: { version: string; says: string; why: string }[] = [
    { version: '0.136', says: 'DRAWN 19 PERCENT SHORT ON AREA', why: 'a half ellipse drawn as a sine hump: two outlines on one span' },
    { version: '0.129', says: 'a term worth 5.5 percent of apogee', why: 'a share of apogee, measured on a tester file' },
    { version: '0.122', says: 'over-predicted its flight by nearly 60 percent', why: 'a prediction against a flight' },
    { version: '0.120', says: 'over-predicted its flight by nearly 60 percent', why: 'a prediction against a flight' },
    { version: '0.092', says: 'the drawing area went from 460 px to 335 px, a 27 % loss', why: 'a height on screen' },
    {
      version: '0.090',
      says: 'which is +5 % of the shroud’s area on the default 25x20 mm shroud on a 54 mm body, +11.9 % for a GoPro-class 45x30, and +31.6 % for a low wide 24x8 shroud',
      why: 'one shroud’s frontal area measured two ways',
    },
    { version: '0.089', says: '+0.6 to +3.1 % CD, -0.15 to -1.1 % apogee', why: 'changes in drag coefficient and in apogee' },
    { version: '0.044', says: 'enclosed about 19% less area', why: 'a sine curve drawn for a true ellipse' },
  ];

  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  /** A percentage, or "N times" / "N×" with N a numeral or a number word ("five and a half"). */
  const FIGURE = new RegExp(String.raw`\d+(?:\.\d+)?\s*(?:percent|%)|\b(?:\d+(?:\.\d+)?|(?:${WORDS.join('|')})(?: and a half)?)\s+times\b|\d+(?:\.\d+)?×`, 'gi');
  const sentences = (item: string) => item.split(/(?<=[.!?])\s+/);
  const standalone = (n: number) => new RegExp(String.raw`(?<![\d.])${String(n).replace('.', '\\.')}(?![\d.])`);
  /** A whole or a half in words, as the notes write them ("two and a half"); nothing for any other value. */
  const inWords = (v: number) => (Number.isInteger(v) ? WORDS[v]
    : Number.isInteger(v * 2) ? `${WORDS[Math.floor(v)]} and a half` : undefined);
  const pct = (x: number) => Math.round(100 * (x - 1));

  /** What is wrong with a listed figure, or null: its words, then its arithmetic. */
  function problem(f: AreaFigure): string | null {
    const r = f.to / f.from;
    const c = f.claim;
    const at = `${f.version} "${f.says}"`;
    if ('widerPercent' in c) {
      if (!/\bwider\b|\bdiameter/i.test(f.says)) return `${at}: says neither "wider" nor "diameter"`;
      if (!standalone(c.widerPercent).test(f.says)) return `${at}: does not state ${c.widerPercent}`;
      return pct(r) === c.widerPercent ? null : `${at}: the diameter grows ${pct(r)} % (and the area ${pct(r ** 2)} %)`;
    }
    if ('squareInches' in c) {
      const area = (d: number, as: string) => (Math.PI / 4 * d ** 2).toFixed(as.split('.')[1]?.length ?? 0);
      if (!/square inch/i.test(f.says) || !c.squareInches.every((s) => f.says.includes(s))) return `${at}: does not state those square inches`;
      const got = [area(f.to, c.squareInches[0]), area(f.from, c.squareInches[1])];
      return got.join() === c.squareInches.join() ? null : `${at}: the areas are ${got.join(' and ')} square inches`;
    }
    if (!/\bareas?\b/i.test(f.says)) return `${at}: does not say it is an area`;
    if ('areaPercent' in c) {
      if (!standalone(c.areaPercent).test(f.says)) return `${at}: does not state ${c.areaPercent}`;
      return pct(r ** 2) === c.areaPercent ? null : `${at}: the area grows ${pct(r ** 2)} % (the diameter ${pct(r)} %)`;
    }
    if ('areaTimesJustOver' in c) {
      const n = c.areaTimesJustOver;
      if (!new RegExp(String.raw`just over (?:${n}|${WORDS[n]}) times`, 'i').test(f.says)) return `${at}: does not say just over ${n} times`;
      return r ** 2 > n && r ** 2 < n + 0.5 ? null : `${at}: the area is ${(r ** 2).toFixed(3)} times`;
    }
    const words = inWords(c.areaTimes);
    const said = [`${c.areaTimes} times`, `${c.areaTimes}×`, ...(words ? [`${words} times`] : [])];
    if (!said.some((s) => f.says.toLowerCase().includes(s.toLowerCase()))) return `${at}: does not state ${c.areaTimes} times`;
    const rounded = Math.round(r ** 2 / c.step) * c.step;
    return Math.abs(rounded - c.areaTimes) < 1e-9 ? null
      : `${at}: the area is ${(r ** 2).toFixed(3)} times, ${Number(rounded.toFixed(4))} to the step written`;
  }

  /** Each percentage or "times" in a sentence that names an area, unless listed above. */
  function unlisted(changelog: ChangelogEntry[]): string[] {
    const out: string[] = [];
    for (const e of changelog) {
      const listed = [...AREA_FIGURES, ...NOT_FROM_DIAMETERS].filter((f) => f.version === e.version);
      e.items.forEach((item, i) => {
        for (const s of sentences(item)) {
          if (!/\bareas?\b/i.test(s)) continue;
          const spans: [number, number][] = listed.flatMap((f) => {
            const at = s.indexOf(f.says);
            return at < 0 ? [] : [[at, at + f.says.length] as [number, number]];
          });
          for (const m of s.matchAll(FIGURE)) {
            const a = m.index ?? 0;
            const b = a + m[0].length;
            if (!spans.some(([x, y]) => x <= a && b <= y)) out.push(`${e.version} item ${i + 1}: "${m[0]}" in "${s}"`);
          }
        }
      });
    }
    return out;
  }

  it('lists every percentage or "times" in a sentence that names an area', () => {
    const missing = unlisted(CHANGELOG);
    expect(missing, `list each in AREA_FIGURES with the two diameters it compares, or in NOT_FROM_DIAMETERS with what it is:\n${missing.join('\n')}`)
      .toEqual([]);
  });

  it('lists only words the changelog states, each within one sentence of its own entry', () => {
    for (const f of [...AREA_FIGURES, ...NOT_FROM_DIAMETERS]) {
      const entry = CHANGELOG.find((e) => e.version === f.version);
      expect(entry?.items.some((item) => sentences(item).some((s) => s.includes(f.says))), `${f.version}: "${f.says}"`).toBe(true);
    }
  });

  it('states each figure as the area or the diameter, and gets it right; a quoted error is still wrong', () => {
    const bad = AREA_FIGURES.filter((f) => !f.quoted).map(problem).filter((p) => p !== null);
    expect(bad, bad.join('\n')).toEqual([]);
    for (const f of AREA_FIGURES.filter((x) => x.quoted)) expect(problem(f), `${f.version} "${f.says}" is listed as a quoted error`).not.toBeNull();
  });

  it('is not vacuous: it holds both v0.133 throat figures, as a diameter and as an area', () => {
    const v133 = AREA_FIGURES.filter((f) => f.version === '0.133');
    expect(v133.map((f) => Object.keys(f.claim)[0]).sort()).toEqual(['areaPercent', 'areaPercent', 'widerPercent', 'widerPercent']);
  });

  it('sees an area figure in any wording: the v0.128 error as it was first written', () => {
    const v128 = { version: '9.999', date: '2099-01-01', title: 't', items: ['The 76 mm number is the big one because a 1.818 inch exit is five and a half times the AREA of the 0.900 inch 38 mm one.'] };
    expect(unlisted([v128])).toEqual([`9.999 item 1: "five and a half times" in "${v128.items[0]}"`]);
    // And listed as what it claims, the arithmetic refuses it.
    expect(problem({ version: '9.999', says: v128.items[0]!, from: 0.9, to: 1.818, claim: { areaTimes: 5.5, step: 0.5 } }))
      .toMatch(/the area is 4\.080 times, 4 to the step written/);
  });

  it('refuses the shapes that shipped: a diameter figure called area, and a percentage of nothing', () => {
    const says = (s: string, to: number, claim: AreaClaim) => problem({ version: '0.133', says: s, from: 0.18, to, claim });
    expect(says('from .180 to .242 in, which is 34 percent more area', 0.242, { areaPercent: 34 })).toMatch(/the area grows 81 %/);
    // "56 percent more" names neither, so it can be listed as neither.
    expect(says('from .180 to .281 in, 56 percent more - and', 0.281, { widerPercent: 56 })).toMatch(/neither "wider" nor "diameter"/);
    expect(says('from .180 to .281 in, 56 percent more - and', 0.281, { areaPercent: 144 })).toMatch(/does not say it is an area/);
    expect(says('from .180 to .242 in, which is 34 percent wider and 81 percent more area', 0.242, { areaPercent: 81 })).toBeNull();
  });
});
