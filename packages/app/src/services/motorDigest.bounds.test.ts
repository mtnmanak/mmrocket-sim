import { describe, expect, it, vi } from 'vitest';
import { digestMotorFile } from './motorDigest.js';

const rasp = (points: string[]) => 'X1 18 70 P 0.01 0.02 Home\n' + points.join('\n');

describe('E3 bounded motor digest work', () => {
  it('sorts descending samples without repeated adjacent swaps', () => {
    const text = rasp(Array.from({ length: 120 }, (_, i) => `${120 - i} ${i % 7}`));
    const iterator = Array.prototype[Symbol.iterator];
    let iterations = 0;
    // eslint-disable-next-line no-extend-native -- Count actual swap work; a vi iterator spy recurses into its own bookkeeping.
    Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, writable: true, value: function (this: unknown[]) {
      iterations++;
      return iterator.call(this);
    } });
    let result: string[];
    try { result = digestMotorFile(text); } finally {
      // eslint-disable-next-line no-extend-native -- Restore the iterator immediately after the counted operation.
      Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, writable: true, value: iterator });
    }
    expect(result!).toHaveLength(1);
    expect(iterations).toBeLessThan(1000);
  });

  it('compacts duplicate samples without one splice per duplicate', () => {
    const text = rasp(['0 0', ...Array.from({ length: 1000 }, () => '1 2'), '2 0']);
    const splice = vi.spyOn(Array.prototype, 'splice');
    let result: string[];
    let calls: number;
    try { result = digestMotorFile(text); calls = splice.mock.calls.length; } finally { splice.mockRestore(); }
    expect(result!).toEqual(digestMotorFile(rasp(['0 0', '1 2', '2 0'])));
    expect(calls!).toBeLessThan(10);
  });

  it.each(['<!--', '<![CDATA[', '<?'])('refuses unclosed %s instead of scanning each opener to the end', opener => {
    const valid = '<engine-database><engine-list><engine initWt="20" propWt="10"><data>'
      + '<eng-data t="0" f="0"/><eng-data t="1" f="1"/></data></engine></engine-list></engine-database>';
    expect(digestMotorFile(opener.repeat(1000) + valid, 'RockSim')).toEqual([]);
  });
});
