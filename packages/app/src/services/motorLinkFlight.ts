export interface LinkResultStamp {
  gen: number;
  physicsKey: string;
  motorFlightKey: string;
  activeConfigId: string | null;
}

/** A result note describes exactly the flight that was started. */
export function linkResultCurrent(stamp: LinkResultStamp, live: LinkResultStamp): boolean {
  return stamp.gen === live.gen && stamp.physicsKey === live.physicsKey
    && stamp.motorFlightKey === live.motorFlightKey && stamp.activeConfigId === live.activeConfigId;
}
