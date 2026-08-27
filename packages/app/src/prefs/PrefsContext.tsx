import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { INITIAL_UNITS, type UnitSelection } from './units.js';
import { normalizePrinter, type PrinterPrefs } from './printers.js';

/**
 * Persisted user preferences: per-quantity units (desktop UnitGroup style),
 * radius-vs-diameter input mode, and UI theme. Stored in localStorage;
 * unknown/missing keys fall back to defaults so old stores stay loadable.
 */

export interface Preferences {
  units: UnitSelection;
  /** How round components are entered/displayed. Engine always stores radius (SI). */
  radiusMode: 'radius' | 'diameter';
  theme: 'light' | 'dark' | 'system';
  /**
   * "Rogers Modified Barrowman" body-in-presence-of-fins interference (Kbf).
   * When on, the CP/stability and flight sim include the body carryover
   * classic Barrowman drops — a slightly more aft, more conservative CP.
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
  aeroModel?: 'classic' | 'supersonic' | 'auto';
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
  /**
   * First-run tour opt-out. Absent = the tour may auto-show once (its own
   * localStorage flag limits it to a single showing); true = never auto-show.
   * The Guide's "⟲ Tour" replay button works either way.
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
   * The user's 3D printer, in METRES (see prefs/printers.ts for why metres and
   * not the millimetres a slicer quotes). Absent = no printer configured, and
   * that is a load-bearing default: the 🖨 STL export then behaves exactly as
   * it did before part splitting existed — one file, one name, no extra copy.
   */
  printer?: PrinterPrefs;
}

export const DEFAULT_PREFS: Preferences = {
  units: INITIAL_UNITS,
  radiusMode: 'diameter',
  theme: 'dark',
  rogersKbf: true,
};

/**
 * The aero model as ONE four-way choice, which is how the UI has always shown
 * it: the two classic variants live in `aeroModel: 'classic'` and are told
 * apart only by `rogersKbf`, so `aeroMode` alone cannot see a switch between
 * Extended Barrowman and Rogers Kbf. Both the Preferences pulldown and the
 * vitals-strip switch speak this vocabulary, so they cannot drift.
 */
export type AeroChoice = 'eb' | 'kbf' | 'auto' | 'supersonic';

/**
 * Short labels for the vitals strip, where the cell has to stay narrow. The
 * Preferences pulldown keeps its own long-form wording — it has the room, and
 * it is where someone goes to LEARN the difference rather than to flip it.
 */
export const AERO_SHORT: Record<AeroChoice, string> = {
  kbf: 'Rogers Kbf',
  eb: 'Classic EB',
  auto: 'Auto',
  supersonic: 'Supersonic',
};

/** The stored preference as one choice. Folds in the pre-v0.026 boolean. */
export function aeroChoiceOf(prefs: Preferences): AeroChoice {
  const mode = prefs.aeroModel ?? (prefs.supersonicAero ? 'supersonic' : 'classic');
  if (mode !== 'classic') return mode;
  return (prefs.rogersKbf ?? true) ? 'kbf' : 'eb';
}

/**
 * What the app should actually fly with, given the stored preference and any
 * session override.
 *
 * With NO override this must reproduce the raw preference expressions exactly,
 * including the awkward combination the v0.025 migration can leave behind
 * (`aeroModel: 'supersonic'` with `rogersKbf: false`) — deriving both halves
 * from a single collapsed choice would silently flip such a store.
 */
export function effectiveAero(prefs: Preferences, override: AeroChoice | null): {
  aeroMode: 'classic' | 'supersonic' | 'auto';
  effectiveKbf: boolean;
} {
  if (override) {
    return {
      aeroMode: override === 'eb' || override === 'kbf' ? 'classic' : override,
      // Kbf rides along under Auto and Supersonic too, exactly as the
      // Preferences writer does — only 'eb' turns it off.
      effectiveKbf: override !== 'eb',
    };
  }
  return {
    aeroMode: prefs.aeroModel ?? (prefs.supersonicAero ? 'supersonic' : 'classic'),
    effectiveKbf: prefs.rogersKbf ?? true,
  };
}

const STORAGE_KEY = 'online-openrocket.prefs.v1';

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    if (!parsed.themeExplicit) delete parsed.theme;
    // v0.025 stored a boolean; migrate it into the three-way aeroModel.
    if (!parsed.aeroModel && parsed.supersonicAero) parsed.aeroModel = 'supersonic';
    // A stored printer that isn't three positive numbers is dropped, not
    // repaired — planning cuts for a half-parsed machine is worse than not
    // offering to split at all. Absent stays absent (no printer configured).
    const printer = normalizePrinter(parsed.printer);
    if (printer) parsed.printer = printer;
    else delete parsed.printer;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      units: { ...DEFAULT_PREFS.units, ...(parsed.units ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface PrefsContextValue {
  prefs: Preferences;
  setPrefs: (next: Preferences) => void;
  /** Theme with 'system' resolved to what the OS reports right now. */
  resolvedTheme: 'light' | 'dark';
  /** Whether daylight mode is on (it outranks resolvedTheme when it is). */
  daylight: boolean;
  /**
   * True once a preference write has been refused (private mode, blocked site
   * data, quota). Every setting still works for this session and then silently
   * reverts on reload — which is indistinguishable from a broken setting, and
   * is one of the two live explanations for the "Tour Off doesn't work"
   * report. The session autosave already surfaces its equivalent.
   */
  saveFailing: boolean;
  /**
   * A SESSION-ONLY aero-model choice made from the vitals strip. Null means
   * "follow the stored preference". Deliberately not persisted and not part of
   * SessionState: an experiment must not quietly become next session's
   * default, which is the owner's ruling (2026-08-26). Lives here rather than
   * in App so the Preferences dialog can see it — two selects on screen
   * showing different models with no explanation is the collision this
   * placement exists to prevent.
   */
  aeroOverride: AeroChoice | null;
  setAeroOverride: (v: AeroChoice | null) => void;
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  resolvedTheme: 'light',
  daylight: false,
  saveFailing: false,
  aeroOverride: null,
  setAeroOverride: () => {},
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsRaw] = useState<Preferences>(load);
  const [saveFailing, setSaveFailing] = useState(false);
  const [aeroOverride, setAeroOverride] = useState<AeroChoice | null>(null);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const value = useMemo<PrefsContextValue>(() => ({
    prefs,
    setPrefs: (next: Preferences) => {
      setPrefsRaw(next);
      // Verify by reading back, not just by "setItem didn't throw": Safari's
      // private mode has historically accepted the call and stored nothing,
      // and a partitioned/ephemeral store can do the same. The failure edge is
      // what the UI needs — the setting works for this session and vanishes on
      // reload, which reads to the user as the setting being broken.
      // Choosing a model in Preferences OUTRANKS a session override: it is
      // the newer, more deliberate act, and leaving both alive would leave the
      // dialog's own select showing something the app is not flying. Keyed on
      // the two aero fields only — setPrefs is called with a spread for
      // unrelated settings (Daylight, the results tiles), and clearing on
      // every write would make the strip switch undoable by a theme toggle.
      if (next.aeroModel !== prefs.aeroModel || next.rogersKbf !== prefs.rogersKbf) {
        setAeroOverride(null);
      }
      const json = JSON.stringify(next);
      let ok = false;
      try {
        localStorage.setItem(STORAGE_KEY, json);
        ok = localStorage.getItem(STORAGE_KEY) === json;
      } catch {
        ok = false; // private mode / quota
      }
      setSaveFailing(!ok);
    },
    resolvedTheme: prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme,
    daylight: prefs.daylight ?? false,
    saveFailing,
    aeroOverride,
    setAeroOverride,
  }), [prefs, systemDark, saveFailing, aeroOverride]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  return useContext(PrefsContext);
}
