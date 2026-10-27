import { useLayoutEffect, useState, type RefObject } from 'react';
import { usePrefs } from './prefs/PrefsContext.js';
import { chartPalette } from './chartTheme.js';

/** The element whose CSS variables a chart reads: its own node once mounted, else the app root. */
function scope(ref?: RefObject<Element | null>): Element | null {
  return ref?.current ?? (typeof document === 'undefined' ? null : document.querySelector('.viz-root'));
}

/**
 * The chart series colours in slot order, READ FROM CSS (`--chart-<token>`),
 * kept current across theme and Daylight switches. uPlot and the legend
 * samples take concrete strings, so the variables are resolved here, once per
 * theme: the first render reads the app root (it is already mounted), and a
 * layout effect re-reads after every theme change, before paint — the root's
 * data-theme / data-contrast attributes are committed by then.
 */
export function useChartPalette(ref?: RefObject<Element | null>): string[] {
  const { resolvedTheme, daylight } = usePrefs();
  const [palette, setPalette] = useState(() => chartPalette(scope(ref)));
  useLayoutEffect(() => {
    const next = chartPalette(scope(ref));
    setPalette((prev) => (prev.length === next.length && prev.every((c, i) => c === next[i]) ? prev : next));
  }, [ref, resolvedTheme, daylight]);
  return palette;
}
