import type { PrinterVolume } from '../tree/splitSolid.js';

/**
 * The user's 3D printer, as a preference.
 *
 * WHY THIS IS IN METRES. Build volumes look like millimetre numbers and every
 * slicer quotes them that way, but the part splitter (tree/splitSolid.ts)
 * measures them against profile loops built by bodyLoop() — pure SI, like the
 * rest of the app. This is shared GEOMETRY INPUT, not export data, so the
 * house x1000 stays where it belongs (M_TO_MM in services/stlExport.ts) and
 * millimetres never leak into the splitter. Storing mm here would have dragged
 * a second unit convention through every call.
 *
 * The consequence is a good one: the dialog runs these through the same
 * siToUi/uiToSi plumbing as every other length, so a builder who works in
 * inches types a build volume in inches for free.
 */

export interface PrinterPrefs {
  /** preset id from PRINTER_PRESETS, or CUSTOM_PRESET */
  preset: string;
  /** bed X (m) */
  x: number;
  /** bed Y (m) */
  y: number;
  /** maximum Z (m) */
  z: number;
  /** keep-out inset applied at both ends of every axis (m) */
  margin: number;
  /** joint clearance per side (m) */
  clearance: number;
  /** optional spigot-length override (m); absent = derived from the diameter */
  spigot?: number;
}

export interface PrinterPreset {
  id: string;
  /** short enough to read inside a sentence ("fits your Bambu H2D upright") */
  label: string;
  /** X, Y, Z in MILLIMETRES — the machine's own spec sheet, converted below */
  mm: [number, number, number];
}

export const CUSTOM_PRESET = 'custom';

/** Manufacturer-quoted build volumes, X x Y x Z in mm. */
export const PRINTER_PRESETS: PrinterPreset[] = [
  { id: 'bambu-h2d', label: 'Bambu H2D', mm: [350, 320, 325] },
  { id: 'bambu-x1c', label: 'Bambu X1C / P1S / A1', mm: [256, 256, 256] },
  { id: 'bambu-a1mini', label: 'Bambu A1 mini', mm: [180, 180, 180] },
  { id: 'prusa-mk4s', label: 'Prusa MK4S', mm: [250, 210, 220] },
  { id: 'prusa-xl', label: 'Prusa XL', mm: [360, 360, 360] },
  { id: 'ender-3', label: 'Creality Ender 3', mm: [220, 220, 250] },
  { id: 'k1-max', label: 'Creality K1 Max', mm: [300, 300, 300] },
  { id: 'neptune-4-plus', label: 'Elegoo Neptune 4 Plus', mm: [320, 320, 385] },
];

/** Keep-out inset at each end of each axis (m) — brim below, gantry above. */
export const DEFAULT_PRINT_MARGIN = 0.008;
/** Joint clearance per side (m): 0.15 mm, an FDM-realistic slip fit. */
export const DEFAULT_PRINT_CLEARANCE = 0.00015;

/**
 * The mm -> m boundary for build volumes. It exists once, here. Divide, never
 * multiply by 0.001: 350 * 0.001 is 0.35000000000000003 and 350 / 1000 is
 * exactly 0.35, which keeps a stored preset comparable to a fresh one.
 */
const fromMm = (mm: number): number => mm / 1000;

export function printerFromPreset(id: string, prev?: PrinterPrefs): PrinterPrefs | null {
  const p = PRINTER_PRESETS.find((q) => q.id === id);
  if (!p) return null;
  return {
    preset: p.id,
    x: fromMm(p.mm[0]),
    y: fromMm(p.mm[1]),
    z: fromMm(p.mm[2]),
    // A preset changes the machine, not the user's process settings.
    margin: prev?.margin ?? DEFAULT_PRINT_MARGIN,
    clearance: prev?.clearance ?? DEFAULT_PRINT_CLEARANCE,
    ...(prev?.spigot !== undefined ? { spigot: prev.spigot } : {}),
  };
}

/** Which preset (if any) a typed X/Y/Z still matches — 0.05 mm of slack. */
export function presetMatching(x: number, y: number, z: number): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 5e-5;
  const hit = PRINTER_PRESETS.find(
    (p) => near(x, fromMm(p.mm[0])) && near(y, fromMm(p.mm[1])) && near(z, fromMm(p.mm[2])),
  );
  return hit ? hit.id : CUSTOM_PRESET;
}

/** Display name for messages; a hand-typed volume has no brand to name. */
export function printerName(p: PrinterPrefs | undefined): string {
  const hit = p && PRINTER_PRESETS.find((q) => q.id === p.preset);
  return hit ? hit.label : 'printer';
}

/**
 * Preference -> splitter input. Returns null when no printer is configured,
 * which is the "leave the export exactly as it was" signal: a user who never
 * opens this section must see the app behave the way it did before it existed.
 */
export function toPrinterVolume(p: PrinterPrefs | undefined): PrinterVolume | null {
  if (!p || !(p.x > 0) || !(p.y > 0) || !(p.z > 0)) return null;
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    margin: p.margin > 0 ? p.margin : DEFAULT_PRINT_MARGIN,
    clearance: p.clearance >= 0 ? p.clearance : DEFAULT_PRINT_CLEARANCE,
    ...(p.spigot !== undefined ? { spigot: p.spigot } : {}),
  };
}

/**
 * Sanitise a stored blob. Anything that is not three positive numbers is
 * dropped rather than repaired — a half-parsed build volume would silently
 * plan cuts for a machine that does not exist. Unknown extra keys survive the
 * spread untouched (forward compat), exactly like the rest of the prefs.
 */
export function normalizePrinter(raw: unknown): PrinterPrefs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Partial<PrinterPrefs>;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!ok(p.x) || !ok(p.y) || !ok(p.z)) return undefined;
  return {
    ...(p as PrinterPrefs),
    preset: typeof p.preset === 'string' ? p.preset : presetMatching(p.x, p.y, p.z),
    margin: ok(p.margin) ? p.margin : DEFAULT_PRINT_MARGIN,
    clearance: typeof p.clearance === 'number' && p.clearance >= 0
      ? p.clearance : DEFAULT_PRINT_CLEARANCE,
  };
}
