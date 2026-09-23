import { describe, expect, it } from 'vitest';
import {
  MOTOR_DB, allClasses, classLabel, classesFittingMount, diameterClass,
  displayDesignation, filterMotors, findDbMotor, impulseClassesForMount, impulseLetter,
  isBlackPowder,
  manufacturerMatches, manufacturersForMount, matchDbMotor, nearestCommonClass, PROPELLANT_CODES,
  propellantsForMount, rangesForMount, sortMotors,
} from './motorDb.js';

describe('bundled motor database', () => {
  it('is present and substantial', () => {
    expect(MOTOR_DB.length).toBeGreaterThan(1000);
  });

  it('has both regular and OOP motors', () => {
    expect(MOTOR_DB.some((m) => m.availability === 'regular')).toBe(true);
    expect(MOTOR_DB.some((m) => m.availability === 'OOP')).toBe(true);
  });
});

describe('nearestCommonClass (the Scale tool\u2019s question)', () => {
  it('answers "what should I scale to", which diameterClass deliberately does not', () => {
    // diameterClass leaves an odd diameter alone on purpose (it classifies a
    // CATALOGUED motor); nearestCommonClass always names a real casing size.
    expect(diameterClass(45)).toBe(45);
    expect(nearestCommonClass(45)).toBe(38);
    // The Apogee worked example: 18 mm scaled 2.27x.
    expect(nearestCommonClass(40.86)).toBe(38);
  });

  it('rounds a TIE DOWN to the smaller class \u2014 the safe direction', () => {
    // 26.5 is exactly between 24 and 29. A mount slightly too small can be
    // opened out; one too big cannot be made smaller. This is the documented
    // rule and it had no test.
    expect(nearestCommonClass(26.5)).toBe(24);  // exact tie 24/29 -> down
    expect(nearestCommonClass(46)).toBe(38);    // exact tie 38/54 -> down
    expect(nearestCommonClass(46.5)).toBe(54);  // NOT a tie: 7.5 vs 8.5, so up
  });

  it('clamps to the ends rather than inventing a class', () => {
    expect(nearestCommonClass(1)).toBe(6);
    expect(nearestCommonClass(400)).toBe(152);
  });

  it('never returns a size the 75/76 rule would confuse', () => {
    expect(nearestCommonClass(76)).toBe(75);
    expect(classLabel(nearestCommonClass(76))).toBe('75/76');
  });
});

describe('diameter classes', () => {
  it('treats 75 and 76 mm as the same class (AeroTech vs Loki casings)', () => {
    expect(diameterClass(75)).toBe(75);
    expect(diameterClass(76)).toBe(75);
    expect(classLabel(75)).toBe('75/76');
  });

  it('snaps near-common diameters within tolerance', () => {
    expect(diameterClass(38)).toBe(38);
    expect(diameterClass(37.5)).toBe(38);
    expect(diameterClass(29.5)).toBe(29);
  });

  it('leaves genuinely odd diameters as their own class', () => {
    expect(diameterClass(10.5)).toBe(10.5);
    expect(diameterClass(32)).toBe(32);
    expect(diameterClass(64)).toBe(64);
  });

  it('adapter logic: a 38 mm mount fits 38/29/24… but never 54', () => {
    const classes = classesFittingMount(38.5);
    expect(classes).toContain(38);
    expect(classes).toContain(29);
    expect(classes).toContain(24);
    expect(classes).not.toContain(54);
  });

  it('a 75 mm mount accepts 76 mm-labelled motors', () => {
    const fits = filterMotors({
      manufacturers: new Set(), classes: new Set([75]), boreMm: 76,
      includeOOP: true, text: '',
    });
    expect(fits.some((m) => m.diameter === 76)).toBe(true);
    expect(fits.some((m) => m.diameter === 75)).toBe(true);
  });
});

describe('filtering and sorting', () => {
  const base = {
    manufacturers: new Set<string>(), classes: new Set<number>(),
    boreMm: 39, includeOOP: false, text: '',
  };

  it("shows 'occasional' motors without the OOP toggle — they are in production", () => {
    // v0.108. The 2026-09-05 catalogue refresh brought in Jambol's whole line
    // and Ultra's at availability 'occasional', and every filter tested
    // `!== 'regular'`, so 26 motors you can buy were hidden behind "include
    // out-of-production" and read as discontinued. A bore wide enough that
    // every class fits, so the test is about availability and nothing else.
    const shown = filterMotors({ ...base, boreMm: 160, includeOOP: false });
    expect(shown.some((m) => m.availability === 'occasional')).toBe(true);
    expect(shown.some((m) => m.availability === 'OOP')).toBe(false);
    expect(MOTOR_DB.filter((m) => m.availability === 'occasional').length).toBeGreaterThan(0);
  });

  it('hides OOP unless toggled on', () => {
    const without = filterMotors(base);
    const withOOP = filterMotors({ ...base, includeOOP: true });
    expect(withOOP.length).toBeGreaterThan(without.length);
    // 'regular' AND 'occasional' both show by default since v0.108; only OOP hides.
    expect(without.every((m) => m.availability !== 'OOP')).toBe(true);
  });

  it('manufacturer and class toggles narrow the list', () => {
    const only = filterMotors({
      ...base, manufacturers: new Set(['AeroTech']), classes: new Set([29, 38]),
    });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((m) => m.manufacturerAbbrev === 'AeroTech')).toBe(true);
    expect(only.every((m) => [29, 38].includes(diameterClass(m.diameter)))).toBe(true);
  });

  it('text search matches designation and common name', () => {
    const hits = filterMotors({ ...base, includeOOP: true, text: 'h128' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) =>
      m.designation.toLowerCase().includes('h128') || m.commonName.toLowerCase().includes('h128'),
    )).toBe(true);
  });

  it('sorts by burn time and impulse both directions', () => {
    const list = filterMotors({ ...base, includeOOP: true });
    const byBurn = sortMotors(list, 'burnTimeS', 1);
    expect(byBurn[0]!.burnTimeS).toBeLessThanOrEqual(byBurn[byBurn.length - 1]!.burnTimeS);
    const byImpulse = sortMotors(list, 'totImpulseNs', -1);
    expect(byImpulse[0]!.totImpulseNs).toBeGreaterThanOrEqual(byImpulse[byImpulse.length - 1]!.totImpulseNs);
  });

  it('manufacturersForMount lists only manufacturers with fitting motors', () => {
    const mfrs = manufacturersForMount(18.5, false);
    expect(mfrs.some((m) => m.abbrev === 'Estes')).toBe(true);
    for (const { count } of mfrs) expect(count).toBeGreaterThan(0);
  });

  it('every DB class is reachable through some mount size', () => {
    expect(classesFittingMount(200).length).toBe(allClasses().length);
  });

  it('the cached default answer cannot be corrupted by a caller', () => {
    // allClasses() is derived once for the default argument and handed back as
    // a COPY. Returning the cache itself would work perfectly until the day
    // some caller sorted or spliced the result in place, at which point every
    // later caller — the motor browser's filters, the Scale dialog's fit
    // check — would silently see the mangled list. Nothing mutates it today,
    // which is exactly why the contract needs a test rather than a habit.
    const first = allClasses();
    const expected = [...first];
    first.length = 0;
    first.push(-1);
    expect(allClasses()).toEqual(expected);
    // …and the cache is still the same answer as a fresh uncached derivation.
    expect(allClasses()).toEqual(allClasses(MOTOR_DB.slice()));
  });
});

describe('display designations (the owner\'s cleanup rules)', () => {
  it('strips the Cesaroni total-impulse prefix', () => {
    expect(displayDesignation('381I224-15A', 'Cesaroni')).toBe('I224-15A');
    expect(displayDesignation('10347N10000-P', 'Cesaroni')).toBe('N10000-P');
    expect(displayDesignation('107G83-14A', 'Cesaroni')).toBe('G83-14A');
  });

  it('leaves non-Cesaroni leading digits alone (Estes 1/2A etc.)', () => {
    expect(displayDesignation('1/2A6', 'Estes')).toBe('1/2A6');
    expect(displayDesignation('G80T', 'AeroTech')).toBe('G80T');
  });

  it('strips HP- prefixes regardless of manufacturer', () => {
    expect(displayDesignation('HP-I140W', 'AeroTech')).toBe('I140W');
    expect(displayDesignation('HP-G75M', 'Loki')).toBe('G75M');
  });

  it('every Cesaroni motor in the DB cleans to letter-first', () => {
    for (const m of MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Cesaroni')) {
      expect(displayDesignation(m.designation, 'Cesaroni')).toMatch(/^[A-O]\d/);
    }
  });
});

describe('findDbMotor (.ork motor matching)', () => {
  it('finds an exact designation (the G80T case from the owner\'s report)', () => {
    const m = findDbMotor('G80T');
    expect(m).not.toBeNull();
    expect(m!.manufacturerAbbrev).toBe('AeroTech');
  });

  it('finds Cesaroni motors by display designation', () => {
    const m = findDbMotor('I224-15A');
    expect(m?.designation).toBe('381I224-15A');
  });

  it('uses the file diameter to disambiguate', () => {
    const m = findDbMotor('G80T', 29);
    expect(m).not.toBeNull();
    expect(Math.abs(m!.diameter - 29)).toBeLessThanOrEqual(1.5);
  });

  it('returns null for fantasy motors', () => {
    expect(findDbMotor('Z9999-XX')).toBeNull();
    expect(findDbMotor('')).toBeNull();
  });

  /**
   * A PREFIX MAY NOT CUT A NUMBER IN TWO (audit 2026-09-23). RockSim's
   * “G115-WT” — Cesaroni's 38 mm G115 — began with AeroTech's 29 mm “G11”, and
   * six RockSim files in the owner's collection opened on the G11: Apogee's
   * Katana-38mm.rkt flew to 0.2 m, and flies 117.0 m on the G115. Every case
   * below is a reference from that collection or the tester uploads, with what
   * the bare prefix used to pick.
   */
  it('never matches by cutting a number in two', () => {
    const des = (d: string, mfr?: string) => findDbMotor(d, undefined, undefined, mfr)?.designation ?? null;
    expect(des('G115-WT', 'Cesaroni Technology Inc.')).not.toBe('G11');
    expect(des('G118-BS', 'CTI')).not.toBe('G11');
    expect(des('G117WH', 'Cesaroni Technology Inc.')).not.toBe('G11');
    expect(des('I800-Vmax', 'Cesaroni Technology Inc.')).not.toBe('I80');   // RATT's
    expect(des('H55', 'unknown')).toBe('H55W');                             // was the 38 mm H550ST
    expect(des('J100', 'HYPER')).toBeNull();                                // was Loki's J1000-LW
    // The catalogue's own short common names now find their own rows.
    expect(des('G8', 'AeroTech')).toBe('G8ST');                             // was the G80T
    expect(des('H13', 'AeroTech')).toBe('H13ST');                           // was the H130W
    expect(des('I59', 'AeroTech')).toBe('I59WN');                           // was the I599N
  });

  it('still takes a delay or propellant suffix on either side', () => {
    expect(findDbMotor('h128')?.designation).toBe('H128W');
    expect(findDbMotor('H128W-14A')?.designation).toBe('H128W');
    expect(findDbMotor('I224-15A')?.designation).toBe('381I224-15A');
    expect(findDbMotor('G80T-7', 29, undefined, 'AeroTech')?.designation).toBe('G80T');
    // A delay glued to AeroTech's propellant letter: the cut falls between a
    // letter and a digit, not inside a number. The first form of the guard
    // barred ANY digit after the cut and lost these (review of the audit).
    expect(findDbMotor('H128W14A', undefined, undefined, 'AeroTech')?.designation).toBe('H128W');
    expect(findDbMotor('H128W14')?.designation).toBe('H128W');
    // Nor may a bare impulse letter begin a designation: it has no number to cut.
    expect(findDbMotor('H')).toBeNull();
  });

  /**
   * BY COMMON NAME AND PROPELLANT (audit 2026-09-23). Cesaroni's catalogue
   * designation carries no propellant, so a file's “G115-WT” found nothing once
   * it stopped finding the G11. Every reference below is from the owner's
   * RockSim collection or the tester uploads.
   */
  describe('a Cesaroni motor named by common name and propellant code', () => {
    const find = (d: string, mfr = 'Cesaroni Technology Inc.') => findDbMotor(d, undefined, undefined, mfr);

    it('finds the one the file names — dash, no dash, spelled out, with a delay', () => {
      expect(find('G115-WT')?.designation).toBe('141G115-13A');         // Katana-38mm.rkt, 38 mm White Thunder
      expect(find('G118-BS', 'CTI')?.designation).toBe('159G118-15A');
      expect(find('G118BS')?.designation).toBe('159G118-15A');
      expect(find('G117WH')?.designation).toBe('142G117-11A');          // White
      expect(find('I800-Vmax')?.designation).toBe('419I800-15A');
      expect(find('H125-Classic', 'CTI')?.designation).toBe('266H125-12A');
      expect(find('I165 C-Star')?.designation).toBe('518I165-17A');
      expect(find('I165CS')?.designation).toBe('518I165-17A');
      expect(find('H110-WH-14A', 'CTI')?.designation).toBe('269H110-14A');
      expect(find('N2501-WH-P', 'CTI')?.designation).toBe('15227N2501-P'); // ThreeCarbYen-2018.CDX1
      // Cesaroni's own name wins over another maker's bare designation.
      expect(find('G125-RL', 'CTI')?.designation).toBe('159G125-14A');   // was SkyR's G125
    });

    it('picks between two rows of one common name by the propellant, never by catalogue order', () => {
      // Classic 312 Ns and Skidmark 220 Ns: the first-listed took both until now.
      expect(find('H160-CL', 'CTI')?.designation).toBe('312H160-12A');
      expect(find('H160-SK', 'CTI')?.designation).toBe('220H160-14A');
      expect(find('F36-BS', 'CTI')?.designation).toBe('51F36-14A');
      expect(find('F36-SS', 'CTI')?.designation).toBe('41F36-11A');
      expect(find('H255-BS', 'CTI')?.designation).toBe('315H255-14A');
      expect(find('H255-WT', 'CTI')?.designation).toBe('229H255-14A');
    });

    it('matches nothing it cannot confirm: a propellant that disagrees, or none named', () => {
      // The only Cesaroni G69 is Skidmark; the only E31 White Thunder. The
      // first assertion here was `.not.toBe('Cesaroni')`, which passed on
      // SkyR's 29 mm G69 hybrid — what it resolved to in a simulation of five of
      // the owner's files (review of the audit). Nothing is the answer, with
      // the maker or without.
      expect(find('G69-Classic')).toBeNull();
      expect(findDbMotor('G69-Classic')).toBeNull();
      expect(find('E31WH')).toBeNull();
      expect(find('G107WH')).toBeNull();                                // the only G107 is White Thunder
      expect(find('H123A')).toBeNull();                                 // “A” names no propellant
      // AeroTech's glued propellant letter is not a Cesaroni code: F52T stays F52T, never F52C.
      expect(findDbMotor('F52T-8', undefined, undefined, 'AeroTech')?.designation).toBe('F52T');
      // A common name is not cut short of a digit either.
      expect(find('G1150-WT')?.designation).not.toBe('141G115-13A');
    });

    it('reads “DT” as a Dual Thrust propellant, which no common name carries twice', () => {
      // Wildman_2stage.rkt's sustainer: its booster loaded and this did not, so
      // the design flew the booster alone, 2375.5 m against RockSim's 7679.2.
      expect(find('L640-DT')?.designation).toBe('2772L640-P');
      expect(find('L640 Dual Thrust')?.designation).toBe('2772L640-P');
      expect(find('K590-DT')?.designation).toBe('2398K590-15A');
      const dual = new Map<string, number>();
      for (const m of MOTOR_DB.filter((r) => /\/dual thrust$/i.test(r.propInfo ?? ''))) {
        const k = `${m.manufacturerAbbrev} ${m.commonName}`;
        dual.set(k, (dual.get(k) ?? 0) + 1);
      }
      expect([...dual].filter(([, n]) => n > 1)).toEqual([]);
    });

    it('names only propellants the shipped catalogue carries', () => {
      const carried = new Set(MOTOR_DB.map((m) => m.propInfo));
      for (const [code, names] of Object.entries(PROPELLANT_CODES)) {
        for (const name of names) expect(carried.has(name), `${code} → ${name}`).toBe(true);
      }
    });

    /**
     * Loki's and AMW's codes are the ones their OWN designations carry — pinned
     * here, so a catalogue refresh that gives a code a second meaning fails.
     */
    it('reads Loki’s and AMW’s codes as their own designations write them', () => {
      const own = (mfr: string, code: (d: string) => string | undefined) => {
        const seen = new Map<string, Set<string>>();
        for (const m of MOTOR_DB.filter((r) => r.manufacturerAbbrev === mfr && r.propInfo)) {
          const c = code(m.designation)?.toLowerCase();
          if (c) seen.set(c, (seen.get(c) ?? new Set<string>()).add(m.propInfo!));
        }
        return seen;
      };
      const loki = own('Loki', (d) => /([A-Z]{2})$/.exec(d)?.[1]);
      const amw = own('AMW', (d) => /^([A-Z]{2})-\d/.exec(d)?.[1]);
      for (const seen of [loki, amw]) {
        for (const [code, props] of seen) {
          for (const p of props) expect(PROPELLANT_CODES[code], `${code} → ${p}`).toContain(p);
        }
      }
      expect([...loki.keys()].sort()).toEqual(['ct', 'ib', 'lb', 'lc', 'lr', 'lw', 'sf']);
      expect([...amw.keys()].sort()).toEqual(['bb', 'gg', 'rr', 'sk', 'st', 'wt', 'ww']);
    });
  });

  /**
   * THE REVIEW OF AUDIT 2026-09-23. Each case is a reviewer's measured
   * finding, or a reference from the owner's RockSim collection.
   */
  describe('the order of the matches, and what a file’s maker decides', () => {
    const find = (d: string, mfr?: string) => findDbMotor(d, undefined, undefined, mfr);

    it('a propellant after a full designation has to be the row’s own', () => {
      // “F36-11A” is the Smoky Sam's designation; the BS after it is not.
      expect(find('F36-11A-BS', 'Cesaroni')?.designation).toBe('51F36-14A');
      expect(find('H255-14A-BS', 'Cesaroni')?.designation).toBe('315H255-14A');
      expect(find('K650-16A-PK', 'Cesaroni')?.propInfo).toBe('Pink');
      // A row that records no propellant cannot contradict one: Cesaroni's old
      // H153 is the Classic reload the owner's file names — unless it is a
      // hybrid, which burns no solid propellant at all (G69-Classic, above).
      expect(find('H153-Classic', 'Cesaroni Technology Inc.')?.designation).toBe('H153');
    });

    it('a full designation outranks a common name and a propellant', () => {
      // Two Skidmark H123s: the file's “H123-14A” IS the 38 mm one's designation.
      expect(find('H123-14A-SK', 'Cesaroni')?.designation).toBe('232H123-14A');
      expect(find('H123-14A-SK')?.designation).toBe('232H123-14A');
      // Both AeroTech E6s are Blue Thunder; “E6” is the designation of one.
      expect(find('E6 Blue Thunder', 'AeroTech')?.designation).toBe('E6');
      expect(find('E6-RCT Blue Thunder', 'AeroTech')?.designation).toBe('E6-RCT');
    });

    it('a match the letters confirm outranks one they only follow', () => {
      // AeroTech's H135W is a prefix of “H135WH”, but only Cesaroni's H135 is White.
      expect(find('H135WH')?.designation).toBe('217H135-12A');
      expect(find('H135WH', 'unknown')?.designation).toBe('217H135-12A');
      expect(find('K1000SK')?.designation).toBe('SK-54-2550');          // not KBA's K1000S
      expect(find('J280SS')?.designation).toBe('716J280-16A');          // not Kosdon's J280S
    });

    it('the delay a designation names picks between two rows that tie', () => {
      // Only the 38 mm H123 lists a 14 s delay.
      expect(find('H123-SK-14A', 'Cesaroni')?.designation).toBe('232H123-14A');
    });

    it('with nothing to pick between two, takes the first and says there were two', () => {
      // Pinned: all seven corpus references to H123-SK are the 29 mm motor
      // (stored burnout 1.53 s, the end of 176H123-12A's curve), and an overlay
      // marking it out of production would otherwise flip them silently.
      const got = matchDbMotor('H123-SK', undefined, undefined, 'CTI')!;
      expect(got.motor.designation).toBe('176H123-12A');
      expect(got.rivals.map((m) => m.designation)).toEqual(['232H123-14A']);
      expect(matchDbMotor('G115-WT', undefined, undefined, 'Cesaroni Technology Inc.')!.rivals).toEqual([]);
    });

    it('separators between letters do not make two designations', () => {
      // Loki writes “M900-LR” and “K527LR”; RockSim files write the other.
      expect(find('M900LR', 'Loki')?.designation).toBe('M900-LR');     // was RATT's 64 mm M900 hybrid, +18 % impulse
      expect(find('G80LW', 'Loki')?.designation).toBe('G80-LW');       // was Estes's G80
      expect(find('J525LW', 'Loki')?.designation).toBe('J525-LW');
      expect(find('J326LR', 'Loki')?.designation).toBe('J-326-LR');
      expect(find('K527-LR', 'Loki')?.designation).toBe('K527LR');
      expect(find('K2050-ST', 'Aerotech')?.designation).toBe('K2050ST');
      // …but a dash between two digits is kept: “G115-13A” is no G11513A.
      expect(find('G11513A')).toBeNull();
      // …and so is a slash: AeroTech's “G79W/L” is the single-use LMS motor,
      // “G79W-L” the RMS reload at its long delay (the nozzle database's row).
      expect(find('G79W-L', 'AeroTech')?.designation).toBe('G79W');
      expect(find('G79W/L', 'AeroTech')?.designation).toBe('G79W/L');
    });

    it('a maker that catalogues the common name keeps the reference', () => {
      // An exact designation from another maker used to win: bare “G69” filed
      // under Cesaroni resolved to SkyR's 29 mm hybrid, and “J270” under
      // Hypertek to Ellis's.
      expect(find('G69', 'Cesaroni')?.designation).toBe('117G69-14A');
      expect(find('J270', 'Hypertek')?.manufacturerAbbrev).toBe('Hypertek');
      expect(find('G80', 'A')?.designation).toBe('G80T');               // OpenRocket's “A” is AeroTech
      // A maker with that common name but no row the rest agrees with: nothing.
      expect(find('M3000LR', 'Loki')).toBeNull();                       // Loki's only M3000 is Loki White
      // The file's maker's ONLY row of that name, the rest unread: taken.
      expect(find('G80NBT', 'Aerotech')?.designation).toBe('G80T');
      expect(matchDbMotor('G80NBT', undefined, undefined, 'Aerotech')!.tier).toBe(4);
      // …and never by common name without the maker (then Estes's “G80” is a
      // designation the name begins with, tier 3, as before), nor where the
      // maker has two: AMW's K700 is Black Bear and Blue Baboon at one impulse.
      expect(matchDbMotor('G80NBT')!.tier).toBe(3);
      expect(find('K700XX', 'AMW')).toBeNull();
      // A maker with no such common name falls through to whoever has it.
      expect(find('K1075-SK', 'Cesaroni Technology Inc.')?.designation).toBe('2245K1075-P');
      expect(find('J240-RL', 'AeroTech')?.designation).toBe('806J240-16A');
    });

    it('pairs OpenRocket’s own names for the makers', () => {
      for (const [file, abbrev] of [['CSR', 'Cesaroni'], ['CS', 'Cesaroni'], ['HT', 'Hypertek'],
        ['AT', 'AeroTech'], ['A-RMS', 'AeroTech'], ['AT-RCS', 'AeroTech'], ['RCS-AT', 'AeroTech'],
        ['EM', 'Ellis'], ['AW', 'AMW'], ['LR', 'Loki'], ['RTW', 'RATT'], ['SRS', 'SkyR'],
        ['Kosdon by AeroTech', 'KBA']] as const) {
        expect(manufacturerMatches(file, abbrev), `${file} → ${abbrev}`).toBe(true);
      }
      // …and none of the short ones pairs with a maker it is not.
      expect(manufacturerMatches('CS', 'Contrail')).toBe(false);
      expect(manufacturerMatches('AT', 'Apogee')).toBe(false);
      // Four of the owner's files name Cesaroni's I170 under “CSR”, which
      // resolved to AeroTech's 54 mm I170G; eight Public Missiles 54 mm designs
      // name Hypertek's J150 under “HT”, which resolved to Cesaroni's 38 mm J150.
      expect(find('I170', 'CSR')?.designation).toBe('382I170-14A');
      expect(find('J150', 'HT')?.manufacturerAbbrev).toBe('Hypertek');
      expect(find('J250', 'HT')?.manufacturerAbbrev).toBe('Hypertek');
    });
  });
});

/**
 * v0.081 filters (owner, 2026-08-30): impulse class first — "often users want
 * to just be able to see H motors" — plus a fits-my-rocket length cut and
 * propellant, the last folded behind "All filters".
 */
describe('impulse-class filtering', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('reads the letter off the catalog class, ignoring case and padding', () => {
    expect(impulseLetter({ impulseClass: 'H' } as never)).toBe('H');
    expect(impulseLetter({ impulseClass: ' i ' } as never)).toBe('I');
    expect(impulseLetter({ impulseClass: '' } as never)).toBe('');
    expect(impulseLetter({} as never)).toBe('');
  });

  it('offers the classes that actually fit a 29 mm mount, with counts', () => {
    const cs = impulseClassesForMount(29, false);
    expect(cs.length).toBeGreaterThan(2);
    expect(cs.map((c) => c.letter)).toEqual([...cs.map((c) => c.letter)].sort());
    expect(cs.every((c) => c.count > 0)).toBe(true);
    // A 29 mm mount is squarely H/I territory.
    expect(cs.some((c) => c.letter === 'H' || c.letter === 'I')).toBe(true);
  });

  it('returns only the chosen class', () => {
    const got = filterMotors({ ...base, impulse: new Set(['H']), boreMm: 29, includeOOP: false });
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((m) => impulseLetter(m) === 'H')).toBe(true);
  });

  it('an empty class set means all of them', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const empty = filterMotors({ ...base, impulse: new Set(), boreMm: 29, includeOOP: false });
    expect(empty.length).toBe(all.length);
  });
});

describe('the "only motors that fit" length cut', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('drops motors longer than the stated room, keeping the rest', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const fits = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: 0.15 });
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.length).toBeLessThan(all.length);
    // Catalog lengths are millimetres.
    expect(fits.every((m) => m.length <= 150 + 1e-6)).toBe(true);
  });

  it('null means no length filtering at all — the browser flags instead', () => {
    const all = filterMotors({ ...base, boreMm: 29, includeOOP: false });
    const nulled = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: null });
    expect(nulled.length).toBe(all.length);
  });

  it('keeps a motor exactly at the limit', () => {
    const one = filterMotors({ ...base, boreMm: 29, includeOOP: false })
      .reduce((a, b) => (a.length > b.length ? a : b));
    const got = filterMotors({ ...base, boreMm: 29, includeOOP: false, maxLengthM: one.length / 1000 });
    expect(got.some((m) => m.designation === one.designation)).toBe(true);
  });
});

describe('propellant filtering', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };

  it('offers propellants commonest first', () => {
    const ps = propellantsForMount(29, false);
    expect(ps.length).toBeGreaterThan(1);
    for (let i = 1; i < ps.length; i++) expect(ps[i - 1]!.count).toBeGreaterThanOrEqual(ps[i]!.count);
  });

  it('returns only the chosen propellant', () => {
    const top = propellantsForMount(29, false)[0]!;
    const got = filterMotors({ ...base, propellants: new Set([top.name]), boreMm: 29, includeOOP: false });
    expect(got.length).toBe(top.count);
    expect(got.every((m) => (m.propInfo ?? '').trim() === top.name)).toBe(true);
  });
});

/**
 * Burn-time and impulse windows (owner, 2026-08-30b): "show me motors that
 * have a burn time from 0.0sec - 2.4sec". Typed bounds rather than sliders —
 * the impulse span for one mount runs three orders of magnitude, which no
 * two-ended slider handles usefully.
 */
describe('burn-time and impulse windows', () => {
  const base = { manufacturers: new Set<string>(), classes: new Set<number>(), text: '' };
  const all = () => filterMotors({ ...base, boreMm: 29, includeOOP: false });

  it("reports the span the mount's motors actually cover", () => {
    const r = rangesForMount(29, false)!;
    expect(r).not.toBeNull();
    expect(r.burnS[0]).toBeGreaterThan(0);
    expect(r.burnS[1]).toBeGreaterThan(r.burnS[0]);
    expect(r.impulseNs[1]).toBeGreaterThan(r.impulseNs[0]);
  });

  it('keeps only motors inside a burn-time window, inclusive', () => {
    const got = filterMotors({ ...base, boreMm: 29, includeOOP: false, burnS: { min: 0, max: 2.4 } });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(all().length);
    expect(got.every((m) => m.burnTimeS <= 2.4 + 1e-9)).toBe(true);
  });

  it('takes one bound on its own', () => {
    const lo = filterMotors({ ...base, boreMm: 29, includeOOP: false, burnS: { min: 3, max: null } });
    expect(lo.every((m) => m.burnTimeS >= 3 - 1e-9)).toBe(true);
    expect(lo.length).toBeGreaterThan(0);
    const hi = filterMotors({ ...base, boreMm: 29, includeOOP: false, impulseNs: { min: null, max: 200 } });
    expect(hi.every((m) => m.totImpulseNs <= 200 + 1e-9)).toBe(true);
  });

  it('two null bounds filter nothing', () => {
    const got = filterMotors({
      ...base, boreMm: 29, includeOOP: false,
      burnS: { min: null, max: null }, impulseNs: { min: null, max: null },
    });
    expect(got.length).toBe(all().length);
  });

  it('combines with the class filter rather than replacing it', () => {
    const got = filterMotors({
      ...base, boreMm: 29, includeOOP: false,
      impulse: new Set(['H']), burnS: { min: 0, max: 1.5 },
    });
    expect(got.every((m) => impulseLetter(m) === 'H' && m.burnTimeS <= 1.5 + 1e-9)).toBe(true);
  });
});

/**
 * WHAT LIGHTS OFF AN EJECTION CHARGE. Pinned against live catalogue rows so a
 * refresh that recapitalises or restyles the propellant field turns this red
 * rather than silently moving 58 motors onto electronic ignition.
 */
describe('isBlackPowder', () => {
  it('recognises the catalogue spelling', () => {
    expect(isBlackPowder({ propInfo: 'black powder' })).toBe(true);
  });

  it('survives a recapitalisation or stray whitespace upstream', () => {
    expect(isBlackPowder({ propInfo: 'Black Powder' })).toBe(true);
    expect(isBlackPowder({ propInfo: '  BLACK POWDER  ' })).toBe(true);
    expect(isBlackPowder({ propInfo: 'blackpowder' })).toBe(true);
  });

  it('is false for a composite trade name, whatever the motor size', () => {
    // The whole point of the change: an AeroTech E is well under the old
    // high-power line and still cannot be lit by an ejection charge.
    expect(isBlackPowder({ propInfo: 'Blue Thunder' })).toBe(false);
    expect(isBlackPowder({ propInfo: 'White Lightning' })).toBe(false);
    expect(isBlackPowder({ propInfo: 'composite' })).toBe(false);
  });

  it('is false, not throwing, when the catalogue records nothing', () => {
    // 223 of the 1,156 shipped rows are in this state.
    expect(isBlackPowder({})).toBe(false);
    expect(isBlackPowder({ propInfo: '' })).toBe(false);
    expect(isBlackPowder({ propInfo: '   ' })).toBe(false);
  });
});

/**
 * WHAT LIGHTS OFF AN EJECTION CHARGE. Pinned against live catalogue spellings
 * so a refresh that recapitalises or restyles the propellant field turns this
 * red rather than silently moving 58 motors onto electronic ignition.
 */
describe('isBlackPowder', () => {
  it('recognises the catalogue spelling', () => {
    expect(isBlackPowder({ propInfo: 'black powder' })).toBe(true);
  });

  it('survives a recapitalisation or stray whitespace upstream', () => {
    expect(isBlackPowder({ propInfo: 'Black Powder' })).toBe(true);
    expect(isBlackPowder({ propInfo: '  BLACK POWDER  ' })).toBe(true);
    expect(isBlackPowder({ propInfo: 'blackpowder' })).toBe(true);
  });

  it('is false for a composite trade name, whatever the motor size', () => {
    // The whole point of the change: an AeroTech E is well under the old
    // high-power line and still cannot be lit by an ejection charge.
    expect(isBlackPowder({ propInfo: 'Blue Thunder' })).toBe(false);
    expect(isBlackPowder({ propInfo: 'White Lightning' })).toBe(false);
    expect(isBlackPowder({ propInfo: 'composite' })).toBe(false);
  });

  it('is false, not throwing, when the catalogue records nothing', () => {
    // 223 of the 1,156 shipped rows are in this state.
    expect(isBlackPowder({})).toBe(false);
    expect(isBlackPowder({ propInfo: '' })).toBe(false);
    expect(isBlackPowder({ propInfo: '   ' })).toBe(false);
  });
});
