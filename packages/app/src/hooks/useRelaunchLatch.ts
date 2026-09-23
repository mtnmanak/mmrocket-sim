import { useEffect, useState } from 'react';

/**
 * "Try Auto & re-fly" from the supersonic-flight alert: set the session's aero
 * override, then launch once the render that carries it has rebuilt the engine
 * handle with the new model. The click sets both in one batch, so the very next
 * render is the rebuilt one — `ready` there says whether a launch can happen.
 *
 * THE LATCH IS SPENT ON THAT RENDER EITHER WAY (audit 2026-09-22, the 8
 * September still-open list). It used to be cleared only on the path that
 * launched: when the rebuilt design had no handle (a build error) or no motor
 * to fly (the alert shows over a stored run, which can outlive its motor), the
 * request stayed armed — and fired a Launch nobody pressed the moment the
 * design next built with a motor loaded, minutes or edits later.
 */
export function useRelaunchLatch(ready: boolean, launch: () => void): () => void {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    setPending(false);
    if (ready) launch();
    // `launch` is a per-render closure over the state it flies; the latch and
    // readiness are the trigger, and it must fly the render that tripped it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [pending, ready]);
  return () => setPending(true);
}
