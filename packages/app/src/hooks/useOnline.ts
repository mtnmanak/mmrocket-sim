import { useEffect, useState } from 'react';

/**
 * Is the browser online, kept current by its `online`/`offline` events?
 *
 * `navigator.onLine` is a hint, not a promise — true can still mean a dead
 * hotspot — so a feature gates its BUTTON on this and still handles a failed
 * request. False, though, is reliable: nothing is going to answer.
 *
 * It lived in services/net.ts until 2026-10-01, beside the network helpers
 * the RockSim reader, the batch runner, the import planner, motorMatch and the
 * weather proposal reach through thrustcurve.ts or openMeteo.ts, so each of
 * them loaded React for a hook none of them calls — in the node corpus sweep and any worker too, where
 * nothing else needs it. launchConditions.test holds those services
 * React-free.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
