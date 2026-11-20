import { useRef } from 'react';

/** Shared handle ownership, including the synchronous hold before a flight paints. */
export function useFlightHandleHold(busy: boolean) {
  const hold = useRef(busy);
  hold.current = busy;
  return hold;
}
