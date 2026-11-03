import type { RocketTree } from '@online-openrocket/engine';

/** Consume before starting asynchronous work, including a re-entrant render. */
export function takeMotorLinkOpen<T>(pending: { current: T | null }): T | null {
  const value = pending.current;
  pending.current = null;
  return value;
}

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

export function startedLinkResult<T extends LinkResultStamp>(started: boolean, stamp: T): T | null {
  return started ? stamp : null;
}

export interface PendingLinkStamp {
  gen: number;
  seq: number;
  tree: RocketTree;
  launch: object;
  activeConfigId: string | null;
  motorFlightKey: string | null;
}

/** The motor key is armed by the first committed assignment render. */
export function pendingLinkCurrent(stamp: PendingLinkStamp, live: PendingLinkStamp): boolean {
  return stamp.gen === live.gen && stamp.seq === live.seq && stamp.tree === live.tree
    && stamp.launch === live.launch && stamp.activeConfigId === live.activeConfigId
    && (stamp.motorFlightKey === null || stamp.motorFlightKey === live.motorFlightKey);
}
