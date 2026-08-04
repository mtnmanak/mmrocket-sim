import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { INITIAL_UNITS, type UnitSelection } from './units.js';

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
   * Opt-in "Rogers Modified Barrowman" body-in-presence-of-fins interference
   * (Kbf). When on, the CP/stability and flight sim include the body carryover
   * classic Barrowman drops — a slightly more aft, more conservative CP.
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
}

export const DEFAULT_PREFS: Preferences = {
  units: INITIAL_UNITS,
  radiusMode: 'diameter',
  theme: 'dark',
};

const STORAGE_KEY = 'online-openrocket.prefs.v1';

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    if (!parsed.themeExplicit) delete parsed.theme;
    // v0.025 stored a boolean; migrate it into the three-way aeroModel.
    if (!parsed.aeroModel && parsed.supersonicAero) parsed.aeroModel = 'supersonic';
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
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  resolvedTheme: 'light',
  daylight: false,
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsRaw] = useState<Preferences>(load);
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
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode / quota — preferences just won't persist.
      }
    },
    resolvedTheme: prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme,
    daylight: prefs.daylight ?? false,
  }), [prefs, systemDark]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  return useContext(PrefsContext);
}
