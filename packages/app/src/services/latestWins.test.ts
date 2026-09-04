import { describe, expect, it } from 'vitest';
import { createSequencer } from './latestWins.js';

describe('createSequencer — the newest attempt wins', () => {
  it('a lone attempt is current', () => {
    const seq = createSequencer();
    const a = seq.begin();
    expect(seq.isCurrent(a)).toBe(true);
  });

  it('starting a second attempt retires the first, whatever order they finish in', () => {
    const seq = createSequencer();
    const slow = seq.begin();
    const fast = seq.begin();
    // The fast one finishes first and is allowed to write.
    expect(seq.isCurrent(fast)).toBe(true);
    // The slow one resolves later and must NOT — this is the whole point: the
    // loser used to land last and overwrite the design on screen.
    expect(seq.isCurrent(slow)).toBe(false);
    // And the winner is still current afterwards.
    expect(seq.isCurrent(fast)).toBe(true);
  });

  it('checking does not advance the sequence', () => {
    const seq = createSequencer();
    const a = seq.begin();
    seq.isCurrent(a);
    seq.isCurrent(a);
    expect(seq.isCurrent(a)).toBe(true);
  });

  it('ids are never reused, so a stale id can never come back into force', () => {
    const seq = createSequencer();
    const ids = [seq.begin(), seq.begin(), seq.begin()];
    expect(new Set(ids).size).toBe(3);
    expect(ids.filter((id) => seq.isCurrent(id))).toEqual([ids[2]]);
  });

  it('two sequencers are independent', () => {
    const a = createSequencer();
    const b = createSequencer();
    const ida = a.begin();
    b.begin();
    b.begin();
    expect(a.isCurrent(ida)).toBe(true);
  });
});
