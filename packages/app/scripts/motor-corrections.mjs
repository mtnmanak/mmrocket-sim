/**
 * Corrections to thrustcurve.org motor-catalogue rows, each one sourced.
 *
 * The motor catalogue, src/data/motors.json, is thrustcurve.org's, refreshed
 * weekly by fetch-motor-db.mjs. Two of its rows carry figures no motor can have,
 * and thrustcurve.org has served both unchanged since 2019 (its API gave
 * `updatedOn: 2019-04-17` for each on 2026-10-01). They were the only two rows of
 * 1,156 that the app's own plausibility screen refuses (screenEntry in
 * src/services/catalogueOverlay.ts), and motor-catalogue-screen.test.mjs now
 * keeps any other from shipping. Board Tier 1 row 6.
 *
 * Two more carry figures their own certification letters contradict, which no
 * plausibility screen can see (board Tier 1 row 8 (c), 2026-10-01): the AeroTech
 * F52C and H13ST, both tested on 10 September 2020, each listed with its letter's
 * total impulse, peak and average thrust divided by the same 1.159, while its
 * masses, length and burn time are the letter's, rounded. Every file
 * thrustcurve.org publishes for them delivers the low figure, so the picker's
 * impulse gate and the impulse note had nothing to disagree with.
 * aerotech-certified.test.mjs now holds the catalogue to those letters. Only the
 * three figures are corrected, and no curve is touched: both motors fly the
 * curve they flew, and loading one now says how far that curve falls short of
 * its certification.
 *
 * ONE TABLE, FOUR READERS — the rule apply-preset-corrections.mjs set for the
 * parts catalogue, "one list, not two":
 *  - fetch-motor-db.mjs applies it to every refresh before it writes, so
 *    `npm run motors:refresh` and the weekly workflow keep the corrections;
 *  - src/services/catalogueOverlay.ts applies it to the live pull behind "Check
 *    thrustcurve.org", so a live row still carrying the known-bad figure is the
 *    shipped row and not a change, which the screen would otherwise refuse and
 *    report on every check;
 *  - scripts/check-upstream.mjs reads it to watch thrustcurve.org, so the day a
 *    row is fixed there the entry is flagged for retirement (Eric, 2026-08-31:
 *    "maintain vigilance on anything we rely on from third party sources");
 *  - scripts/build-user-guide.mjs phrases the guide's sentence on corrected rows
 *    from it ({{MOTOR_CORRECTIONS}}), so a retired entry leaves the guide too.
 *
 * BROWSER-SAFE, because catalogueOverlay.ts puts it in the app bundle: no
 * imports of any kind (motor-corrections.test.mjs and an ESLint rule hold that),
 * and the app sees it only through motor-corrections.d.mts, kept in step.
 *
 * THE RULE FOR AN ENTRY. A figure is corrected only from the manufacturer's own
 * published data or a certification record, quoted with its URL. thrustcurve.org
 * is where the error is, so it is never a source for its own correction. A field
 * nobody authoritative publishes stays as it is: no "obvious typo" is fixed on a
 * guess, however obvious.
 *
 * CONTRACT, as apply-preset-corrections.mjs's: idempotent, and loud on surprise.
 * A row holding the known-bad figure is corrected. A row already holding the
 * corrected figure is left alone: thrustcurve.org has fixed it, and the entry
 * should be retired (fetch-motor-db.mjs logs it, check-upstream.mjs flags it).
 * A THIRD value is reported, and the refresh refuses to write rather than ship
 * either figure unexamined. So does a motor no longer in the catalogue, as
 * apply-preset-corrections.mjs's MISSING ROW does: withdrawing a motor is
 * thrustcurve.org's call, but this table, the guide's sentence and
 * motor-corrections.test.mjs would all go on naming it, and the deploy gate the
 * weekly refresh runs fails on that test. The refresh waits for the entry to be
 * retired (or moved to the motor's new id), and says so before writing anything.
 */
export const MOTOR_CORRECTIONS = [
  {
    motorId: '5f4294d200023100000003b8',
    manufacturer: 'Cesaroni',
    designation: '25E75-17A',
    fields: { propWeightG: { bad: 104, good: 10.4 } },
    why: 'thrustcurve.org lists 104 g of propellant in a 52 g motor: the decimal point of 10.4 dropped. '
      + 'The flight was never at risk - the app flies the bundled data file\'s own masses, 52 g loaded '
      + 'and 16 g lost by burnout, which is Cesaroni\'s own 52.0 g less its 36 g burnout weight - but '
      + 'the row failed the screen, and anything reading the catalogue pair read 104 g.',
    sources: [
      {
        by: 'Cesaroni Technology, the manufacturer: the motor\'s Motor Data page',
        url: 'https://cesaroni.net/products/p24-1g/25e75-17a/',
        says: 'Loaded Weight 52.0 g; Propellant Weight 10.4 g; Burnout Weight 36 g; CAR Designation CTI 25-E75-VM-17A',
        read: '2026-10-01',
      },
      {
        by: 'National Association of Rocketry, "Certified Model Rocket Motors Approved for Use in ARC 2026" (June 4, 2025)',
        url: 'https://www.rocketrychallenge.org/wp-content/uploads/Rocket-Motors-Approved-for-Use-in-ARC-2026-June-4-2025.pdf',
        says: 'E75VM-17A | Cesaroni | Casing Size (mm) 24 x 69 | Propellant Mass (grams) 10.4 | Total Impulse (N-sec.) 24.8',
        read: '2026-10-01',
      },
    ],
  },
  {
    motorId: '5f4294d200023100000000f5',
    manufacturer: 'Contrail',
    designation: 'J234-BG',
    fields: { length: { bad: 9122, good: 922 } },
    why: 'thrustcurve.org lists this 54 mm hybrid as 9,122 mm long, so no mount\'s length filter could '
      + 'offer it, and a design that loaded it anyway flew a nine-metre motor with its centre of gravity '
      + '4.56 m from its front. Its weights are the certification letter\'s own (1764 g total; the 450 g '
      + 'propellant figure is the letter\'s "Fuel Grain Weight") and are left as they are.',
    sources: [
      {
        by: 'Tripoli Motor Testing certification letter for the Contrail Rockets J234BG, January 22, 2007 '
          + '(H. Paul Holmes, TMT Chair), linked as "TMT Hybrid Motor Data" from the manufacturer\'s own '
          + 'motor chart, https://contrailrockets.com/master-motor-chart',
        url: 'https://contrailrockets.com/wp-content/uploads/2021/12/J234BG-1.pdf',
        says: 'Motor Designation J234BG; Metric Dimensions 54 X 922 MM; Total Weight 1764 g; Fuel Grain Weight '
          + '450 G; Total Impulse 1032.56 NS; Burn Time 4.3 seconds',
        read: '2026-10-01',
      },
      {
        by: 'NAR Standards & Testing, Combined CAR/NAR/TRA Certified Rocket Motors List (prepared 2009 June 03)',
        url: 'http://blogs.nwic.edu/rocketteam/files/2011/10/NAR-TRACombinedMotorList.pdf',
        says: 'H | J234-P | Contrail | Dimensions (mm) 54 x 922 | Impulse (N-sec) 1033 | Propellant Mass 910cc | Tested By TRA',
        read: '2026-10-01',
      },
    ],
  },
  {
    motorId: '5f5e57811e865c0004c955d8',
    manufacturer: 'AeroTech',
    designation: 'F52C',
    fields: {
      totImpulseNs: { bad: 66.2, good: 76.73 },
      maxThrustN: { bad: 64.33, good: 74.57 },
      avgThrustN: { bad: 52.65, good: 61.04 },
    },
    why: 'thrustcurve.org lists 66.2 N·s, 64.33 N peak and 52.65 N average: each the certification letter\'s figure '
      + 'divided by 1.159, the same factor as the H13ST tested the same day, while the row\'s masses, length and burn '
      + 'time are the letter\'s, rounded. Both files it publishes integrate to 66.31 N·s and agree with that row, '
      + 'so nothing said the curve flown falls 13.6 % short of the certification. It is still flown as published, '
      + 'and now the impulse note says so.',
    sources: [
      {
        by: 'Tripoli Motor Testing certification letter for the AeroTech (Enerjet) F52C single-use motor, tested '
          + 'September 10, 2020, 10 motors (Alan C. Whitmore, TMT Chair; the letter\'s own date reads "xxxxxxxx, 2020"), '
          + 'linked as "F52-5, 8, 11C" from the manufacturer\'s own NAR/TRA certification page, '
          + 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/f52c%20cert%20letter_1656516242122.pdf',
        says: 'Manufacturer\'s Designation F52C-5,8,12 [single use]; TMT Nomenclature 77 F61; Loaded Mass 81.40 g; '
          + 'Burn time 1.258 ± 0.055 sec; Total Impulse 76.73 ± 0.60 N.s; Max Impulse 74.57 ± 3.25 N; '
          + 'Average Impulse 61.04 ± 2.99 N; Number of Motors Tested 10',
        read: '2026-10-01',
      },
    ],
  },
  {
    motorId: '5f5e58171e865c0004c955f8',
    manufacturer: 'AeroTech',
    designation: 'H13ST',
    fields: {
      totImpulseNs: { bad: 211.19, good: 244.76 },
      maxThrustN: { bad: 43.51, good: 50.42 },
      avgThrustN: { bad: 13.89, good: 16.1 },
    },
    why: 'thrustcurve.org lists 211.19 N·s, 43.51 N peak and 13.89 N average: each the certification letter\'s figure '
      + 'divided by 1.159, the same factor as the F52C tested the same day, while the row\'s masses, length and burn '
      + 'time are the letter\'s, rounded. Both files it publishes integrate to 214.94 N·s and agree with that row, '
      + 'so nothing said the curve flown falls 12.2 % short of the certification. It is still flown as published, '
      + 'and now the impulse note says so.',
    sources: [
      {
        by: 'Tripoli Motor Testing certification letter for the AeroTech H13ST-P single-use motor, tested '
          + 'September 10, 2020, 3 motors (Alan C. Whitmore, TMT Chair; the letter\'s own date reads "xxxxxxxx, 2020"), '
          + 'linked as "H13ST-P DMS" from the manufacturer\'s own NAR/TRA certification page, '
          + 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/h13st%20cert%20letter_1656524721164.pdf',
        says: 'Manufacturer\'s Designation H13ST-P [single use]; TMT Nomenclature 245 H16; Loaded Mass 203.38 g; '
          + 'Burn time 15.22 ± 0.55 sec; Total Impulse 244.76 ± 7.29N.s; Max Impulse 50.42 ± 2.02 N; '
          + 'Average Impulse 16.10 ± 0.98 N; Number of Motors Tested 3',
        read: '2026-10-01',
      },
    ],
  },
];

const BY_ID = new Map(MOTOR_CORRECTIONS.map((c) => [c.motorId, c]));

/**
 * The row with every known-bad figure it carries corrected, as a copy — or the
 * row itself when nothing applies. Never throws, and leaves a THIRD value alone:
 * that is for the screen and the refresh to judge, not for this to guess at.
 */
export function correctMotorRow(row) {
  const c = row ? BY_ID.get(row.motorId) : undefined;
  if (!c) return row;
  let out = row;
  for (const [field, { bad, good }] of Object.entries(c.fields)) {
    if (row[field] === bad) {
      if (out === row) out = { ...row };
      out[field] = good;
    }
  }
  return out;
}

/**
 * The table against a whole catalogue: the corrected rows, and what was found.
 * `applied` held the known-bad figure and is corrected; `already` holds the
 * corrected figure (thrustcurve.org fixed it: retire the entry); `unexpected`
 * holds neither (re-examine the entry: a refresh must not write); `missing`
 * names a motor the catalogue no longer has (retire the entry).
 */
export function applyMotorCorrections(motors) {
  const found = { applied: [], already: [], unexpected: [], missing: [] };
  const present = new Set(motors.map((m) => m.motorId));
  for (const c of MOTOR_CORRECTIONS) {
    if (!present.has(c.motorId)) found.missing.push(`${c.manufacturer} ${c.designation} (${c.motorId})`);
  }
  const corrected = motors.map((m) => {
    const c = BY_ID.get(m.motorId);
    if (!c) return m;
    for (const [field, { bad, good }] of Object.entries(c.fields)) {
      const at = `${c.manufacturer} ${c.designation} ${field}`;
      if (m[field] === bad) found.applied.push(`${at}: ${bad} -> ${good}`);
      else if (m[field] === good) found.already.push(`${at} = ${good}`);
      else found.unexpected.push(`${at} = ${JSON.stringify(m[field])}, expected the known-bad ${bad} or the corrected ${good}`);
    }
    return correctMotorRow(m);
  });
  return { motors: corrected, ...found };
}
