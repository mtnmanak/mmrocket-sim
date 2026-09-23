import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldAutoStartTour } from '../components/FirstRunTour.js';
import { hasSharePayload } from '../services/shareLink.js';
import { homeTab, type WorkspaceTab } from './useWorkspaceTab.js';

/**
 * THE FIRST-RUN TOUR: whether it is on screen, when it starts by itself, and
 * where it leaves the user.
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501 — the UI hooks of
 * extraction #8, 8 September). WHO gets the auto-start is
 * FirstRunTour.shouldAutoStartTour's rule, tested there; this is the state it
 * starts, the preference that stops it, and the landing, tested in
 * useFirstRunTour.test.tsx.
 */
export interface FirstRunTourState {
  open: boolean;
  /** The header's ⟲ Tour: replay it, whatever the preference says. */
  start: () => void;
  /** Close it and land on the device's home screen. */
  close: () => void;
}

export function useFirstRunTour(
  { tourOff, hasSession, setTab }: { tourOff: boolean; hasSession: boolean; setTab: (t: WorkspaceTab) => void },
): FirstRunTourState {
  const [open, setOpen] = useState(false);
  // First-run tour: decided once at startup (ref = StrictMode double-invoke
  // guard, same pattern as App's shareHandled). A share link suppresses it —
  // that visitor came for a design, don't stand in front of it.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    if (shouldAutoStartTour({
      tourOff,
      hasShare: hasSharePayload(window.location.hash),
      hasSession,
    })) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot startup decision
  }, []);
  // Turning the tour off WHILE IT IS ON SCREEN must dismiss it. The tour's
  // spotlight and scrim are both pointer-events:none, so the app stays fully
  // usable behind the card and opening Preferences mid-tour is the natural
  // thing to do — and until now the card just sat there, which is the literal
  // reading of "setting Tour Off doesn't work".
  //
  // Guarded on the false→true TRANSITION, not on the current value: a plain
  // `if (off) setOpen(false)` would make the header's ⟲ Tour replay button
  // dead for exactly the people who turned the auto-tour off.
  const prevOff = useRef(tourOff);
  useEffect(() => {
    if (tourOff && !prevOff.current) setOpen(false);
    prevOff.current = tourOff;
  }, [tourOff]);
  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    // The tour walks through tabs — land back on the device's home screen
    // (phones open on Fly, everything else on Design).
    setTab(homeTab());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setTab is stable
  }, []);
  return { open, start, close };
}
