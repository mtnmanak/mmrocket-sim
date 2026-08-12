import { strToU8, zipSync } from 'fflate';
import type { ComponentNode } from '@online-openrocket/engine';
import { componentLoop, revolveProfile, type SolidContext } from '../tree/solidMesh.js';
import {
  DEFAULT_CLEARANCE, DEFAULT_MARGIN, revolvedVolume, splitComponent,
  type ComponentSplit, type PrinterVolume,
} from '../tree/splitSolid.js';
import { solidToStl } from './stlExport.js';

/**
 * The 3D-print export offer: what the 🖨 button says, what it hands you, and
 * the one line under it that explains why.
 *
 * SPLITTING IS OFFERED, NEVER SILENT. Cutting a part in two is a design
 * decision with a structural consequence — a glued joint where there was
 * none — so it has to be visible before the click (button text), after the
 * click (file names) and in the box (README). A user who has not configured a
 * printer gets the exact bytes and the exact filename this app produced
 * before splitting existed; that compatibility guarantee is why every "no
 * printer" path below returns the untouched single-STL offer.
 *
 * Units stay SI (metres) all the way to services/stlExport.ts, which owns the
 * x1000. The millimetres in these strings are display formatting only.
 */

/** Unchanged caption — the compatibility guarantee is that this string wins by default. */
export const SINGLE_BUTTON = '🖨 STL for printing (mm)';

export type PrintTone = 'none' | 'info' | 'warn';

export interface PrintOffer {
  /** 'single' = today's one STL; 'split' = a zip of segments; 'refuse' = won't assemble */
  kind: 'single' | 'split' | 'refuse';
  /** button caption */
  button: string;
  /** one line under the button, or null to show nothing at all */
  note: string | null;
  tone: PrintTone;
  /** the segments to write; only set when kind === 'split' */
  split: ComponentSplit | null;
}

/**
 * Above this, a part is worth mentioning to someone who has not set a printer
 * (m). It is the smallest machine in prefs/printers.ts — an A1 mini's 180 mm
 * Z less its top margin — so the hint appears exactly when "it fits anything"
 * stops being true.
 */
const HINT_LENGTH = 0.180 - DEFAULT_MARGIN;

/**
 * Component types whose CHILDREN carry a rotational feature. A plain round
 * spigot has no clocking: the segments can be glued at any relative angle, so
 * a rail button on one side and a launch lug on the other are no longer
 * guaranteed to line up. We warn rather than refuse, deliberately — the
 * button and the lug are separate components and are NOT part of this mesh
 * (they are printed or bought separately and fitted after assembly), so the
 * exported segments are correct; what the builder loses is the reference line,
 * and a line drawn down the tube before cutting solves it in ten seconds.
 * Refusing here would block a perfectly good body-tube export.
 */
const CLOCKED_CHILDREN = new Set(['railbutton', 'launchlug']);

const mmInt = (m: number): string => String(Math.round(m * 1000));
const mm1 = (m: number): string => (m * 1000).toFixed(1);
/** Clearances live in hundredths — 0.15 mm rounded to 0.2 would misstate the fit. */
const mm2 = (m: number): string => (m * 1000).toFixed(2);

/**
 * The tallest spigot the user will actually see (m), measured off the cut
 * pieces rather than taken from the plan. The plan RESERVES the biggest spigot
 * any cut on the part could need (spigotLengthFor is monotone in diameter, so
 * planning with the max keeps the plan a fixed point); the joint that gets
 * built is sized to the LOCAL diameter and is usually shorter — 16 mm rather
 * than 19 on a 4:1 ogive, because the cut lands where the cone has narrowed.
 * Quoting the reserved figure in the UI would describe a part nobody gets.
 */
function longestSpigot(split: ComponentSplit): number {
  const first = split.loops[0];
  if (!first) return 0;
  // Cut planes are offsets from the fore end; loop x has its own origin.
  const x0 = Math.min(...first.map(([x]) => x));
  let out = 0;
  for (let i = 0; i + 1 < split.loops.length; i++) {
    // Piece i ends at cut i; whatever it carries past that plane is spigot.
    const hi = Math.max(...split.loops[i]!.map(([x]) => x));
    out = Math.max(out, hi - (x0 + split.plan.cuts[i]!));
  }
  return Math.max(out, 0);
}

/**
 * The mating bore the joints are cut into (m, DIAMETER), largest of them.
 *
 * Every spigot is an offset of the real bore — its OD is (bore - clearance) —
 * so the widest thing the fore piece carries past a cut plane, plus the
 * clearance back on, IS the socket it has to enter. The solid stub-and-socket
 * joint measures the same way: there the "bore" is the socket the stub keys
 * into. Returns 0 if there is nothing to measure.
 */
function matingBore(split: ComponentSplit, clearance: number): number {
  const first = split.loops[0];
  if (!first) return 0;
  const x0 = Math.min(...first.map(([x]) => x));
  let widest = 0;
  for (let i = 0; i + 1 < split.loops.length; i++) {
    const c = x0 + split.plan.cuts[i]!;
    for (const [x, r] of split.loops[i]!) if (x > c + 1e-9 && r > widest) widest = r;
  }
  return widest > 0 ? 2 * (widest + clearance) : 0;
}

/**
 * How much material the JOINTS added, as a fraction of the part itself.
 *
 * A spigot is a second tube living inside the bore for 30 mm of every segment,
 * plus the boss the lead-in ramp thickens the wall into. On a normal part that
 * is a few per cent and not worth a sentence; on a thin wall cut into many
 * pieces it is not: a 158.6 mm x 896 mm tube with a 0.7 mm wall, planned as 12
 * pieces on a 124 mm-Z machine, spends 37% MORE filament and print time on its
 * 11 joints than the whole tube costs — and the UI used to say only "Exports
 * as 12 segments with a 30 mm glued spigot".
 *
 * The spigot wall is already capped at the part's own (see SPIGOT_WALL and the
 * `ts` clamp in splitSolid.ts), so this is what remains after that cap.
 */
function jointOverhead(split: ComponentSplit): number {
  if (!(split.wholeVolume > 0) || split.loops.length < 2) return 0;
  let sum = 0;
  for (const loop of split.loops) sum += revolvedVolume(loop);
  return (sum - split.wholeVolume) / split.wholeVolume;
}

/** Above this the joints are worth a sentence of their own. */
const OVERHEAD_WORTH_SAYING = 0.10;

/** Axial extent of a closed (x, r) loop, metres. */
function span(loop: ReadonlyArray<[number, number]>): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x] of loop) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * Usable Z, metres. It mirrors usableBox() in tree/splitSolid.ts, where the
 * margin comes off Z ONCE — the part sits on the bed at z = 0, so only the top
 * needs keeping clear (X and Y lose it twice, being inset from both edges).
 * The plan does not expose the number and this message is the only place that
 * needs it; if that convention ever changes, this line changes with it —
 * printPack.test.ts pins the two together.
 */
function usableZ(printer: PrinterVolume): number {
  return printer.z - (printer.margin ?? DEFAULT_MARGIN);
}

function clockingNote(node: ComponentNode): string {
  const kids = (node.children ?? []).filter((c) => CLOCKED_CHILDREN.has(c.type));
  if (kids.length === 0) return '';
  return ' This part carries a rail button or launch lug: a round joint holds no clocking, '
    + 'so draw an alignment line down the outside before you glue.';
}

/** File-name-safe part name, matching what the single-STL path has always used. */
export function safeName(name: string): string {
  return name.replace(/[^\w-]+/g, '_');
}

/**
 * Decide what the print button offers for this component.
 *
 * `printer` is null when the user has not configured one — then this returns
 * the untouched single-STL offer, with at most an advisory line for a part
 * that is too long to assume it fits anything.
 */
export function printOffer(
  node: ComponentNode, ctx: SolidContext,
  printer: PrinterVolume | null, printerLabel = 'printer',
): PrintOffer {
  const single = (note: string | null, tone: PrintTone): PrintOffer =>
    ({ kind: 'single', button: SINGLE_BUTTON, note, tone, split: null });

  // Fins are flat prisms, not revolves — componentLoop() returns null and the
  // splitter has nothing to say about them. Nothing changes for those.
  const base = componentLoop(node, ctx);
  if (!base) return single(null, 'none');
  const total = span(base.loop);

  if (!printer) {
    if (total <= HINT_LENGTH) return single(null, 'none');
    return single(
      `${mmInt(total)} mm long — set your printer in Preferences to check it fits.`, 'info',
    );
  }

  const split = splitComponent(node, ctx, printer);
  if (!split) return single(null, 'none');
  const { plan } = split;

  if (plan.fits) {
    // The angle comes from the plan, never from a constant: the lean is capped
    // by the part's own steepest wall, so a haack or ellipsoid nose that leans
    // at all leans by less than 30 (tree/splitSolid.ts, MAX_LEAN).
    const how = plan.leanUsed ? `leaned ${plan.leanDeg ?? 30}° off vertical` : 'upright';
    return single(`${mmInt(total)} mm — fits your ${printerLabel} ${how}.`, 'info');
  }

  if (plan.segments < 2 || split.loops.length < 2) {
    // Either the machine cannot hold the part at all, or the cut would land
    // somewhere a spigot cannot go (a shoulder, a solid rod too thin to key).
    // The whole-part STL is still worth having — a club printer or a friend's
    // machine may be bigger — so the button keeps working; what it must not do
    // is quietly hand over segments that will not assemble.
    return {
      kind: 'refuse',
      button: SINGLE_BUTTON,
      note: `${mmInt(total)} mm — does not fit your ${printerLabel}, and cannot be split: `
        + `${plan.reason} The button exports the whole part.`,
      tone: 'warn',
      split: null,
    };
  }

  const n = plan.segments;
  const over = total - usableZ(printer);
  const spigot = longestSpigot(split);
  const lead = over > 0
    ? `${mmInt(total)} mm — ${mmInt(over)} mm too long for your ${printerLabel}.`
    : `${mmInt(total)} mm — too big for your ${printerLabel} in one piece.`;
  const overhead = jointOverhead(split);
  // Filament and hours are the two things a builder plans around, so a third
  // more of both is not a detail to leave in the geometry.
  const cost = overhead > OVERHEAD_WORTH_SAYING
    ? ` The ${n - 1} joints add about ${Math.round(overhead * 100)}% to the filament and print time.`
    : '';
  return {
    kind: 'split',
    button: `🖨 STL for printing — ${n} pieces`,
    note: `${lead} Exports as ${n} segments with a ${mmInt(spigot)} mm glued spigot.`
      + cost + clockingNote(node),
    tone: 'warn',
    split,
  };
}

/**
 * Assembled length of the whole part (m), recovered from the segments. The
 * fore piece starts at the part's fore end and the aft piece ends at its aft
 * end; every spigot protrudes INWARD from a cut plane, so the union of the
 * segment extents is exactly the original part and no spigot inflates it.
 */
function assembledLength(split: ComponentSplit): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const loop of split.loops) {
    for (const [x] of loop) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * The README is the half of this export a slicer cannot supply: which way up,
 * which glue, and the shrinkage rule that decides whether the two halves fit
 * each other at all.
 */
export function printPackReadme(
  split: ComponentSplit, partName: string, printer: PrinterVolume, printerLabel = 'printer',
): string {
  const n = split.plan.segments;
  const base = safeName(partName);
  const assembled = assembledLength(split);
  // Cut planes are offsets from the fore end, so these are the segment ends.
  const ends = [0, ...split.plan.cuts, assembled];
  const clearance = printer.clearance ?? DEFAULT_CLEARANCE;
  const overhead = jointOverhead(split);
  const cost = overhead > OVERHEAD_WORTH_SAYING
    ? `\n  The ${n - 1} spigots and their bosses are extra material: budget about `
      + `${Math.round(overhead * 100)}% more\n  filament and print time than the finished part's own volume.\n`
    : '';
  // The bore the joints were actually cut into, not an illustration. Quoting a
  // fixed 72 mm next to a clearance that IS interpolated from the user's own
  // preferences read as equally specific to their part, and overstated the
  // shrinkage risk threefold on anything small: 0.7% of a 24 mm bore is 0.17
  // mm, not 0.5. Falls back to the widest thing in the box if the joints
  // cannot be measured.
  const bore = matingBore(split, clearance)
    || 2 * Math.max(0, ...split.loops.flatMap((l) => l.map(([, r]) => r)));
  const shrink = 0.007 * bore;
  // Same basis as the clearance quoted beside it (per side), so the ratio is
  // the one the GLUING section's numbers can be checked against.
  // Like for like: `shrink` is a change in DIAMETER, so it must be compared
  // against the diametral clearance (2x the per-side figure), not the per-side
  // one. Comparing the two directly overstated the ratio by exactly 2x.
  const times = clearance > 0 ? (shrink / (2 * clearance)).toFixed(1) : '—';

  const files = split.loops.map((loop, i) => {
    const segLen = ends[i + 1]! - ends[i]!;
    const where = i === 0 ? 'fore (tip) end'
      : i === n - 1 ? 'aft (base) end, with the shoulder if the part has one'
      : 'middle section';
    // Only the pieces that GROW a spigot print taller than their own length —
    // the aft piece carries the socket, which is a hole, not height.
    const why = i < n - 1 ? ' (the segment plus its spigot)' : '';
    return `  ${base}-print-${i + 1}of${n}.stl\n`
      + `      piece ${i + 1} of ${n} — ${where}.\n`
      + `      ${mm1(segLen)} mm of the finished part; prints ${mm1(span(loop))} mm tall${why}.`;
  }).join('\n');

  return `${partName} — printed in ${n} pieces
Made by Online OpenRocket. Dimensions are millimetres; the STLs are too.

WHAT IS IN HERE
${files}

  Assembled length ${mm1(assembled)} mm. The segment lengths above add up to it exactly:
  the spigot is a plug that vanishes inside the joint, and the two flat faces meeting
  are what set the length, so gluing neither adds nor loses millimetres.
${cost}
ORIENTATION
  Print every piece BASE DOWN, TIP UP, with NO supports. That is the orientation the
  parts were cut for: each one stands on the flat face the cut made (or on the part's
  own base), the walls stay inside the ~45° overhang every slicer can bridge, and the
  layer lines end up ACROSS the joint rather than along it — which is the direction an
  ejection charge loads a nose or a coupler. Laying a piece on its side fits more on
  the bed and gives you a part that delaminates along the axis.

MATERIAL — the mistake that ruins the fit
  Print every segment in the SAME MATERIAL on the SAME PRINTER, ideally back to back.
  Filament shrinks as it cools: PLA by roughly 0.3%, ASA and ABS by 0.6-0.8%. On this
  part's ${mm1(bore)} mm joint bore, 0.7% is ${mm2(shrink)} mm off the DIAMETER — ${times}x the
  ${mm2(2 * clearance)} mm diametral joint clearance these parts were cut with.
  The joint survives that only because BOTH halves shrink by the
  same amount and the error cancels. Mix a PLA half with an ASA half, or print one half
  on another machine with a different flow calibration, and the spigot either seizes
  solid or rattles.

GLUING
  Joint clearance is ${mm2(clearance)} mm per side (${mm2(2 * clearance)} mm on the diameter).
  Use 30-minute epoxy: it fills that gap, it is what the clearance was chosen for, and
  the working time lets you seat the piece against the flat land and check it is square
  before it grabs. Do NOT use thin CA — at ${mm2(clearance)} mm it wicks, then seizes half
  way in; CA wants about 0.05 mm and an instant, final push.
  DRY-FIT EVERY JOINT FIRST, with no glue. It should slide to the flat stop with hand
  pressure and no rock. If it is tight, scrape or sand the spigot — never the socket.

BEFORE YOU COMMIT TO THE LONG PRINT
  If you are unsure of the fit, print a 20 mm test ring: slice a 20 mm slab off each
  side of one joint in your slicer and print just those two. Ten minutes tells you what
  an eight-hour print would have told you tomorrow. Adjust the clearance in
  Preferences → 3D printing and re-export if it is tight or loose.

Printer this was planned for: ${printerLabel} `
    + `(${mmInt(printer.x)} × ${mmInt(printer.y)} × ${mmInt(printer.z)} mm build volume,\n`
    + `${mmInt(printer.margin ?? DEFAULT_MARGIN)} mm kept clear at each end of every axis).\n`;
}

export interface PrintPack {
  bytes: Uint8Array;
  /** download name, carrying the piece count so the split is visible on disk */
  filename: string;
}

/**
 * One zip: N segment STLs plus the README. Never called for a part that fits —
 * a one-entry zip would be a worse version of the file the user asked for.
 */
export function buildPrintPack(
  split: ComponentSplit, partName: string, printer: PrinterVolume, printerLabel = 'printer',
): PrintPack {
  const n = split.plan.segments;
  const base = safeName(partName);
  const files: Record<string, Uint8Array> = {};
  split.loops.forEach((loop, i) => {
    const name = `${base}-print-${i + 1}of${n}.stl`;
    files[name] = solidToStl(revolveProfile(loop), `${partName} ${i + 1}/${n}`);
  });
  files['README.txt'] = strToU8(printPackReadme(split, partName, printer, printerLabel));
  return { bytes: zipSync(files), filename: `${base}-print-${n}-pieces.zip` };
}

export const ZIP_MIME = 'application/zip';
