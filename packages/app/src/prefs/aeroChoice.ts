import type { Preferences } from './preferences.js';

/*
 * THE AERO CHOICE, React-free (moved unchanged out of PrefsContext.tsx,
 * 2026-10-01). A run with no React mounted — services/simulateDesign.ts, a
 * script, a later API — reads the same mapping from a choice to the two
 * fields the kernel is driven by as the Preferences dialog and the vitals
 * strip do, so it cannot fly different physics for the same choice.
 * PrefsContext.tsx re-exports every binding here (aeroChoice.test.ts pins it).
 */

/**
 * The aero model as ONE five-way choice, which is how the UI has always shown
 * it: the two classic variants live in `aeroModel: 'classic'` and are told
 * apart only by `rogersKbf`, so `aeroMode` alone cannot see a switch between
 * Extended Barrowman and Rogers Kbf. Both the Preferences pulldown and the
 * vitals-strip switch speak this vocabulary, so they cannot drift.
 */
export type AeroChoice = 'eb' | 'kbf' | 'auto' | 'supersonic' | 'hybrid';

/**
 * Labels for the vitals strip.
 *
 * ONE NAME EVERYWHERE for the parity model (Eric, 2026-09-21). It used to
 * carry four — "OpenRocket — Extended Barrowman (exact desktop parity)" in
 * Preferences, "Extended Barrowman (desktop)" in batch, "Classic EB" here and
 * "Classic Extended Barrowman" in the guide — so a reader who met it in one
 * place could not tell it was the same setting in another. The parenthetical
 * that went with the longest of them is now hint text, because "exact desktop
 * parity" claimed more than can be shown.
 */
export const AERO_SHORT: Record<AeroChoice, string> = {
  kbf: 'Rogers Kbf',
  eb: 'Classic Extended Barrowman',
  auto: 'Auto',
  supersonic: 'Supersonic',
  hybrid: 'Hybrid (experimental)',
};

/** The stored preference as one choice. Folds in the pre-v0.026 boolean. */
export function aeroChoiceOf(prefs: Preferences): AeroChoice {
  const mode = prefs.aeroModel ?? (prefs.supersonicAero ? 'supersonic' : 'classic');
  if (mode !== 'classic') return mode;
  return (prefs.rogersKbf ?? true) ? 'kbf' : 'eb';
}

/**
 * The stored-preference pair a choice stands for — THE one mapping from the
 * five-way choice to the two fields the kernel is driven by (audit
 * 2026-09-22, row 499). Preferences writes it into the store, and
 * `effectiveAero` below flies an override through it, so the same choice made
 * from either control is the same physics. It used to be written out in both
 * places, kept in step by a comment.
 *
 * Kbf rides along under Auto and Supersonic too (it is the better subsonic
 * model, and Auto flies subsonic until Mach 0.9) — only 'eb' turns it off.
 * `aeroChoiceOf` is its inverse: aeroChoiceOf(prefsForAeroChoice(c)) === c.
 */
export function prefsForAeroChoice(choice: AeroChoice): {
  aeroModel: 'classic' | 'supersonic' | 'auto' | 'hybrid';
  rogersKbf: boolean;
} {
  return {
    aeroModel: choice === 'eb' || choice === 'kbf' ? 'classic' : choice,
    rogersKbf: choice !== 'eb',
  };
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
  aeroMode: 'classic' | 'supersonic' | 'auto' | 'hybrid';
  effectiveKbf: boolean;
} {
  if (override) {
    // Through the Preferences writer's own mapping, so the strip and the
    // dialog cannot fly different physics for the same choice.
    const { aeroModel, rogersKbf } = prefsForAeroChoice(override);
    return { aeroMode: aeroModel, effectiveKbf: rogersKbf };
  }
  return {
    aeroMode: prefs.aeroModel ?? (prefs.supersonicAero ? 'supersonic' : 'classic'),
    effectiveKbf: prefs.aeroModel === 'hybrid' || (prefs.rogersKbf ?? true),
  };
}
