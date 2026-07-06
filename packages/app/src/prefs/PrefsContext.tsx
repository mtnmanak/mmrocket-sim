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
  /**
   * True once the user picks a theme themselves. Stored themes without this
   * flag were incidental snapshots of an old default and yield to the current
   * default (lets us change the default without overriding real choices).
   */
  themeExplicit?: boolean;
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
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {},
  resolvedTheme: 'light',
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
  }), [prefs, systemDark]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  return useContext(PrefsContext);
}
