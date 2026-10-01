import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SHIPPED motor catalogue against AeroTech's certification letters: every
 * Tripoli Motor Testing letter in aerotech-certified.json that certifies a
 * catalogued motor must agree with that row on total impulse, peak thrust and
 * average thrust, and on the motor's length, loaded mass and propellant mass.
 * Runs in `npm test`, so it gates the deploy and the weekly
 * catalogue refresh (.github/workflows/motors-refresh.yml gates its pull request
 * on `npm test`), the way preset-density.test.mjs gates presets.json.
 *
 * WHY (board Tier 1 row 8 (c), 2026-10-01). The picker's impulse-agreement gate
 * and the impulse note (thrustcurve.ts) compare a curve with the catalogue's
 * certified total, and both come from thrustcurve.org: where the two agree with
 * each other, nothing looks further. The F52C and the H13ST ship 13.7 % under
 * their certification letters on all three figures, every bundled curve agreeing
 * with the low one, and nothing in the app could see it. The letters are a
 * reference from outside thrustcurve.org, read from the PDFs by
 * extract-aerotech-certified.py. That needs the local-only docs/RCS Schematics,
 * so the JSON is a committed artifact, the way nozzles.json is.
 *
 * AND THE MOTOR ITSELF (board Tier 1 row 37, 2026-10-01). The letters measure
 * the motor too, and a screen of its thrust alone passed the K62N at 274 mm
 * long, where its letter says 374.25 mm and AeroTech's own drawing makes the
 * case alone 358 mm: the app put its CG 50 mm aft of where it is, and the
 * mount-length filter offered it to mounts it does not fit. Nor could any
 * plausibility screen see it; 274 mm is a length a motor can have, just not
 * this one.
 *
 * A ROW THAT FAILS HERE IS A QUESTION, NOT AN ANSWER, because a letter can be
 * the one that is wrong: the F52C's and H13ST's are undated drafts from one test
 * day, and on total impulse AeroTech's own pages, the NAR's list and the
 * propellant all side with the rows. So a failing row goes in KNOWN, with the
 * figures it holds, why, and every source that bears on it, for the letter or
 * against it, and waits for a ruling. A ruling for the letter makes it a sourced
 * entry in motor-corrections.mjs; one against it keeps it in KNOWN, saying so.
 * Never by widening TOLERANCE.
 */
const here = dirname(fileURLToPath(import.meta.url));
const certified = JSON.parse(readFileSync(join(here, 'aerotech-certified.json'), 'utf8'));
const catalogue = JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'motors.json'), 'utf8')).motors;

/** The three figures each letter certifies, by the catalogue's own field names. */
const CERTIFIED = ['totImpulseNs', 'maxThrustN', 'avgThrustN'];

/**
 * And the motor as the letter measured it: its overall length, loaded mass and
 * propellant mass. Three letters print a placeholder for the propellant ("*",
 * "?": the I175WS, K455NW and L1256WS), so theirs is null and not compared.
 */
const MEASURED = ['length', 'totalWeightG', 'propWeightG'];

/** Every figure the screen compares, and so every figure KNOWN holds. */
const FIGURES = [...CERTIFIED, ...MEASURED];

/**
 * 0.5 %. Where the catalogue carries a motor these letters certify, its figure
 * IS the letter's, transcribed: as thrustcurve.org served it on 2026-10-01, 37
 * of the 41 matched rows agree on all three figures to 0.11 % or better (the
 * other four are the ones in KNOWN), and the widest of the 37 are rounding (the
 * B6W's 4.87 N·s for the letter's 4.865, 0.10 %; the J1265T's 1,073.3 for
 * 1,072.3, 0.09 %).
 * The ± each letter prints is another quantity: the spread between the motors
 * fired, 0.15 to 4.3 % of total impulse, 0.4 to 14.6 % of peak thrust and 0.3
 * to 9.2 % of average thrust. It says how far one motor may stray from the
 * certified figure, not how far a copy of that figure may, and as the tolerance
 * it would pass the J99N's 1.06 % over on impulse (its letter prints ± 1.12 %)
 * for a motor whose peak is 19 % over. So the band is five times the widest
 * rounding, and under the smallest real disagreement in these letters, the
 * N2700W-PS's 0.89 % on average thrust.
 * The length and masses are copied the same way: as served, 39 of the 41 rows
 * agree on length to 0.31 % (the F67C's 112 mm for the letter's 112.35), 39 on
 * loaded mass to 0.23 % (the H14ST's 230 g for 229.47), and 37 of the 38 whose
 * letter gives a propellant mass to 0.30 % (the G75M's 67 g for 66.8). The rest
 * are the J99N and the B6W's loaded mass, both in KNOWN, and the K62N's length,
 * which motor-corrections.mjs corrects.
 */
const TOLERANCE = 0.005;

/**
 * Half a millimetre or half a gram: how far the catalogue's rounding alone puts
 * a faithful copy of a letter's length or mass. thrustcurve.org keeps both to
 * one decimal at most and often to the unit (the K62N's 1,277 g for the letter's
 * 1,276.9; the E35W's 113 mm for 112.77), where the letters print a decimal or
 * two, or from 2025 the unit (the F115SN's 123 mm, copied exactly). On a small
 * motor half a unit is more than TOLERANCE — 0.63 % of the B6W's 79.15 mm, 2.4 %
 * of the C18W's 20.92 g — so a length or mass agrees within TOLERANCE or
 * HALF_UNIT, whichever is wider. Neither alone would do: no row needs HALF_UNIT
 * today, every agreeing figure being inside TOLERANCE, but two masses are
 * inside only TOLERANCE (the H14ST's 230 g for 229.47; the M6000ST's 8,029.6 g
 * for 8,028.58, a gram off in eight kilograms). The smallest real
 * disagreement, the B6W's 1.01 g, is twice HALF_UNIT. A thrust figure gets no
 * such allowance: half a newton-second is 10 % of the B6W's impulse.
 */
const HALF_UNIT = 0.5;

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

/**
 * Letters the screen does not compare, by the letter's file: for a motor the catalogue does not carry, or carries
 * only under a later certification. Held to it: the day a letter's own designation finds a row, it is screened.
 */
const ABSENT = {
  '98mm High Power Single Use/O5280X-PS DMS.pdf': 'the O5280X-P (22,223 N·s, tested 7 December 2019) has no row of '
    + 'its own: thrustcurve.org files "O5280X-P" as another name for its motor 5f4294d2000231000000046c (a search for '
    + 'that designation returns it, read 2026-10-01), listed as the O5500X-PS with the figures of the January 2023 '
    + 'letter, which is read and matched to that row here; both letters give 9,779 g of Propellant X. The catalogue '
    + 'ships the row, so there is no motor to add, and the 2019 figures are not compared',
  '98mm High Power Single Use/N1100W-PS DMS.pdf': 'the N1100W-P (14,418.21 N·s) has no row, and thrustcurve.org lists '
    + 'no AeroTech N1100; the catalogue\'s only N1100 is Cesaroni\'s 14005N1100-P, another maker\'s motor',
};

/**
 * Rows that disagree with their letter, held EXACTLY as they ship until a ruling
 * corrects or excuses them, by motorId. A row that changes in any way fails the
 * screen, so an entry cannot outlive what it describes: if one comes to agree
 * with its letter, retire its entry; if it moves to a third figure, look again.
 * `sources` lists what else bears on a row, for or against its letter.
 */
const KNOWN = {
  '5f5e57811e865c0004c955d8': {
    designation: 'F52C',
    holds: { totImpulseNs: 66.2, maxThrustN: 64.33, avgThrustN: 52.65, length: 111.4, totalWeightG: 81.4, propWeightG: 30 },
    why: 'every figure is the letter\'s divided by 1.159 (76.73 N·s, 74.57 N, 61.04 N), the same factor as the H13ST '
      + 'tested the same day, while its masses, length and burn time are the letter\'s, rounded. But the letter is an '
      + 'undated draft ("xxxxxxxx, 2020"), and on total impulse every other source sides with the row: AeroTech\'s own '
      + 'pages, the NAR\'s list, both bundled curves (66.31 N·s, peak 61.32 N), and the propellant. Over the mass the '
      + 'letter itself measured burning away (81.40 - 45.77 g), 76.73 N·s is 220 s of specific impulse, against 187 s '
      + 'for the F67C, the same Classic propellant, by its 2022 letter; the row\'s 66.2 is 189 s. Only the peak has a '
      + 'second source, AeroTech\'s 74.6 N, printed beside its 66.2 N·s and 52 N average. A ruling, not a transcription',
    sources: [
      {
        by: 'AeroTech (RCS Rocket Motor Components), product pages "Enerjet by AeroTech F52-5C 2-Motor Pack - 65212" '
          + 'and "F52-8C 2-Motor Pack - 65214" (the second at product_7a611801-ae04-c2f5-40e3-dfbd90aaa20c)',
        url: 'https://aerotech-rocketry.com/products/product_f5da1f55-0034-c13d-9f5a-3ef5f1d395f1',
        says: 'Total Impulse: 66.2 N-sec; Average Thrust: 52 newtons; Peak Thrust: 74.6 N-sec; Thrust Duration: 1.3 '
          + 'seconds; Propellant Weight: 30 grams; Motor Weight: 81.4 grams',
        read: '2026-10-01',
      },
      {
        by: 'National Association of Rocketry, "Certified Model Rocket Motors Approved for Use in ARC 2026", as of '
          + 'June 4, 2025, page 3, read by word position',
        url: 'https://www.rocketrychallenge.org/wp-content/uploads/Rocket-Motors-Approved-for-Use-in-ARC-2026-June-4-2025.pdf',
        says: 'F52C-5,8,12 | Aerotech | 29 x 112 | propellant 30.0 g | total impulse 66.2 N-sec (and F67C-6,9,14 | '
          + '29 x 112 | 36.8 g | 77.5 N-sec, its letter\'s 77.46 rounded)',
        read: '2026-10-01',
      },
    ],
  },
  '5f5e58171e865c0004c955f8': {
    designation: 'H13ST',
    holds: { totImpulseNs: 211.19, maxThrustN: 43.51, avgThrustN: 13.89, length: 213.4, totalWeightG: 203.4, propWeightG: 116.4 },
    why: 'every figure is the letter\'s divided by 1.159 (244.76 N·s, 50.42 N, 16.10 N), the same factor as the F52C '
      + 'tested the same day, while its masses, length and burn time are the letter\'s, rounded. But the letter is an '
      + 'undated draft ("xxxxxxxx, 2020"), and on total impulse every other source sides with the row: AeroTech\'s own '
      + 'page, both bundled curves (214.94 N·s, peak 44.53 N), and the propellant. Over the mass the letter itself '
      + 'measured burning away (203.38 - 70.11 g), 244.76 N·s is 187 s of specific impulse, against 160 s for the '
      + 'H14ST-P and 164 s for the G12ST-P, the same Super Thunder, by their 2023 and 2020 letters; the row\'s 211.19 is '
      + '162 s. Only the peak has a second source, AeroTech\'s 50.4 N. A ruling, not a transcription',
    sources: [
      {
        by: 'AeroTech (RCS Rocket Motor Components), product page "AeroTech H13ST-P 29mm x 147mm Single Use DMS '
          + '1-Motor Kit - 081300"',
        url: 'https://aerotech-rocketry.com/products/product_b7697119-7d82-3db0-694e-7de6ea74dd90',
        says: 'Total Impulse: 211 N-sec; Average Thrust: 13 newtons; Peak Thrust: 50.4 N-sec; Thrust Duration: 15.2 '
          + 'seconds; Propellant Weight: 116.4 grams; Motor Weight: 202 grams',
        read: '2026-10-01',
      },
    ],
  },
  '5f4294d20002310000000309': {
    designation: 'J99N',
    holds: { totImpulseNs: 945.2, maxThrustN: 151.95, avgThrustN: 92.4, length: 231, totalWeightG: 899, propWeightG: 556 },
    why: 'the letter certifies the REDESIGNED J99N-P reload, tested 14 August 2020: 935.24 N·s, 127.24 N peak, 86.94 N '
      + 'average, 479.7 g of propellant in 893.51 g loaded, 240.46 mm long, 10.773 s. The row\'s 556 g of propellant, '
      + '899 g loaded, 231 mm, 10.2 s burn and 19 % higher peak are not the redesign\'s; correcting it means taking the '
      + 'redesign\'s figures for every field, which is a ruling, not a transcription fix. The NAR\'s combined list '
      + 'carries the row\'s impulse and propellant, and a third length',
    sources: [
      {
        by: 'NAR Standards & Testing, "Combined CAR/NAR/TRA Certified Rocket Motors List", page 14 of 28 (printed '
          + 'August 12, 2026), the PDF https://www.nar.org/CertifiedMotorListing links, read by word position',
        url: 'https://www.nar.org/docs.ashx?id=1468138',
        says: 'R | J99N-P | AeroTech | Dimensions (mm) 54 x 244 | Impulse (N-sec) 945.2 | Propellant Mass (g) 556 | '
          + 'Tested By TRA',
        read: '2026-10-01',
      },
    ],
  },
  '6623cf91f873440002ac6a28': {
    designation: 'N2700W-PS',
    holds: { totImpulseNs: 10637, maxThrustN: 5553.5, avgThrustN: 2692.6, length: 1232.5, totalWeightG: 9058.2, propWeightG: 5275 },
    why: 'the letter fired two motors and certifies their average, printed in brackets: 10,322 N·s, 4,624.6 N peak, '
      + '2,716.9 N average (its TMT nomenclature, "10,322 N2717", is built from it). The row carries the FIRST motor\'s '
      + 'own figures, 10,637 / 5,553.5 / 2,692.6: 3.1 % over on impulse and 20 % on peak',
  },
  '60ac76068dc4640004c24d93': {
    designation: 'B6W',
    holds: { totImpulseNs: 4.87, maxThrustN: 9.13, avgThrustN: 4.22, length: 79.2, totalWeightG: 19.3, propWeightG: 2.8 },
    why: 'loaded mass 19.3 g against the letter\'s 18.29 g (0.0403 lb): 5.5 % over, which no rounding of 18.29 gives, '
      + 'where every other figure is the letter\'s, rounded. The letter is dated and signed (May 10, 2021), but '
      + 'AeroTech\'s own pages say 19 grams, the row\'s 19.3 rounded and not the letter\'s 18.29, so the two disagree; '
      + 'the NAR\'s combined list prints no loaded mass. What the row reaches: the app flies a data file\'s own masses '
      + 'over the catalogue\'s, and both bundled B6W files state 18.3 g, so no flight flies a 19.3 g B6W; 19.3 g is '
      + 'what the motor browser shows, and what a RASAero import takes out of a stage\'s stated weight before the '
      + 'motor\'s own 18.3 g goes back in',
    sources: [
      {
        by: 'AeroTech (RCS Rocket Motor Components), product pages "Quest Q-Jet™ B6-4W White Lightning Complete 2-Motor '
          + 'Launch Pack - Q6123", "... B6-6W ... - Q6124" (product_82ecf9a3-8256-460b-2be2-3cea2dd7a6d8) and "... B6-4W '
          + 'White Lightning Rocket Motors Value 25-Pack - Q6418" (product_e85bdce0-465b-8123-0ae7-06bef4f9b20b), alike',
        url: 'https://aerotech-rocketry.com/products/product_8c4592e4-0080-de66-b83f-c7d806b6b954',
        says: 'Motor Diameter: 0.71 inches (18mm); Casing Length: 2.75 inches (70mm); Total Impulse: 4.9 N-sec; Average '
          + 'Thrust: 4.2 newtons; Peak Thrust: 8.9 N-sec; Thrust Duration: 1.2 seconds; Propellant Weight: 2.8 grams; '
          + 'Motor Weight: 19 grams',
        read: '2026-10-01',
      },
    ],
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
/** Within TOLERANCE, or for a length or mass within HALF_UNIT. A figure the row lacks (NaN) never agrees. */
const agrees = (letter, row, f) => Math.abs(off(letter, row, f)) <= TOLERANCE
  || (MEASURED.includes(f) && Math.abs(row[f] - letter[f]) <= HALF_UNIT);
const disagreements = ({ letter, row }) => FIGURES
  .filter((f) => letter[f] !== null && !agrees(letter, row, f))
  .map((f) => `${f} ${row[f]} against the letter's ${letter[f]} (${(100 * off(letter, row, f)).toFixed(2)} %)`);
/**
 * A row's screened figures to twelve significant figures, as KNOWN holds them:
 * the shipped JSON carries float noise (the N2700W-PS's 9,058.199999999999 g),
 * which is a serialisation, not a change.
 */
const figuresOf = (row) => Object.fromEntries(FIGURES.map((f) => [f,
  typeof row[f] === 'number' ? Number(row[f].toPrecision(12)) : row[f]]));

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

  it('agrees with every letter on its thrust within TOLERANCE, and on its length and masses within TOLERANCE or HALF_UNIT', () => {
    const offenders = matched
      .filter(({ row }) => !(row.motorId in KNOWN))
      .flatMap((pair) => disagreements(pair).map((d) => `${pair.row.manufacturerAbbrev} ${pair.row.designation} `
        + `(${pair.row.motorId}): ${d} — ${pair.letter.file}, ${pair.letter.letterDate}`));
    expect(offenders, 'rows that disagree with their certification letter (hold each in KNOWN with every source that '
      + `bears on it, and put it to a ruling: a letter can be wrong too):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('holds each KNOWN row exactly as recorded, and still disagreeing', () => {
    const byId = new Map(matched.map((pair) => [pair.row.motorId, pair]));
    for (const [id, k] of Object.entries(KNOWN)) {
      const pair = byId.get(id);
      expect(pair, `KNOWN ${k.designation} (${id}) matches no letter: retire the entry`).toBeDefined();
      expect(pair.row.designation).toBe(k.designation);
      expect(figuresOf(pair.row),
        `${k.designation} no longer holds the figures KNOWN records: if it now agrees with its letter, retire the entry; `
        + 'if not, look again').toEqual(k.holds);
      expect(disagreements(pair).length, `${k.designation} agrees with its letter: retire the entry`).toBeGreaterThan(0);
    }
  });

  it('takes a length or mass rounded to the unit as agreeing, however small the motor, and a thrust figure never', () => {
    // A small motor's figures, and a row with its length and loaded mass rounded to the unit (0.57 % and 2.2 % off)
    // and a propellant mass the letter does not give.
    const letter = { totImpulseNs: 4.6, maxThrustN: 9.13, avgThrustN: 4.22, length: 70.4, totalWeightG: 18.6, propWeightG: null };
    const row = { ...letter, length: 70, totalWeightG: 19, propWeightG: 3.5 };
    expect(disagreements({ letter, row })).toEqual([]);
    // Not the B6W's 1.01 g, which no rounding explains, nor 0.3 N·s of impulse, 6.5 % of it.
    expect(disagreements({ letter: { ...letter, totalWeightG: 18.29 }, row: { ...row, totalWeightG: 19.3 } }))
      .toEqual(["totalWeightG 19.3 against the letter's 18.29 (5.52 %)"]);
    expect(disagreements({ letter, row: { ...row, totImpulseNs: 4.9 } })).toEqual(["totImpulseNs 4.9 against the letter's 4.6 (6.52 %)"]);
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
      for (const f of CERTIFIED) expect(Number.isFinite(l[f]) && l[f] > 0, `${l.file} ${f}`).toBe(true);
      // The screen compares these too, and skips only a propellant mass the letter leaves as "*" or "?".
      for (const f of MEASURED) {
        expect((Number.isFinite(l[f]) && l[f] > 0) || (f === 'propWeightG' && l[f] === null), `${l.file} ${f}`).toBe(true);
      }
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
