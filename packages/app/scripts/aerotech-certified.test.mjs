import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SHIPPED motor catalogue against AeroTech's certification letters: every
 * Tripoli Motor Testing letter in aerotech-certified.json that certifies a
 * catalogued motor must agree with that row on total impulse, peak thrust and
 * average thrust. Runs in `npm test`, so it gates the deploy and the weekly
 * catalogue refresh (.github/workflows/motors-refresh.yml gates its pull request
 * on `npm test`), the way preset-density.test.mjs gates presets.json.
 *
 * WHY (board Tier 1 row 8 (c), 2026-10-01). The picker's impulse-agreement gate
 * and the impulse note (thrustcurve.ts) compare a curve with the catalogue's
 * certified total, and both come from thrustcurve.org: where the two agree with
 * each other, nothing looks further. The F52C and the H13ST shipped 13.7 % under
 * their certification letters on all three figures, every bundled curve agreeing
 * with the low one, and nothing in the app could see it. The letters are a
 * reference from outside thrustcurve.org, read from the PDFs by
 * extract-aerotech-certified.py. That needs the local-only docs/RCS Schematics,
 * so the JSON is a committed artifact, the way nozzles.json is.
 *
 * A ROW THAT FAILS HERE is fixed the way the F52C and H13ST are: a sourced entry
 * in motor-corrections.mjs, quoting the letter. While that waits on a ruling it
 * goes in KNOWN, with the figures it holds and why. Never by widening TOLERANCE.
 */
const here = dirname(fileURLToPath(import.meta.url));
const certified = JSON.parse(readFileSync(join(here, 'aerotech-certified.json'), 'utf8'));
const catalogue = JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'motors.json'), 'utf8')).motors;

/** The three figures the screen compares, by the catalogue's own field names. */
const FIGURES = ['totImpulseNs', 'maxThrustN', 'avgThrustN'];

/**
 * 0.5 %. Where the catalogue carries a motor these letters certify, its figure
 * IS the letter's, transcribed: as thrustcurve.org served it on 2026-10-01, 37
 * of the 41 matched rows agree on all three figures to 0.11 % or better (the
 * other four are the F52C, the H13ST and the two in KNOWN), and the widest of
 * the 37 are rounding (the B6W's 4.87 N·s for the letter's 4.865, 0.10 %; the
 * J1265T's 1,073.3 for 1,072.3, 0.09 %).
 * The ± each letter prints is another quantity: the spread between the motors
 * fired, 0.15 to 4.3 % of total impulse, 0.4 to 14.6 % of peak thrust and 0.3
 * to 9.2 % of average thrust. It says how far one motor may stray from the
 * certified figure, not how far a copy of that figure may, and as the tolerance
 * it would pass the J99N's 1.06 % over on impulse (its letter prints ± 1.12 %)
 * for a motor whose peak is 19 % over. So the band is five times the widest
 * rounding, and under the smallest real disagreement in these letters, the
 * N2700W-PS's 0.89 % on average thrust.
 */
const TOLERANCE = 0.005;

/** The makers these letters certify for: AeroTech, and its Q-Jet line, which thrustcurve.org files under Quest. */
const MAKERS = new Set(['AeroTech', 'Quest']);

/**
 * A designation reduced to what names the motor — class, average thrust,
 * propellant — so the letter's form and the catalogue's meet: "F52C" from
 * "F52C-5,8,12", "H13ST" from "H13ST-P", "K1800ST" from "K1800ST-P S", and
 * "D22W" from "{D22-4,7,10W}", where the Q-Jet and Enerjet letters put the
 * delays before the propellant. Null for any other shape ("HP-G75M", the earlier
 * G75M, out of production), which then matches nothing.
 */
function motorKey(designation) {
  const s = String(designation).toUpperCase().replace(/[{}\s]/g, '');
  const delaysFirst = /^([A-O]\d+)-[\d,]+([A-Z]+)/.exec(s);
  if (delaysFirst) return delaysFirst[1] + delaysFirst[2];
  return /^([A-O]\d+[A-Z]+)/.exec(s)?.[1] ?? null;
}

/** Letters whose designation as printed does not name the row they certify, by the letter's file. */
const READ_AS = {
  'RMS-75-10240/N2700W-PS.pdf': {
    designation: 'N2700W-PS',
    why: 'the letter types "M2700W-PS", but its own TMT nomenclature, "10,322 N2717", is an N motor, for the '
      + '75/10240 hardware, and RCS files and publishes the letter as the N2700W-PS',
  },
  '54mm High Power Single-Use/J1265ST-14A DMS.pdf': {
    designation: 'J1265T',
    why: 'thrustcurve.org lists the J1265ST-14A as "J1265T": Super Thunder, 54 mm, the letter\'s 507 g of propellant '
      + 'and 0.85 s burn',
  },
};

/** Letters for a motor the catalogue does not carry, by the letter's file. Held to it: the day one arrives, it is screened. */
const ABSENT = {
  '98mm High Power Single Use/O5280X-PS DMS.pdf': 'the O5280X-P (22,223 N·s, tested 7 December 2019) has no row, '
    + 'and thrustcurve.org has no motor of that designation; asked for its common name, O5280, it answers with its '
    + 'O5500X-PS, the "New Version" certified in January 2023, which is read and matched here',
  '98mm High Power Single Use/N1100W-PS DMS.pdf': 'the N1100W-P (14,418.21 N·s) has no row, and thrustcurve.org lists '
    + 'no AeroTech N1100; the catalogue\'s only N1100 is Cesaroni\'s 14005N1100-P, another maker\'s motor',
};

/**
 * Rows that disagree with their letter, held EXACTLY as they ship until a ruling
 * corrects or excuses them, by motorId. A row that changes in any way fails the
 * screen, so an entry cannot outlive what it describes: if thrustcurve.org fixes
 * one, retire its entry; if it moves to a third figure, look again.
 */
const KNOWN = {
  '5f4294d20002310000000309': {
    designation: 'J99N',
    holds: { totImpulseNs: 945.2, maxThrustN: 151.95, avgThrustN: 92.4 },
    why: 'the letter certifies the REDESIGNED J99N-P reload, tested 14 August 2020: 935.24 N·s, 127.24 N peak, 86.94 N '
      + 'average, 479.7 g of propellant, 10.773 s. The row\'s 556 g of propellant, 10.2 s burn and 19 % higher peak '
      + 'are not the redesign\'s; correcting it means taking the redesign\'s figures for every field, which is a '
      + 'ruling, not a transcription fix',
  },
  '6623cf91f873440002ac6a28': {
    designation: 'N2700W-PS',
    holds: { totImpulseNs: 10637, maxThrustN: 5553.5, avgThrustN: 2692.6 },
    why: 'the letter fired two motors and certifies their average, printed in brackets: 10,322 N·s, 4,624.6 N peak, '
      + '2,716.9 N average (its TMT nomenclature, "10,322 N2717", is built from it). The row carries the FIRST motor\'s '
      + 'own figures, 10,637 / 5,553.5 / 2,692.6: 3.1 % over on impulse and 20 % on peak',
  },
};

const rows = catalogue.filter((m) => MAKERS.has(m.manufacturerAbbrev));
const byKey = new Map();
for (const m of rows) {
  const k = motorKey(m.designation);
  if (k) byKey.set(k, [...(byKey.get(k) ?? []), m]);
}
const candidates = (letter) => {
  const as = READ_AS[letter.file];
  return as ? rows.filter((m) => m.designation === as.designation) : byKey.get(motorKey(letter.designation)) ?? [];
};
// Letters with exactly one row. Any other count is the first test's to report, not a crash in the ones after it.
const matched = certified.rows
  .filter((letter) => !(letter.file in ABSENT))
  .map((letter) => ({ letter, found: candidates(letter) }))
  .filter(({ found }) => found.length === 1)
  .map(({ letter, found: [row] }) => ({ letter, row }));
const off = (letter, row, f) => row[f] / letter[f] - 1;
const disagreements = ({ letter, row }) => FIGURES
  .filter((f) => !(Math.abs(off(letter, row, f)) <= TOLERANCE))
  .map((f) => `${f} ${row[f]} against the letter's ${letter[f]} (${(100 * off(letter, row, f)).toFixed(2)} %)`);

describe('the shipped motor catalogue against AeroTech\'s certification letters', () => {
  it('finds each letter\'s motor exactly once, or knows the catalogue does not carry it', () => {
    const wrong = [];
    for (const letter of certified.rows) {
      const found = candidates(letter);
      if (letter.file in ABSENT) {
        if (found.length) {
          wrong.push(`${letter.designation} (${letter.file}) is listed ABSENT but now matches `
            + `${found.map((m) => `${m.manufacturerAbbrev} ${m.designation}`).join(', ')}: retire its ABSENT entry, and the screen checks it`);
        }
      } else if (found.length !== 1) {
        wrong.push(`${letter.designation} (${letter.file}) matches ${found.length} catalogue rows`
          + `${found.length ? `: ${found.map((m) => m.designation).join(', ')}` : ''}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('needs every READ_AS entry: the letter\'s own designation finds nothing', () => {
    for (const file of Object.keys(READ_AS)) {
      const letter = certified.rows.find((l) => l.file === file);
      expect(letter, `READ_AS names ${file}, which aerotech-certified.json does not hold`).toBeDefined();
      expect(byKey.get(motorKey(letter.designation)) ?? [], `${letter.designation} now matches by itself`).toEqual([]);
    }
  });

  it('agrees with every letter on total impulse, peak and average thrust, within TOLERANCE', () => {
    const offenders = matched
      .filter(({ row }) => !(row.motorId in KNOWN))
      .flatMap((pair) => disagreements(pair).map((d) => `${pair.row.manufacturerAbbrev} ${pair.row.designation} `
        + `(${pair.row.motorId}): ${d} — ${pair.letter.file}, ${pair.letter.letterDate}`));
    expect(offenders, `rows that disagree with their certification letter:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('holds each KNOWN row exactly as recorded, and still disagreeing', () => {
    const byId = new Map(matched.map((pair) => [pair.row.motorId, pair]));
    for (const [id, k] of Object.entries(KNOWN)) {
      const pair = byId.get(id);
      expect(pair, `KNOWN ${k.designation} (${id}) matches no letter: retire the entry`).toBeDefined();
      expect(pair.row.designation).toBe(k.designation);
      expect(Object.fromEntries(FIGURES.map((f) => [f, pair.row[f]])),
        `${k.designation} no longer holds the figures KNOWN records: if it now agrees with its letter, retire the entry; `
        + 'if not, look again').toEqual(k.holds);
      expect(disagreements(pair).length, `${k.designation} agrees with its letter: retire the entry`).toBeGreaterThan(0);
    }
  });

  it('screens a real number of rows, so a pass is not an empty match passing', () => {
    expect(matched.filter(({ row }) => !(row.motorId in KNOWN)).length).toBeGreaterThan(30);
  });
});

/**
 * The JSON against itself. Thirteen of its rows were read by eye from scans,
 * and anything in it could be edited by hand; two figures every letter prints
 * twice catch a misread digit.
 */
describe('aerotech-certified.json reads its letters right', () => {
  const LBF = 4.4482216152605;

  it('says where each row came from: the file, its published URL, the letter\'s date and the test\'s', () => {
    expect(certified.rows).toHaveLength(certified.letters);
    expect(certified.rows.filter((l) => l.read === 'image')).toHaveLength(certified.readFromImage);
    for (const l of certified.rows) {
      expect(l.file).toMatch(/\.pdf$/);
      expect(l.url).toMatch(/^https:\/\/\S+\.pdf$/);
      expect(l.letterDate).toMatch(/\d{4}$/);
      expect(l.testedOn).toMatch(/\d{4}$/);
      expect(['text', 'image']).toContain(l.read);
      for (const f of FIGURES) expect(Number.isFinite(l[f]) && l[f] > 0, `${l.file} ${f}`).toBe(true);
    }
  });

  it('has every total impulse and average thrust TMT\'s own nomenclature was built from', () => {
    // "77 F61" (2019-2024: impulse, then class and average thrust) or "F114 (79.15 N-Sec)" (2025). TMT rounds the
    // figures into it, or truncates them: the L1256WS's 1,257.07 N average is "L1256".
    const wrong = [];
    for (const l of certified.rows) {
      const a = /^([\d,]+) [A-O](\d+)$/.exec(l.tmtNomenclature);
      const b = /^[A-O](\d+) \(([\d,.]+) N-Sec\)$/.exec(l.tmtNomenclature);
      const [impulse, thrust] = a ? [a[1], a[2]] : b ? [b[2], b[1]] : [];
      if (impulse === undefined) { wrong.push(`${l.file}: nomenclature "${l.tmtNomenclature}"`); continue; }
      const num = (s) => Number(s.replace(/,/g, ''));
      if (Math.abs(num(impulse) - l.totImpulseNs) > 1.5) wrong.push(`${l.file}: ${l.totImpulseNs} N·s, nomenclature ${impulse}`);
      if (Math.abs(num(thrust) - l.avgThrustN) > 1.5) wrong.push(`${l.file}: ${l.avgThrustN} N average, nomenclature ${thrust}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('prints each peak thrust in lbf to match its N', () => {
    // The nomenclature carries no peak, so the letter's own lbf figure is the cross-check. The letters' rounding and
    // their own slips reach 1.8 % (the G12ST-P's 7.069 lbf beside 30.88 N); a misread leading digit moves it by far more.
    const wrong = certified.rows
      .filter((l) => l.imperial.maxThrustLbf !== undefined)
      .filter((l) => !(Math.abs((l.imperial.maxThrustLbf * LBF) / l.maxThrustN - 1) <= 0.025))
      .map((l) => `${l.file}: ${l.imperial.maxThrustLbf} lbf beside ${l.maxThrustN} N`);
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /**
   * And against the letters themselves, where they are: the extractor re-reads
   * all 216 documents in about a second and compares its answer with the
   * committed file byte for byte. It needs docs/RCS Schematics (or
   * RCS_SCHEMATICS) and Python with PyMuPDF, so it runs on the machine that
   * holds them and nowhere else, CI included.
   */
  const python = process.env.PYTHON ?? 'python';
  const source = process.env.RCS_SCHEMATICS ?? join(here, '..', '..', '..', 'docs', 'RCS Schematics');
  const canExtract = existsSync(join(source, 'Cert Docs', 'TRA'))
    && spawnSync(python, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;

  it.skipIf(!canExtract)('is what extract-aerotech-certified.py reads from the letters today', () => {
    const run = spawnSync(python, [join(here, 'extract-aerotech-certified.py'), '--source', source, '--check'],
      { encoding: 'utf8' });
    expect(run.stdout + run.stderr).toContain('is what the letters give');
    expect(run.status).toBe(0);
  }, 60_000);
});
