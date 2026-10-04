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
 * A third carries a figure a motor can have, just not this one, which no
 * plausibility screen can see: the AeroTech K62N, 274 mm long where its
 * certification letter measured 374.25 mm and AeroTech's own drawing makes the
 * case alone 358 mm (thrustcurve.org's `updatedOn: 2023-01-09`). It was found by
 * aerotech-certified.test.mjs, which holds the catalogue to AeroTech's
 * certification letters and keeps any other such row from shipping
 * unremarked. Board Tier 1 row 37.
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
 * guess, however obvious. And never on one document: a second document has to
 * STATE the same figure, because a certification letter can be the one that is
 * wrong (the F52C's and H13ST's are undated drafts that AeroTech's own pages and
 * the NAR's list contradict on total impulse: aerotech-certified.test.mjs,
 * KNOWN). A source that states a corrected figure gives it in `states`, as it
 * prints it, and must agree with the correction and rule out the known-bad
 * figure, each to its own last printed digit (the NAR's list keeps whole
 * millimetres, so the K62N's 374.25 mm is its 375). A source that only bounds
 * the figure or explains it is quoted without `states`, and is not the second:
 * the K62N's drawing gives its case alone, a floor under its length.
 * Where the sources disagree, nothing is corrected unless Eric explicitly rules
 * for a source. Tier 0 row 57 (2026-10-04) rules for the F52C/H13ST product-page
 * peaks (the letters agree when rounded to the pages' tenths), and for the
 * N2700W-PS letter's two-motor averages without a second document. That narrow
 * exception does not authorize other single-document corrections.
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
    motorId: '5f5e57811e865c0004c955d8',
    manufacturer: 'AeroTech',
    designation: 'F52C',
    fields: { maxThrustN: { bad: 64.33, good: 74.6 } },
    why: 'Eric, Tier 0 row 57, 2026-10-04: keep catalogue impulse and average thrust; correct only the peak. '
      + 'AeroTech publishes 74.6 beside 66.2 N-s total, agreeing with the letter only on peak after rounding. '
      + 'The product page mislabels peak as N-sec; peak thrust is in N. The flown samples are unchanged.',
    sources: [
      {
        by: 'AeroTech, Enerjet F52-5C 2-Motor Pack, 65212',
        url: 'https://aerotech-rocketry.com/products/product_f5da1f55-0034-c13d-9f5a-3ef5f1d395f1',
        says: 'Total Impulse: 66.2 N-sec; Average Thrust: 52 newtons; Peak Thrust: 74.6 N-sec',
        states: { maxThrustN: '74.6' },
        read: '2026-10-04',
      },
      {
        by: 'Tripoli Motor Testing, F52C certification draft, tested September 10, 2020; aerotech-certified.json',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/f52c%20cert%20letter_1656516242122.pdf',
        says: 'Max Impulse 74.57 N',
        states: { maxThrustN: '74.57' },
        read: '2026-10-04',
      },
    ],
  },
  {
    motorId: '5f5e58171e865c0004c955f8',
    manufacturer: 'AeroTech',
    designation: 'H13ST',
    fields: { maxThrustN: { bad: 43.51, good: 50.4 } },
    why: 'Eric, Tier 0 row 57, 2026-10-04: keep catalogue impulse and average thrust; correct only the peak. '
      + 'AeroTech publishes 50.4 beside 211 N-s total, agreeing with the letter only on peak after rounding. '
      + 'The product page mislabels peak as N-sec; peak thrust is in N. The flown samples are unchanged.',
    sources: [
      {
        by: 'AeroTech, H13ST-P Single Use DMS 1-Motor Kit, 081300',
        url: 'https://aerotech-rocketry.com/products/product_b7697119-7d82-3db0-694e-7de6ea74dd90',
        says: 'Total Impulse: 211 N-sec; Average Thrust: 13 newtons; Peak Thrust: 50.4 N-sec',
        states: { maxThrustN: '50.4' },
        read: '2026-10-04',
      },
      {
        by: 'Tripoli Motor Testing, H13ST certification draft, tested September 10, 2020; aerotech-certified.json',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/h13st%20cert%20letter_1656524721164.pdf',
        says: 'Max Impulse 50.42 N',
        states: { maxThrustN: '50.42' },
        read: '2026-10-04',
      },
    ],
  },
  {
    motorId: '6623cf91f873440002ac6a28',
    manufacturer: 'AeroTech',
    designation: 'N2700W-PS',
    fields: { totImpulseNs: { bad: 10637, good: 10322 }, maxThrustN: { bad: 5553.5, good: 4624.6 } },
    why: 'Eric, Tier 0 row 57, 2026-10-04 explicitly rules for the certification letter: the bracketed '
      + 'two-motor averages, not motor 1. This is a scoped exception to the two-document rule. Only the '
      + 'two fields named in the task are corrected; average thrust and burn time remain the catalogue values.',
    sources: [
      {
        by: 'Tripoli Motor Testing, April 17, 2024 letter, tested March 30, 2024, pages 1-2; local RCS Schematics/'
          + 'Cert Docs/TRA/RMS-75-10240/N2700W-PS.pdf, visually read (letter types M2700W-PS)',
        url: 'https://s3.eu-west-1.amazonaws.com/static.fw1.biz/Templates/170652/myimages/n2700w%20tra%20cert_1754333128692.pdf',
        says: 'Total Impulse [10,322 N.s]; Max Impulse [4624.6 N]; Number of Motors Tested 2',
        states: { totImpulseNs: '10322', maxThrustN: '4624.6' },
        read: '2026-10-04',
      },
    ],
  },
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
        states: { propWeightG: '10.4' },
        read: '2026-10-01',
      },
      {
        by: 'National Association of Rocketry, "Certified Model Rocket Motors Approved for Use in ARC 2026" (June 4, 2025)',
        url: 'https://www.rocketrychallenge.org/wp-content/uploads/Rocket-Motors-Approved-for-Use-in-ARC-2026-June-4-2025.pdf',
        says: 'E75VM-17A | Cesaroni | Casing Size (mm) 24 x 69 | Propellant Mass (grams) 10.4 | Total Impulse (N-sec.) 24.8',
        states: { propWeightG: '10.4' },
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
        states: { length: '922' },
        read: '2026-10-01',
      },
      {
        by: 'NAR Standards & Testing, Combined CAR/NAR/TRA Certified Rocket Motors List (prepared 2009 June 03)',
        url: 'http://blogs.nwic.edu/rocketteam/files/2011/10/NAR-TRACombinedMotorList.pdf',
        says: 'H | J234-P | Contrail | Dimensions (mm) 54 x 922 | Impulse (N-sec) 1033 | Propellant Mass 910cc | Tested By TRA',
        states: { length: '922' },
        read: '2026-10-01',
      },
    ],
  },
  {
    motorId: '63bb643e1d26f30004b4b077',
    manufacturer: 'AeroTech',
    designation: 'K62N',
    fields: { length: { bad: 274, good: 374.25 } },
    why: 'thrustcurve.org lists this 54 mm single-use motor as 274 mm long: 100 mm shorter than its certification '
      + 'letter measured it, and 84 mm shorter than its case alone by AeroTech\'s own drawing (14.104 in, 358.2 mm). '
      + 'The app put its centre of gravity, at half its length, 137 mm ahead of its aft end where it is 187 mm, and a '
      + 'mount with 274 to 374 mm of room for a motor was offered it. The NAR\'s combined list gives 54 x 375, the '
      + 'letter\'s length to the millimetre above, as it gives the H13ST-P\'s 213.39 mm as 214 and the J1265ST-14A\'s '
      + '397.27 as 398. Its other figures are the letter\'s (its 1,277 g loaded is the letter\'s 1,276.9) and are left '
      + 'as they are.',
    sources: [
      {
        by: 'Tripoli Motor Testing certification letter for the AeroTech K62N-P, December 6, 2022 (Alan C. Whitmore, '
          + 'TMT Chair; tested December 4, 2022), linked from the manufacturer\'s own certification page, '
          + 'https://www.rocketmotorparts.com/page/nar-tra-certification-docs',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/k62n%20cert%20letter_1673060829432.pdf',
        says: 'Manufacturer\'s Designation K62N-P [single use, DMS]; Diameter 2.125″ 53.98 mm; Overall Length 14.734″ '
          + '374.25 mm; Loaded Mass 2.815 lb 1276.9 g; Propellant Mass 1.832 lb* 831 g*',
        states: { length: '374.25' },
        read: '2026-10-01',
      },
      {
        by: 'NAR Standards & Testing, "Combined CAR/NAR/TRA Certified Rocket Motors List", page 18 of 28 (printed '
          + 'August 12, 2026), the PDF https://www.nar.org/CertifiedMotorListing links',
        url: 'https://www.nar.org/docs.ashx?id=1468138',
        says: 'S | K62N-P | AeroTech | Dimensions (mm) 54 x 375 | Impulse (N-sec) 1438.5 | Propellant Mass (g) 831 | '
          + 'Tested By TRA',
        states: { length: '375' },
        read: '2026-10-01',
      },
      {
        by: 'RCS Rocket Motor Components (AeroTech), drawing 116200 "K62N-P DMS™ Motor Assembly", rev. A, first release '
          + '12/7/22, linked as "K62N-P" from https://www.rocketmotorparts.com/page/single-use-motor-designs: the case '
          + 'alone, so a floor under the motor\'s length, not the length',
        url: 'https://d3l66gvjdr7rqw.cloudfront.net/Templates/170652/myimages/k62n-p%20rcs%20assembly_1670429681665.pdf',
        says: 'FIBERGLASS CASE, THIN (2.125" O.D. X 14.104"); 54MM PHENOLIC LINER, 1.982" O.D. X 12.832" LONG; PROP '
          + 'GRAIN (1.87" O.D. X 12.362" CAP TUBE) 8223AL',
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
