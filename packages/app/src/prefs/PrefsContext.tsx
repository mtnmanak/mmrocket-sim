import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UNITS, type Quantity, type UnitSelection } from './units.js';
import { normalizePrinter } from './printers.js';
import { normalizeDragAnalysis } from './dragAnalysis.js';
import { DEFAULT_PREFS, type Preferences } from './preferences.js';
import type { AeroChoice } from './aeroChoice.js';

// The stored shape and its defaults, and the aero choice, live in React-free
// modules (2026-10-01: the headless Launch reads them with no React mounted).
// Re-exported, never copied: aeroChoice.test.ts checks every binding is the
// module's own.
export type { Preferences } from './preferences.js';
export { DEFAULT_PREFS } from './preferences.js';
export type { AeroChoice } from './aeroChoice.js';
export { AERO_SHORT, aeroChoiceOf, effectiveAero, prefsForAeroChoice } from './aeroChoice.js';

const STORAGE_KEY = 'online-openrocket.prefs.v1';

/**
 * The stored unit per quantity, keeping only symbols that quantity can convert
 * (audit 2026-09-22). units.ts's `unitDef` converts an unknown symbol as the
 * quantity's FIRST unit while every label prints the stored one, so a stale or
 * corrupt symbol put metres under a "furlong" heading — the CSV headers among
 * them. An unknown one, or a quantity not stored at all, takes the default.
 */
function knownUnits(stored: Partial<UnitSelection> | undefined): UnitSelection {
  const out = { ...DEFAULT_PREFS.units };
  for (const q of Object.keys(out) as Quantity[]) {
    const sym: unknown = stored?.[q];
    if (typeof sym === 'string' && UNITS[q].some((u) => u.symbol === sym)) out[q] = sym;
  }
  return out;
}

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
    const dragAnalysis = normalizeDragAnalysis(parsed.dragAnalysis);
    if (dragAnalysis) parsed.dragAnalysis = dragAnalysis;
    else delete parsed.dragAnalysis;
    if (!Array.isArray(parsed.resultTiles) || !parsed.resultTiles.every((tile) => typeof tile === 'string')) {
      delete parsed.resultTiles;
    }
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      units: knownUnits(parsed.units),
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
