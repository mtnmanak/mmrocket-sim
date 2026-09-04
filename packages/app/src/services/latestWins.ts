/**
 * "Only the newest attempt may write" — a generation counter for asynchronous
 * work that ends in a state update.
 *
 * Opening a design is the case this exists for. It reads a file, loads the
 * preset catalogue, and does ONE thrustcurve.org fetch per motor with no
 * timeout, then writes twelve setters in a block that ends by stamping the
 * design as saved. Nothing sequenced those: at a launch site on a flaky
 * connection, opening the wrong file and immediately opening the right one
 * meant the RIGHT one (all built-ins, milliseconds) painted, and seconds later
 * the wrong one's fetch resolved and overwrote it — tree, motors,
 * configurations, launch conditions and all — while `markSaved` stamped ITS
 * fingerprint, so `dirty` was false and the next Open discarded the user's
 * work without the unsaved-changes prompt firing.
 *
 * Deliberately not an AbortController: nothing in the chain accepts a signal,
 * and cancelling a fetch mid-flight is not the requirement. The requirement is
 * that a superseded attempt writes nothing.
 */
export interface Sequencer {
  /** Claim the sequence. Call BEFORE the first await, and keep the id. */
  begin: () => number;
  /** Is this attempt still the newest? Check after every await, before writing. */
  isCurrent: (id: number) => boolean;
}

export function createSequencer(): Sequencer {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (id: number) => latest === id,
  };
}
