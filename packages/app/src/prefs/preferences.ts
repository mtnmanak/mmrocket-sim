import { INITIAL_UNITS, type UnitSelection } from './units.js';
import type { PrinterPrefs } from './printers.js';
import type { DragAnalysisPrefs } from './dragAnalysis.js';

/**
 * Persisted user preferences: per-quantity units (desktop UnitGroup style),
 * radius-vs-diameter input mode, and UI theme. Stored in localStorage;
 * unknown/missing keys fall back to defaults so old stores stay loadable.
 *
 * The type and its defaults live here, React-free, since 2026-10-01: the
 * headless Launch (services/simulateDesign.ts) flies the app's default aero
 * model, and reading that default must not load React. PrefsContext.tsx
 * re-exports both, so every existing importer gets the same bindings.
 */
export interface Preferences {
  units: UnitSelection;
  /** How round components are entered/displayed. Engine always stores radius (SI). */
  radiusMode: 'radius' | 'diameter';
  theme: 'light' | 'dark' | 'system';
  /**
   * "Rogers Modified Barrowman" body-in-presence-of-fins interference (Kbf).
   * When on, the CP/stability and flight sim include the body carryover
   * classic Barrowman drops — a slightly more aft CP, which RAISES the
   * stability margin shown (aft is not "conservative": see Karbon, Peak of
   * Flight 687, and the note in FinSetCalc).
   * DEFAULT ON since v0.034 (the owner: matches his actual flight data better).
   * Absent = the default; an explicit stored false is an intentional opt-out
   * and is preserved. Turn it off for exact desktop-OpenRocket parity.
   */
  rogersKbf?: boolean;
  /** Legacy boolean (v0.025) — migrated into aeroModel on load. */
  supersonicAero?: boolean;
  /**
   * Which aerodynamics model to use (feature #1):
   * - 'classic' (default): Extended Barrowman, bit-identical to the desktop.
   * - 'supersonic': the RASAero-class model at all speeds.
   * - 'auto': fly classic; if the flight is projected past Mach 0.9
   *   (transonic onset), re-fly the WHOLE flight on the supersonic model.
   */
  aeroModel?: 'classic' | 'supersonic' | 'auto' | 'hybrid';
  /**
   * True once the user picks a theme themselves. Stored themes without this
   * flag were incidental snapshots of an old default and yield to the current
   * default (lets us change the default without overriding real choices).
   */
  themeExplicit?: boolean;
  /**
   * Daylight mode: dark ink on white at maximum contrast, for reading a phone
   * screen in direct sun at the launch site. It OVERRIDES `theme` rather than
   * layering on it — in sunlight the polarity is the point, and the default
   * theme is dark, so "more contrast on your current theme" would give most
   * users a black screen. Turning it off restores the chosen theme.
   */
  daylight?: boolean;
  /**
   * Which metrics show as the highlighted tiles on the Results tab, by
   * catalog id (RESULT_TILE_METRICS in StatTiles.tsx), in catalog order.
   * Absent = the default set. Unknown ids are ignored (forward compat).
   */
  resultTiles?: string[];
  /** Drag analysis inputs retained across Results navigation and reloads. */
  dragAnalysis?: DragAnalysisPrefs;
  /**
   * First-run tour opt-out. Absent = the tour may auto-show once (its own
   * localStorage flag limits it to a single showing); true = never auto-show.
   * The header's "⟲ Tour" replay button (beside the Guide) works either way.
   */
  tourOff?: boolean;
  /**
   * What the 3D view marks on the rocket. Four-way rather than a boolean
   * because the 3D draws TWO independent marker systems and a tester asked
   * for the option to lose them: the on-axis CG/CP spheres, and the floating
   * callout beside the hull that repeats them with the stability margin. Some
   * people want the clean shell for a photo; some want the numbers but not
   * the balls on the airframe.
   *
   * Absent = 'both' = the view exactly as it has always been, so no stored
   * preferences blob changes meaning.
   */
  markers3d?: 'both' | 'callout' | 'axis' | 'off';
  /**
   * How the static stability margin reads throughout the app — the vitals
   * strip, the floating chip, the 2D and 3D callouts, the Fly screen and the
   * schematic export.
   * - 'cal' (default): calibers, the traditional body-diameter margin.
   * - 'pct': percent of aerodynamic length, desktop OpenRocket's
   *   PercentageOfLengthUnit. Requested on the beta thread — it is the figure
   *   that stays meaningful on a very long or very short airframe, where
   *   "two calibers" means quite different things.
   * - 'both': calibers with the percentage after it. Widest; fine on a
   *   desktop, tight in the phone chip.
   * Absent = 'cal', so nobody's display changes until they choose.
   */
  stabilityUnit?: 'cal' | 'pct' | 'both';
  /**
   * Dimensional rulers around the 2D design view — a scale along the top
   * reading from the nose tip and one down the left reading from the
   * centreline, in the `units.length` unit. Absent = ON, which is what the
   * desktop does (its rulers are not optional). Off gives the drawing the
   * gutters back.
   */
  rulers2d?: boolean;
  /**
   * The user's 3D printer, in METRES (see prefs/printers.ts for why metres and
   * not the millimetres a slicer quotes). Absent = no printer configured, and
   * that is a load-bearing default: the 🖨 STL export then behaves exactly as
   * it did before part splitting existed — one file, one name, no extra copy.
   */
  printer?: PrinterPrefs;
}

/** The preferences of a store that holds none — what a first visit runs with. */
export const DEFAULT_PREFS: Preferences = {
  units: INITIAL_UNITS,
  radiusMode: 'diameter',
  theme: 'dark',
  rogersKbf: true,
};
