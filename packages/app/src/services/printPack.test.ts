/**
 * The print offer and the zip it hands over.
 *
 * The rule under every assertion here: splitting is OFFERED, never silent, and
 * a user who has not configured a printer sees the app behave exactly as it
 * did before splitting existed — same caption, same single STL, no extra line.
 *
 * Named case throughout, as in splitSolid.test.ts: a 3" (76.2 mm) airframe
 * with a 4:1 tangent ogive nose — 304.8 mm of cone plus a 76.2 mm shoulder,
 * 381 mm printed.
 */
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { printerFromPreset, toPrinterVolume } from '../prefs/printers.js';
import { splitComponent, usableBox, type PrinterVolume } from '../tree/splitSolid.js';
import { buildPrintPack, printOffer, printPackReadme, SINGLE_BUTTON } from './printPack.js';

const node = (type: string, params: Record<string, unknown>): ComponentNode =>
  ({ type, ...params } as unknown as ComponentNode);

const H2D = toPrinterVolume(printerFromPreset('bambu-h2d')!)!;
const MK4S = toPrinterVolume(printerFromPreset('prusa-mk4s')!)!;

/**
 * Usable Z, taken from the splitter rather than restated here. The margin
 * comes off X and Y TWICE (the part is inset from both bed edges) and off Z
 * ONCE (it stands on the bed, so only the top needs keeping clear), so the H2D
 * gives 325 - 8 = 317 mm and the MK4S 220 - 8 = 212 mm. Fixtures below are
 * written as offsets from this rather than as fresh millimetre constants —
 * hard-coded lengths are exactly how this file drifted the last time the
 * convention moved.
 */
const UZ = (p: PrinterVolume): number => usableBox(p).z;

const R3IN = 0.0381;
const WALL = 0.002;

const nose3in = (extra: Record<string, unknown> = {}): ComponentNode => node('nosecone', {
  shape: 'ogive', shapeParameter: 1, length: 0.3048, aftRadius: R3IN, thickness: WALL,
  shoulderRadius: 0.0356, shoulderLength: 0.0762, shoulderThickness: WALL,
  ...extra,
});

/**
 * The case that genuinely needs a different piece count on a smaller machine:
 * a 5" Goblin's nose — Ø130.8 mm, a 4:1 ogive so 523.2 mm of cone, plus a
 * 126.8 mm shoulder = 650 mm printed. Ø130.8 puts the spigot on its 30 mm cap,
 * so the per-segment span is (usable Z - 30): H2D 317 - 30 = 287 and
 * 650/287 = 2.27 -> 3 pieces; MK4S 212 - 30 = 182 and 650/182 = 3.57 -> 4.
 * Ø130.8 still goes on the MK4S's 194 mm usable bed, so neither machine
 * refuses it outright.
 */
const goblin5in = (): ComponentNode => node('nosecone', {
  shape: 'ogive', shapeParameter: 1, length: 0.5232, aftRadius: 0.0654, thickness: WALL,
  shoulderRadius: 0.0629, shoulderLength: 0.1268, shoulderThickness: WALL,
});

const tube = (length: number, extra: Record<string, unknown> = {}): ComponentNode =>
  node('bodytube', { outerRadius: R3IN, thickness: WALL, length, ...extra });

describe('printOffer — no printer configured (the compatibility guarantee)', () => {
  it('a part that any printer swallows offers the unchanged button and NO line', () => {
    const o = printOffer(tube(0.1), {}, null);
    expect(o.kind).toBe('single');
    expect(o.button).toBe('🖨 STL for printing (mm)');
    expect(o.button).toBe(SINGLE_BUTTON);
    expect(o.note).toBeNull();
    expect(o.split).toBeNull();
  });

  it('a big part gets one hint, and still the unchanged button', () => {
    const o = printOffer(nose3in(), {}, null);
    expect(o.kind).toBe('single');
    expect(o.button).toBe(SINGLE_BUTTON);
    expect(o.note).toBe('381 mm long — set your printer in Preferences to check it fits.');
    expect(o.tone).toBe('info');
  });

  it('the hint threshold is the smallest machine we list (A1 mini, 180 - 8 mm)', () => {
    // The A1 mini is 180 mm of Z and the margin comes off it ONCE, so the hint
    // starts at 172 mm — not the 164 mm a doubled margin used to give. Pinned
    // against usableBox() so the two cannot drift apart again.
    expect(UZ({ x: 0.180, y: 0.180, z: 0.180 })).toBeCloseTo(0.172, 12);
    expect(printOffer(tube(0.170), {}, null).note).toBeNull();
    expect(printOffer(tube(0.175), {}, null).note).toMatch(/^175 mm long —/);
  });

  it('a fin is not a revolve and is untouched in every state', () => {
    const fin = node('trapezoidfinset', { rootChord: 0.06, tipChord: 0.03, height: 0.05, thickness: 0.003 });
    for (const p of [null, H2D]) {
      const o = printOffer(fin, {}, p);
      expect(o.kind).toBe('single');
      expect(o.button).toBe(SINGLE_BUTTON);
      expect(o.note).toBeNull();
    }
  });
});

describe('printOffer — printer set, part fits', () => {
  it('confirms the fit quietly and still exports one STL', () => {
    const o = printOffer(tube(0.300), {}, H2D, 'Bambu H2D');
    expect(o.kind).toBe('single');
    expect(o.button).toBe(SINGLE_BUTTON);
    expect(o.note).toBe('300 mm — fits your Bambu H2D upright.');
    expect(o.tone).toBe('info');
    expect(o.split).toBeNull();
  });

  it('says so when the fit needed the 30° lean', () => {
    // usable Z + 3 mm = 320: past the H2D's 317 mm, so it cannot stand up.
    // (The old 312 mm fixture now does stand up and exercised nothing.) A
    // cylinder's wall is 0° off axis, so it gets the whole 30° ceiling and
    // stands 320*cos30 + 76.2*sin30 = 277.1 + 38.1 = 315.2 mm, inside 317.
    const o = printOffer(tube(UZ(H2D) + 0.003), {}, H2D, 'Bambu H2D');
    expect(o.note).toBe('320 mm — fits your Bambu H2D leaned 30° off vertical.');
    expect(o.kind).toBe('single');
  });
});

describe('printOffer — printer set, part does not fit', () => {
  it('puts the piece count in the button and the arithmetic in an amber line', () => {
    const o = printOffer(nose3in(), {}, H2D, 'Bambu H2D');
    expect(o.kind).toBe('split');
    expect(o.button).toBe('🖨 STL for printing — 2 pieces');
    expect(o.tone).toBe('warn');
    // 325 mm of Z less the 8 mm kept clear at the TOP is 317 usable — the
    // margin is not taken off the bottom, because the part stands on the bed —
    // so 381 - 317 = 64 mm over, not the 72 a doubled margin gave.
    // The quoted spigot is the one that gets BUILT (0.25 x the local Ø, 16 mm
    // where the cut lands on the cone), not the larger figure the plan
    // reserves from the worst-case Ø76.2 — the user gets the real part.
    expect(Math.round((0.381 - UZ(H2D)) * 1000)).toBe(64);
    expect(o.note).toBe(
      '381 mm — 64 mm too long for your Bambu H2D. '
      + 'Exports as 2 segments with a 16 mm glued spigot.',
    );
    expect(o.split!.plan.segments).toBe(2);
    expect(o.split!.loops).toHaveLength(2);
  });

  it('a smaller machine plans more pieces', () => {
    // The 3" nose is 2 pieces on BOTH machines now (381/(212 - 19.05) = 1.97
    // on the MK4S), so it can no longer show this. The 650 mm 5" Goblin nose
    // can: 3 on the H2D, 4 on the MK4S — see goblin5in() for the arithmetic.
    const big = printOffer(goblin5in(), {}, H2D, 'Bambu H2D');
    expect(big.button).toBe('🖨 STL for printing — 3 pieces');
    expect(big.note).toContain('Exports as 3 segments');
    const o = printOffer(goblin5in(), {}, MK4S, 'Prusa MK4S');
    expect(o.button).toBe('🖨 STL for printing — 4 pieces');
    expect(o.note).toContain('Exports as 4 segments');
  });

  it('warns about clocking when the part carries a rail button or launch lug', () => {
    const withButton = tube(0.6, { children: [node('railbutton', {})] });
    const o = printOffer(withButton, {}, H2D, 'Bambu H2D');
    expect(o.kind).toBe('split');
    expect(o.note).toContain('rail button or launch lug');
    expect(o.note).toContain('alignment line');
    // ...and a plain tube says nothing about clocking.
    expect(printOffer(tube(0.6), {}, H2D, 'Bambu H2D').note).not.toContain('alignment line');
  });
});

describe('printOffer — refuse rather than mislead', () => {
  it('a part wider than the bed cannot be helped by an axial cut', () => {
    const fat = node('bodytube', { outerRadius: 0.2, thickness: 0.003, length: 0.5 });
    const o = printOffer(fat, {}, H2D, 'Bambu H2D');
    expect(o.kind).toBe('refuse');
    expect(o.button).toBe(SINGLE_BUTTON);
    expect(o.tone).toBe('warn');
    expect(o.note).toContain('cannot be split');
    expect(o.note).toContain('wider than');
    expect(o.split).toBeNull();
  });

  it('a solid rod too thin for an on-axis stub is refused with the reason', () => {
    // Ø4 mm, wall thicker than the radius: solid, and 0.7 mm of stub is not a joint.
    const rod = node('bodytube', { outerRadius: 0.002, thickness: 0.05, length: 0.5 });
    const o = printOffer(rod, {}, H2D, 'Bambu H2D');
    expect(o.kind).toBe('refuse');
    expect(o.note).toMatch(/solid/);
    expect(o.note).toContain('The button exports the whole part.');
  });
});

describe('the zip', () => {
  const split = splitComponent(nose3in(), {}, H2D)!;
  // buildPrintPack is async: it pulls stlExport (and with it three.js) on
  // demand so the design screen does not carry the 3D library.
  let pack: Awaited<ReturnType<typeof buildPrintPack>>;
  let entries: Record<string, Uint8Array>;
  beforeAll(async () => {
    pack = await buildPrintPack(split, 'Nose Cone', H2D, 'Bambu H2D');
    entries = unzipSync(pack.bytes);
  });

  it('is named for the split and holds one STL per segment plus the README', () => {
    expect(pack.filename).toBe('Nose_Cone-print-2-pieces.zip');
    expect(Object.keys(entries).sort()).toEqual([
      'Nose_Cone-print-1of2.stl',
      'Nose_Cone-print-2of2.stl',
      'README.txt',
    ]);
  });

  it('writes real binary STLs (header, triangle count, not an ASCII "solid")', () => {
    for (const name of ['Nose_Cone-print-1of2.stl', 'Nose_Cone-print-2of2.stl']) {
      const bytes = entries[name]!;
      expect(strFromU8(bytes.slice(0, 5))).not.toBe('solid');
      const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
      expect(count).toBeGreaterThan(0);
      expect(bytes.length).toBe(84 + 50 * count);
    }
  });

  it('the README carries the same-material warning, in full', () => {
    const readme = strFromU8(entries['README.txt']!);
    // This paragraph is the one a reviewer must not trim: shrinkage is a
    // multiple of the clearance and only cancels when both halves shrink alike.
    expect(readme).toContain('SAME MATERIAL on the SAME PRINTER');
    expect(readme).toContain('PLA by roughly 0.3%');
    expect(readme).toContain('ASA and ABS by 0.6-0.8%');
    expect(readme).toMatch(/BOTH halves shrink by the\s+same amount/);
  });

  it('the README says which way up, how to glue, and to dry-fit and test first', () => {
    const readme = strFromU8(entries['README.txt']!);
    expect(readme).toContain('BASE DOWN, TIP UP, with NO supports');
    expect(readme).toContain('Joint clearance is 0.15 mm per side (0.30 mm on the diameter)');
    expect(readme).toContain('30-minute epoxy');
    expect(readme).toMatch(/thin CA/);
    expect(readme).toContain('0.05 mm');
    expect(readme).toContain('DRY-FIT EVERY JOINT FIRST');
    expect(readme).toContain('20 mm test ring');
  });

  it('the README accounts for every millimetre — segments sum to the assembly', () => {
    const readme = printPackReadme(split, 'Nose Cone', H2D, 'Bambu H2D');
    expect(readme).toContain('Assembled length 381.0 mm');
    const lens = [...readme.matchAll(/([\d.]+) mm of the finished part/g)].map((m) => Number(m[1]));
    expect(lens).toHaveLength(2);
    expect(lens.reduce((a, b) => a + b, 0)).toBeCloseTo(381.0, 6);
    // ...and the printed height of the fore piece includes its spigot.
    expect(readme).toContain('prints 206.9 mm tall');
  });

  it('quotes the machine it was planned for', () => {
    const readme = printPackReadme(split, 'Nose Cone', H2D, 'Bambu H2D');
    expect(readme).toContain('Bambu H2D (350 × 320 × 325 mm build volume');
    expect(readme).toContain('8 mm kept clear at each end of every axis');
  });

  it('a tuned clearance travels into the README', () => {
    const tight: PrinterVolume = { ...H2D, clearance: 0.00005 };
    const s = splitComponent(nose3in(), {}, tight)!;
    expect(printPackReadme(s, 'Nose Cone', tight, 'Bambu H2D'))
      .toContain('Joint clearance is 0.05 mm per side');
  });
});

/**
 * The two disclosure defects an adversarial harness found: the export told the
 * truth about the geometry and not about what it costs, and it quoted one
 * hardcoded diameter as if it were the user's own.
 */
describe('the joints have a price, and it is stated (D6)', () => {
  // The fuzz worst case: Ø158.6 mm, 896 mm long, 0.7 mm wall, on a 124 mm-Z
  // machine. Usable Z is 124 - 8 = 116, and Ø158.6 puts the spigot on its
  // 30 mm cap, so each segment spans 86 mm: 896/86 = 10.4 -> 11 pieces and
  // 10 spigots, each a 30 mm second tube inside the bore. (12 and 11 was the
  // doubled-Z-margin answer, from 108 mm of usable Z.)
  const thin = node('bodytube', { outerRadius: 0.0793, thickness: 0.0007, length: 0.896 });
  const small: PrinterVolume = { x: 0.180, y: 0.180, z: 0.124, margin: 0.008, maxSegments: 12 };

  it('says so in the note when the joints are more than a tenth of the part', () => {
    const o = printOffer(thin, {}, small, 'the printer');
    expect(o.kind).toBe('split');
    expect(o.split!.plan.segments).toBe(Math.ceil(0.896 / (UZ(small) - 0.030)));
    expect(o.split!.plan.segments).toBe(11);
    expect(o.note).toContain('Exports as 11 segments');
    const pct = Number(/The 10 joints add about (\d+)% to the filament and print time\./.exec(o.note!)?.[1]);
    // Analytically, in mm: ts = min(wall, SPIGOT_WALL) = 0.7, bore radius
    // 79.3 - 0.7 = 78.6, S = bore - clearance = 78.45. Each spigot is
    // pi*(78.45^2 - 77.75^2)*30 = 10305 mm^3 and the tube itself is
    // pi*(79.3^2 - 78.6^2)*896 = 311132 mm^3, so 10 of them are 33.1%; the
    // bosses the lead-in ramps thicken add the rest.
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(40);
  });

  it('and in the README, next to the length accounting it qualifies', () => {
    const s = splitComponent(thin, {}, small)!;
    const readme = printPackReadme(s, 'Airframe', small, 'the printer');
    expect(readme).toMatch(/The 10 spigots and their bosses are extra material/);
    // 33.1% of spigot plus the bosses rounds to 34 — still a 3x figure, and
    // the note above is the assertion that pins the range it came from.
    expect(readme).toMatch(/budget about 3\d% more/);
    // The length accounting is still exact — this is material, not millimetres.
    expect(readme).toContain('Assembled length 896.0 mm');
  });

  it('stays quiet for a normal part — the 3" nose note is unchanged', () => {
    const o = printOffer(nose3in(), {}, H2D, 'Bambu H2D');
    // 381 - 317 mm of usable Z = 64 over; see the amber-line test above.
    expect(o.note).toBe(
      '381 mm — 64 mm too long for your Bambu H2D. '
      + 'Exports as 2 segments with a 16 mm glued spigot.',
    );
    const s = splitComponent(nose3in(), {}, H2D)!;
    expect(printPackReadme(s, 'Nose Cone', H2D, 'Bambu H2D')).not.toContain('extra material');
  });

  it('the spigot wall never exceeds the part\'s own', () => {
    // The cap is in splitSolid.ts (ts = min(wallAtCut, SPIGOT_WALL)); this
    // pins the consequence, which is that a 0.7 mm wall gets a 0.7 mm spigot.
    const s = splitComponent(thin, {}, small)!;
    const c = Math.min(...s.loops[0]!.map(([x]) => x)) + s.plan.cuts[0]!;
    const past = s.loops[0]!.filter(([x]) => x > c + 1e-9).map(([, r]) => r);
    expect(Math.max(...past) - Math.min(...past.filter((r) => r > 0))).toBeCloseTo(0.0007, 9);
  });
});

describe('the shrinkage sum is this part\'s bore, not a hardcoded 72 mm (D7)', () => {
  it('a 3" nose quotes the bore its own joint was cut into', () => {
    const s = splitComponent(nose3in(), {}, H2D)!;
    const readme = printPackReadme(s, 'Nose Cone', H2D, 'Bambu H2D');
    // Cut at 190.5 mm on the ogive: outer 32.81 mm radius, 2 mm wall, so a
    // 61.6 mm bore — not the 72 mm of the airframe it came off.
    expect(readme).toContain("On this\n  part's 61.6 mm joint bore, 0.7% is 0.43 mm");
    expect(readme).not.toContain('72 mm bore');
    // ...and the multiple is like for like: 0.7% of 61.6 is 0.43 mm off the
    // DIAMETER, so it is measured against the DIAMETRAL clearance,
    // 2 x 0.15 = 0.30 mm. 0.43/0.30 = 1.4x. Dividing a diametral shrink by the
    // per-side figure, as this used to, doubled every multiple on the page.
    expect(0.007 * 61.6 / (2 * 0.15)).toBeCloseTo(1.4, 1);
    expect(readme).toMatch(/0\.43 mm off the DIAMETER — 1\.4x the\s+0\.30 mm diametral joint clearance/);
  });

  it('a small coupler is not told it faces five times its clearance', () => {
    // A BT-50-ish coupler: 21 mm bore, where 0.7% is 0.15 mm off the diameter
    // — HALF the 0.30 mm diametral clearance, not five times it and not the
    // 1.0x the per-side comparison used to report. The old sentence overstated
    // the risk by six on a part this size.
    const coupler = node('tubecoupler', { thickness: 0.0015, length: 0.6 });
    const s = splitComponent(coupler, { parentInnerRadius: 0.012 }, H2D)!;
    const readme = printPackReadme(s, 'Coupler', H2D, 'Bambu H2D');
    expect(readme).toContain('21.0 mm joint bore');
    expect(0.007 * 21.0 / (2 * 0.15)).toBeCloseTo(0.5, 1);
    expect(readme).toMatch(/0\.7% is 0\.15 mm off the DIAMETER — 0\.5x the\s+0\.30 mm diametral joint clearance/);
  });

  it('the multiple is recomputed from the clearance the user actually set', () => {
    const tight: PrinterVolume = { ...H2D, clearance: 0.00005 };
    const s = splitComponent(nose3in(), {}, tight)!;
    // Same 61.6 mm bore and the same 0.43 mm of shrink, against a third of the
    // clearance — 2 x 0.05 = 0.10 mm on the diameter — so three times the
    // 1.4x above: 0.43/0.10 = 4.3x.
    expect(0.007 * 61.6 / (2 * 0.05)).toBeCloseTo(4.3, 1);
    expect(printPackReadme(s, 'Nose Cone', tight, 'Bambu H2D'))
      .toMatch(/0\.43 mm off the DIAMETER — 4\.3x the\s+0\.10 mm diametral joint clearance/);
  });
});
